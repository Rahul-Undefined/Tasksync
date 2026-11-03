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
    const { rows } = await q.query<{ rows: unknown }>(`SELECT coalesce(json_agg(t), '[]'::json) AS rows FROM ${table} t`);
    const value = rows[0]?.rows;
    tables[table] = (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>[];
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

async function tableColumns(q: Queryable, table: string): Promise<Set<string>> {
  const { rows } = await q.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}

/**
 * Replaces all TaskSync data with the snapshot, inside one transaction (all or nothing).
 * The schema must already be migrated to the current version.
 */
export async function importSnapshot(db: Database, snapshot: Snapshot): Promise<{ rows: number }> {
  return db.tx(async (q) => {
    // Clear existing data, children first.
    await q.query('DELETE FROM realtime_events');
    for (const table of [...SNAPSHOT_TABLES].reverse()) await q.query(`DELETE FROM ${table}`);

    let total = 0;
    for (const table of SNAPSHOT_TABLES) {
      const rows = snapshot.tables[table] ?? [];
      if (rows.length === 0) continue;
      const existing = await tableColumns(q, table);
      const present = new Set<string>();
      for (const row of rows) for (const key of Object.keys(row)) if (existing.has(key)) present.add(key);
      const cols = [...present].map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');
      await q.query(
        `INSERT INTO ${table} (${cols}) OVERRIDING SYSTEM VALUE
         SELECT ${cols} FROM json_populate_recordset(null::${table}, $1::json)`,
        [JSON.stringify(rows)],
      );
      total += rows.length;
    }

    for (const table of IDENTITY_TABLES) {
      await q.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), coalesce((SELECT max(id) FROM ${table}), 0) + 1, false)`,
      );
    }
    await q.query(`SELECT setval(pg_get_serial_sequence('realtime_events', 'id'), $1::bigint + 1, false)`, [
      Math.max(0, Math.floor(snapshot.realtimeSeq ?? 0)),
    ]);
    return { rows: total };
  });
}
