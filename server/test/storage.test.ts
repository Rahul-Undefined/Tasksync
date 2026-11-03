import { afterEach, describe, expect, it } from 'vitest';
import { openSnapshot, sealSnapshot, SnapshotDecryptError } from '../src/storage/crypto.js';
import { GitHubSnapshotStore, type SnapshotStore } from '../src/storage/github.js';
import { exportSnapshot, importSnapshot } from '../src/storage/snapshot.js';
import { createPgliteDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrate.js';
import { latestEventId } from '../src/realtime/replay.js';
import { loadConfig } from '../src/config.js';
import { startFakeGitHub, type FakeGitHub } from './fake-github.js';
import { createTestEnv, type TestEnv } from './helpers.js';

const KEY = 'correct horse battery staple — test only';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fakeGitHub() {
  const gh = await startFakeGitHub();
  cleanups.push(() => gh.close());
  return gh;
}
const storeFor = (gh: FakeGitHub, token = gh.token) =>
  new GitHubSnapshotStore({ repo: gh.repo, token, apiUrl: gh.apiUrl });

async function envWith(store: SnapshotStore): Promise<TestEnv> {
  const env = await createTestEnv({}, { store, key: KEY });
  cleanups.push(() => env.close());
  return env;
}

describe('Snapshot encryption', () => {
  it('round-trips, and rejects a wrong key or a tampered file', () => {
    const sealed = sealSnapshot('{"hello":"world"}', KEY);
    expect(sealed.subarray(0, 4).toString()).toBe('TSS1');
    expect(sealed.toString('utf8')).not.toContain('hello'); // ciphertext only
    expect(openSnapshot(sealed, KEY)).toBe('{"hello":"world"}');
    expect(() => openSnapshot(sealed, 'a different key of enough length')).toThrow(SnapshotDecryptError);
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1]! ^= 0xff;
    expect(() => openSnapshot(tampered, KEY)).toThrow(SnapshotDecryptError);
    expect(() => openSnapshot(Buffer.from('plain text'), KEY)).toThrow(SnapshotDecryptError);
  });
});

describe('Snapshot export/import', () => {
  it('restores every table exactly and keeps id sequences increasing', async () => {
    const env = await createTestEnv();
    cleanups.push(() => env.close());
    const rahul = await env.user('Rahul Snap');
    const stella = await env.user('Stella Snap');
    const t = (await env.req('POST', '/api/tasks', rahul.token, { title: 'Survives a restart', assigneeIds: [stella.id], priority: 'high' })).body.task;
    await env.req('POST', `/api/tasks/${t.id}/comments`, stella.token, { body: 'On it' });
    await env.req('POST', `/api/tasks/${t.id}/status`, stella.token, { status: 'completed' });
    const before = await env.req('GET', `/api/tasks/${t.id}`, rahul.token);
    const snapshot = await exportSnapshot(env.db);
    const seq = await latestEventId(env.db);

    const fresh = await createPgliteDatabase('memory');
    cleanups.push(() => fresh.close());
    await runMigrations(fresh);
    await importSnapshot(fresh, JSON.parse(JSON.stringify(snapshot)));
    for (const table of Object.keys(snapshot.tables)) {
      const { rows } = await fresh.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0]!.n, table).toBe(snapshot.tables[table]!.length);
    }
    const { rows: task } = await fresh.query<{ status: string; completed_by: string }>('SELECT status, completed_by FROM tasks WHERE id = $1', [t.id]);
    expect(task[0]).toMatchObject({ status: 'completed', completed_by: stella.id });
    // identity sequences continue after the highest restored id
    const maxActivity = Math.max(...snapshot.tables.task_activity!.map((r) => Number(r.id)));
    const { rows: ins } = await fresh.query<{ id: number }>(
      `INSERT INTO task_activity (task_id, actor_id, type) VALUES ($1, $2, 'commented') RETURNING id`,
      [t.id, rahul.id],
    );
    expect(Number(ins[0]!.id)).toBeGreaterThan(maxActivity);
    const { rows: ev } = await fresh.query<{ id: number }>(
      `INSERT INTO realtime_events (user_id, type, payload) VALUES ($1, 'task.upsert', '{}') RETURNING id`,
      [rahul.id],
    );
    expect(Number(ev[0]!.id)).toBeGreaterThan(seq);
    expect(before.body.activity.length).toBeGreaterThan(3);
  });
});

describe('GitHub snapshot store', () => {
  it('initialises an empty repo, saves, loads, keeps 7 daily backups and no history growth', async () => {
    const gh = await fakeGitHub();
    const store = storeFor(gh);
    expect(await store.load()).toBeNull(); // empty repository = first run
    for (let day = 1; day <= 9; day++) {
      await store.save(Buffer.from(`snapshot of day ${day}`), new Date(Date.UTC(2026, 10, day, 12)));
    }
    const loaded = await store.load();
    expect(loaded!.data.toString()).toBe('snapshot of day 9');
    const files = Object.keys(gh.files()).sort();
    expect(files.filter((f) => f.startsWith('backups/'))).toEqual(
      ['03', '04', '05', '06', '07', '08', '09'].map((d) => `backups/2026-11-${d}.bin`),
    );
    expect(files).toContain('README.md');
    expect(gh.parentsOfHead()).toEqual([]); // each save is a fresh parentless commit
  });

  it('reports a clear error for a bad token instead of looking empty', async () => {
    const gh = await fakeGitHub();
    await expect(storeFor(gh, 'wrong-token').load()).rejects.toThrow(/GITHUB_DATA_TOKEN/);
  });
});

describe('TaskSync with GitHub storage', () => {
  it('saves changes automatically and restores them on the next start (Render restart)', async () => {
    const gh = await fakeGitHub();
    const a = await envWith(storeFor(gh));
    const rahul = await a.user('Rahul Persist');
    const stella = await a.user('Stella Persist');
    const task = (await a.req('POST', '/api/tasks', rahul.token, { title: 'Persisted to GitHub', assigneeIds: [stella.id] })).body.task;
    await a.persistence!.flush();
    expect(a.persistence!.status()).toMatchObject({ state: 'ready', pendingChanges: false, lastError: null });
    expect(gh.files()['tasksync-snapshot.bin']).toBeTruthy();
    await a.close();
    cleanups.splice(cleanups.indexOf(cleanups.at(-1)!), 1);

    // a brand-new instance with an empty in-memory database
    const b = await envWith(storeFor(gh));
    const stellaAgain = await b.mint(stella.email, { name: stella.name });
    const mine = await b.req('GET', '/api/tasks?view=my', stellaAgain);
    expect(mine.status).toBe(200);
    expect(mine.body.tasks.map((t: { id: string }) => t.id)).toContain(task.id);
    const me = await b.req('GET', '/api/me', stellaAgain);
    expect(me.body.user.status).toBe('approved'); // approvals survive too
  });

  it('never serves or overwrites data when the stored snapshot cannot be read', async () => {
    const gh = await fakeGitHub();
    const seed = await envWith(storeFor(gh));
    await seed.user('Real Data');
    await seed.persistence!.flush();
    const writesAfterSeed = gh.writes();

    gh.failWith(500); // GitHub outage while a new instance starts
    const config = loadConfig({ NODE_ENV: 'test', WEB_DIST_DIR: './nope' });
    void config;
    const { Persistence, trackWrites } = await import('../src/storage/persistence.js');
    const { buildApp } = await import('../src/app.js');
    const raw = await createPgliteDatabase('memory');
    await runMigrations(raw);
    const p = new Persistence(raw, storeFor(gh), KEY, { log: () => {} });
    const startPromise = p.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(p.status().state).toBe('error');
    const { app } = await buildApp({
      config: loadConfig({ NODE_ENV: 'test', WEB_DIST_DIR: './nope', ENTRA_TENANT_ID: '7a3b0c1d-2e4f-4a5b-8c6d-1e2f3a4b5c6d', ENTRA_CLIENT_ID: '0f1e2d3c-4b5a-4968-8776-655443322110' }),
      db: trackWrites(raw, () => p.markDirty()),
      persistence: p,
    });
    const res = await app.inject({ url: '/api/tasks', headers: { authorization: 'Bearer x' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('storage_unavailable');
    p.markDirty();
    await p.flush();
    expect(gh.writes()).toBe(writesAfterSeed); // nothing written while not loaded

    gh.failWith(0); // GitHub is back: the instance loads the real data
    await startPromise;
    expect(p.status().state).toBe('ready');
    const { rows } = await raw.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
    expect(rows[0]!.n).toBeGreaterThan(0);
    await p.stop();
    await app.close();
    await raw.close();
  }, 30_000);

  it('keeps changes in memory and retries when saving fails, then saves on shutdown', async () => {
    const gh = await fakeGitHub();
    const env = await envWith(storeFor(gh));
    gh.failWith(502);
    await env.user('Saved Later');
    await expect(env.persistence!.flush()).rejects.toThrow();
    expect(env.persistence!.status()).toMatchObject({ pendingChanges: true });
    expect(env.persistence!.status().lastError).toMatch(/save failed/);
    gh.failWith(0);
    await env.persistence!.stop(); // what SIGTERM does
    expect(env.persistence!.status()).toMatchObject({ pendingChanges: false, lastError: null });
  });
});

describe('GitHub storage configuration', () => {
  it('derives the data repository from Render and insists on an encryption key', () => {
    const ok = loadConfig({ GITHUB_DATA_TOKEN: 't', RENDER_GIT_REPO_SLUG: 'Rahul-Undefined/Tasksync', DATA_ENCRYPTION_KEY: 'x'.repeat(16) });
    expect(ok.storage).toMatchObject({ mode: 'github', github: { repo: 'Rahul-Undefined/tasksync-data', branch: 'main' } });
    const noKey = loadConfig({ GITHUB_DATA_TOKEN: 't', GITHUB_DATA_REPO: 'a/b' });
    expect(noKey.storage.github).toBeUndefined();
    expect(noKey.storage.problem).toMatch(/DATA_ENCRYPTION_KEY/);
    expect(loadConfig({ GITHUB_DATA_TOKEN: 't', DATA_ENCRYPTION_KEY: 'x'.repeat(16) }).storage.problem).toMatch(/GITHUB_DATA_REPO/);
    expect(loadConfig({ DATABASE_URL: 'postgresql://x', GITHUB_DATA_TOKEN: 't' }).storage.mode).toBe('postgres');
    // allowed in production (unlike a local PGlite directory)
    expect(loadConfig({ NODE_ENV: 'production', GITHUB_DATA_TOKEN: 't', GITHUB_DATA_REPO: 'a/b', DATA_ENCRYPTION_KEY: 'x'.repeat(16) }).storage.mode).toBe('github');
  });
});
