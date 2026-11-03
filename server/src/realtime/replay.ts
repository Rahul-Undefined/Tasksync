import type { RealtimeEvent, RealtimeEventType } from '@tasksync/shared';
import type { Database, Queryable } from '../db/database.js';
import { iso } from '../lib/time.js';

const PRUNE_KEY = 'realtime_pruned_through';
export const MAX_REPLAY = 500;

export interface ReplayResult {
  events: RealtimeEvent[];
  lastEventId: number;
  /** True when the client missed too much (or events were pruned) and must refetch everything. */
  resync: boolean;
}

export async function latestEventId(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ id: string | number | null }>('SELECT max(id) AS id FROM realtime_events');
  return Number(rows[0]?.id ?? 0);
}

async function prunedThrough(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ value: { id?: number } | string }>('SELECT value FROM system_state WHERE key = $1', [
    PRUNE_KEY,
  ]);
  const v = rows[0]?.value;
  const parsed = typeof v === 'string' ? (JSON.parse(v) as { id?: number }) : v;
  return Number(parsed?.id ?? 0);
}

/**
 * Returns events for `userId` newer than `since`. A cursor of 0 means "fresh client":
 * nothing is replayed (the client loads current state over REST) and the current cursor is returned.
 */
export async function readEventsSince(q: Queryable, userId: string, since: number): Promise<ReplayResult> {
  const latest = await latestEventId(q);
  if (since <= 0) return { events: [], lastEventId: latest, resync: false };
  if (since > latest) return { events: [], lastEventId: latest, resync: true }; // cursor from another database
  if (since < (await prunedThrough(q))) return { events: [], lastEventId: latest, resync: true };

  const { rows } = await q.query<{
    id: string | number;
    type: RealtimeEventType;
    task_id: string | null;
    payload: unknown;
    created_at: Date | string;
  }>(
    `SELECT id, type, task_id, payload, created_at FROM realtime_events
     WHERE user_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
    [userId, since, MAX_REPLAY + 1],
  );
  if (rows.length > MAX_REPLAY) return { events: [], lastEventId: latest, resync: true };
  const events = rows.map((r) => ({
    id: Number(r.id),
    type: r.type,
    taskId: r.task_id,
    data: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
    createdAt: iso(r.created_at),
  }));
  return { events, lastEventId: Math.max(latest, events.at(-1)?.id ?? 0), resync: false };
}

/** Deletes delivered events older than the retention window and records the prune horizon. */
export async function pruneEvents(db: Database, retentionHours: number): Promise<number> {
  return db.withLock(74_221_002, async () => {
    const { rows } = await db.query<{ id: string | number | null }>(
      `SELECT max(id) AS id FROM realtime_events WHERE created_at < now() - make_interval(hours => $1)`,
      [retentionHours],
    );
    const cutoff = Number(rows[0]?.id ?? 0);
    if (!cutoff) return 0;
    return db.tx(async (q) => {
      const { rowCount } = await q.query('DELETE FROM realtime_events WHERE id <= $1', [cutoff]);
      await q.query(
        `INSERT INTO system_state (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [PRUNE_KEY, JSON.stringify({ id: cutoff })],
      );
      return rowCount;
    });
  });
}
