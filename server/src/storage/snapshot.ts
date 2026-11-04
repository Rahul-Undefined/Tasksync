import type { Database, Queryable } from '../db/database.js';
import { latestEventId } from '../realtime/replay.js';

// Logical snapshot of TaskSync data as JSON (not a binary database image), so it stays small,
// readable after decryption, and loads into newer schema versions (new columns get defaults).

/** Parent tables before children so foreign keys are satisfied on import. */
export const SNAPSHOT_TABLES = [
  'users',
  'employee_profiles',
  'user_preferences',
  'admin_approvals',
  'tasks',
  'task_assignments',
  'task_comments',
  'task_activity',
  'notifications',
  'audit_log',
  'system_state',
] as const;

/** Tables whose ids come from identity sequences that must continue after a restore. */
const IDENTITY_TABLES = ['task_activity', 'audit_log'] as const;

export interface Snapshot {
  format: 'tasksync-snapshot';
  version: 1;
  createdAt: string;
  migrations: string[];
  /** Highest realtime event id handed out, so ids keep increasing across restarts. */
  realtimeSeq: number;
  tables: Record<string, Record<string, unknown>[]>;
}

export async function exportSnapshot(q: Queryable): Promise<Snapshot> {
  const tables: Snapshot['tables'] = {};
  for (const table of SNAPSHOT_TABLES) {
    const { rows } = await q.query<Record<string, unknown>>(`SELECT * FROM ${table}`);
    tables[table] = rows.map(normaliseRow);
  }
  const { rows: migrations } = await q.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id');
  return {
    format: 'tasksync-snapshot',
    version: 1,
    createdAt: new Date().toISOString(),
    migrations: migrations.map((m) => m.id),
    realtimeSeq: await latestEventId(q),
    tables,
  };
}

export function parseSnapshot(json: string): Snapshot {
  const s = JSON.parse(json) as Snapshot;
  if (s?.format !== 'tasksync-snapshot' || s.version !== 1 || typeof s.tables !== 'object') {
    throw new Error('Unrecognised snapshot format');
  }
  return s;
}

/** Plain JSON values: dates as ISO strings, big integers as numbers. */
function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? Number(v) : v;
  }
  return out;
}

async function tableColumns(q: Queryable, kind: Database['kind'], table: string): Promise<Set<string>> {
  const { rows } =
    kind === 'sqlite'
      ? await q.query<{ column_name: string }>(`SELECT name AS column_name FROM pragma_table_info('${table}')`)
      : await q.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
          [table],
        );
  return new Set(rows.map((r) => r.column_name));
}

/** JSON objects/arrays go in as text (works for PostgreSQL jsonb and SQLite TEXT alike). */
function bindValue(v: unknown): unknown {
  return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
}

/**
 * Replaces all TaskSync data with the snapshot, inside one transaction (all or nothing).
 * The schema must already be migrated to the current version. Works on PostgreSQL and SQLite.
 */
export async function importSnapshot(db: Database, snapshot: Snapshot): Promise<{ rows: number }> {
  const sqlite = db.kind === 'sqlite';
  return db.tx(async (q) => {
    // PostgreSQL checks foreign keys at the end of each statement; SQLite per row. Defer them to
    // commit so rows referring to rows later in the snapshot (users.approved_by) load fine.
    if (sqlite) await q.exec('PRAGMA defer_foreign_keys = ON');
    // Clear existing data, children first.
    await q.query('DELETE FROM realtime_events');
    for (const table of [...SNAPSHOT_TABLES].reverse()) await q.query(`DELETE FROM ${table}`);

    let total = 0;
    for (const table of SNAPSHOT_TABLES) {
      const rows = snapshot.tables[table] ?? [];
      if (rows.length === 0) continue;
      const existing = await tableColumns(q, db.kind, table);
      const present = new Set<string>();
      for (const row of rows) for (const key of Object.keys(row)) if (existing.has(key)) present.add(key);
      const cols = [...present];
      const colList = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');
      const values = cols.map((_, i) => `$${i + 1}`).join(', ');
      const sql = `INSERT INTO ${table} (${colList}) ${sqlite ? '' : 'OVERRIDING SYSTEM VALUE'} VALUES (${values})`;
      for (const row of rows) await q.query(sql, cols.map((c) => bindValue(row[c] ?? null)));
      total += rows.length;
    }

    const realtimeSeq = Math.max(0, Math.floor(snapshot.realtimeSeq ?? 0));
    if (sqlite) {
      // AUTOINCREMENT already continues after explicitly inserted ids; carry the event cursor over.
      await q.query(
        `INSERT INTO sqlite_sequence (name, seq) SELECT 'realtime_events', $1
         WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'realtime_events')`,
        [realtimeSeq],
      );
      await q.query(`UPDATE sqlite_sequence SET seq = max(seq, $1) WHERE name = 'realtime_events'`, [realtimeSeq]);
    } else {
      for (const table of IDENTITY_TABLES) {
        await q.query(
          `SELECT setval(pg_get_serial_sequence('${table}', 'id'), coalesce((SELECT max(id) FROM ${table}), 0) + 1, false)`,
        );
      }
      await q.query(`SELECT setval(pg_get_serial_sequence('realtime_events', 'id'), $1::bigint + 1, false)`, [realtimeSeq]);
    }
    return { rows: total };
  });
}
