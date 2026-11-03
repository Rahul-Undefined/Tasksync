import type { Database, QueryResult, Tx } from '../db/database.js';
import { openSnapshot, sealSnapshot } from './crypto.js';
import type { SnapshotStore } from './github.js';
import { exportSnapshot, importSnapshot, parseSnapshot } from './snapshot.js';

export interface PersistenceStatus {
  mode: 'github';
  target: string;
  state: 'loading' | 'ready' | 'error';
  pendingChanges: boolean;
  lastSavedAt: string | null;
  lastLoadedAt: string | null;
  lastError: string | null;
}

interface Options {
  /** Wait this long after the last change before saving (batches bursts of writes). */
  debounceMs?: number;
  /** Never wait longer than this after the first unsaved change. */
  maxDelayMs?: number;
  /** After start-up, how long to watch for a newer snapshot written by the previous instance (deploy overlap). */
  watchWindowMs?: number;
  watchIntervalMs?: number;
  log?: (msg: string) => void;
}

/**
 * Keeps the in-memory database durable by saving encrypted snapshots to a SnapshotStore.
 *
 * Safety rules:
 *  - Nothing is served (state stays "loading"/"error") until the stored snapshot has been loaded.
 *    A store that can't be read never leads to an empty database overwriting real data.
 *  - Saves happen a few seconds after changes, on a timer, and on shutdown (flush).
 */
export class Persistence {
  private state: PersistenceStatus['state'] = 'loading';
  private dirty = false;
  private writes = 0;
  private savedWrites = 0;
  private version: string | null = null;
  private lastSavedAt: Date | null = null;
  private lastLoadedAt: Date | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | undefined;
  private firstDirtyAt = 0;
  private saving: Promise<void> | null = null;
  private stopped = false;
  private readonly opts: Required<Options>;

  constructor(
    private readonly db: Database,
    private readonly store: SnapshotStore,
    private readonly secret: string,
    opts: Options = {},
  ) {
    this.opts = {
      debounceMs: opts.debounceMs ?? 3000,
      maxDelayMs: opts.maxDelayMs ?? 15_000,
      watchWindowMs: opts.watchWindowMs ?? 3 * 60_000,
      watchIntervalMs: opts.watchIntervalMs ?? 10_000,
      log: opts.log ?? ((m) => console.log(`[storage] ${m}`)),
    };
  }

  get ready() {
    return this.state === 'ready';
  }

  status(): PersistenceStatus {
    return {
      mode: 'github',
      target: this.store.describe(),
      state: this.state,
      pendingChanges: this.dirty,
      lastSavedAt: this.lastSavedAt?.toISOString() ?? null,
      lastLoadedAt: this.lastLoadedAt?.toISOString() ?? null,
      lastError: this.lastError,
    };
  }

  /** Loads the stored snapshot, retrying until it succeeds. Resolves once TaskSync can serve requests. */
  async start(): Promise<void> {
    for (let attempt = 1; !this.stopped; attempt++) {
      try {
        await this.loadFromStore();
        this.state = 'ready';
        this.lastError = null;
        this.watchForNewerSnapshot();
        return;
      } catch (err) {
        this.state = 'error';
        this.lastError = err instanceof Error ? err.message : String(err);
        this.opts.log(`load failed (attempt ${attempt}): ${this.lastError}`);
        await sleep(Math.min(60_000, 2000 * 2 ** Math.min(attempt, 5)));
      }
    }
  }

  private async loadFromStore(): Promise<void> {
    const stored = await this.store.load();
    if (stored) {
      const snapshot = parseSnapshot(openSnapshot(stored.data, this.secret));
      const { rows } = await importSnapshot(this.db, snapshot);
      this.opts.log(`loaded snapshot ${stored.version.slice(0, 7)} from ${this.store.describe()} (${rows} rows, taken ${snapshot.createdAt})`);
    } else {
      this.opts.log(`no snapshot in ${this.store.describe()} yet: starting with an empty database`);
    }
    this.version = stored?.version ?? null;
    this.lastLoadedAt = new Date();
    this.savedWrites = this.writes;
    this.dirty = false;
  }

  /**
   * During a deploy the old instance keeps serving until the new one is healthy, then saves on
   * shutdown. If that happens before this instance changed anything, load the newer snapshot.
   */
  private watchForNewerSnapshot() {
    const until = Date.now() + this.opts.watchWindowMs;
    const tick = async () => {
      if (this.stopped || Date.now() > until) return;
      try {
        const head = await this.store.head();
        if (head && head !== this.version && !this.dirty && this.writes === this.savedWrites && !this.saving) {
          this.opts.log('a newer snapshot appeared (previous instance shut down): reloading');
          await this.loadFromStore();
        }
      } catch {
        // transient: try again on the next tick
      }
      setTimeout(tick, this.opts.watchIntervalMs).unref();
    };
    setTimeout(tick, this.opts.watchIntervalMs).unref();
  }

  /** Called for every data-changing statement. */
  markDirty() {
    if (this.state !== 'ready') return;
    this.writes++;
    if (!this.dirty) {
      this.dirty = true;
      this.firstDirtyAt = Date.now();
    }
    this.schedule(this.opts.debounceMs);
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(delay, this.firstDirtyAt + this.opts.maxDelayMs - Date.now()));
    this.timer = setTimeout(() => void this.flush().catch(() => undefined), wait);
    this.timer.unref();
  }

  /** Saves now if there are unsaved changes. Safe to call concurrently. */
  async flush(): Promise<void> {
    if (this.saving) {
      await this.saving;
      if (!this.dirty) return;
    }
    if (!this.dirty || this.state !== 'ready') return;
    this.saving = this.saveOnce().finally(() => (this.saving = null));
    return this.saving;
  }

  private async saveOnce(): Promise<void> {
    const writesAtStart = this.writes;
    try {
      const snapshot = await exportSnapshot(this.db);
      const sealed = sealSnapshot(JSON.stringify(snapshot), this.secret);
      const head = await this.store.head();
      if (this.version && head && head !== this.version) {
        this.opts.log(`warning: stored snapshot changed by another writer (${head.slice(0, 7)}); overwriting with this instance's data`);
      }
      this.version = await this.store.save(sealed);
      this.lastSavedAt = new Date();
      this.lastError = null;
      this.savedWrites = writesAtStart;
      if (this.writes === writesAtStart) this.dirty = false;
      else this.schedule(this.opts.debounceMs); // more changes arrived while saving
    } catch (err) {
      this.lastError = `save failed: ${err instanceof Error ? err.message : String(err)}`;
      this.opts.log(this.lastError);
      this.schedule(15_000); // keep trying; data stays in memory meanwhile
      throw err;
    }
  }

  async stop(): Promise<void> {
    await this.flush().catch(() => undefined);
    this.stopped = true;
    clearTimeout(this.timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());

/** Treats anything other than a plain SELECT as a change. */
export function isWrite(sql: string): boolean {
  return !/^\s*select\b/i.test(sql);
}

/**
 * Wraps a database so data-changing statements notify `onWrite` once they are committed
 * (single statements after they run, transactions only after a successful commit).
 */
export function trackWrites(db: Database, onWrite: () => void): Database {
  return {
    kind: db.kind,
    async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      const res = await db.query<T>(sql, params);
      if (isWrite(sql)) onWrite();
      return res;
    },
    async exec(sql: string) {
      await db.exec(sql);
      onWrite();
    },
    async tx<T>(fn: (q: Tx) => Promise<T>): Promise<T> {
      let wrote = false;
      const result = await db.tx((q) =>
        fn({
          query<R>(sql: string, params?: unknown[]) {
            if (isWrite(sql)) wrote = true;
            return q.query<R>(sql, params);
          },
          exec(sql: string) {
            wrote = true;
            return q.exec(sql);
          },
        }),
      );
      if (wrote) onWrite();
      return result;
    },
    withLock: (key, fn) => db.withLock(key, fn),
    ping: () => db.ping(),
    close: () => db.close(),
  };
}
