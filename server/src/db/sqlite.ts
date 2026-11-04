import { randomUUID } from 'node:crypto';
import type { Database, QueryResult, Tx } from './database.js';

// SQLite (built into Node, a few MB of memory) for the GitHub-storage mode on small hosts such as
// Render Free (512 MB), where an embedded PostgreSQL doesn't fit. The app's SQL is written for
// PostgreSQL; this adapter translates the handful of PostgreSQL-only forms it uses.

type SqliteValue = null | number | bigint | string | Uint8Array;

/** Rewrites the PostgreSQL syntax used by TaskSync's queries into SQLite syntax. */
export function translateSql(sql: string): string {
  return sql
    .replace(/\$(\d+)/g, '?$1') // numbered parameters
    .replace(/::(?:uuid|text|int|integer|bigint|boolean|jsonb?|timestamptz)(?:\[\])?/gi, '') // casts
    .replace(/=\s*ANY\(\s*(\?\d+)\s*\)/gi, 'IN (SELECT value FROM json_each($1))') // array membership
    .replace(/\s+FOR\s+UPDATE\b/gi, '') // SQLite serialises writers anyway
    .replace(/\bOVERRIDING\s+SYSTEM\s+VALUE\b/gi, '');
}

function toSqlite(v: unknown): SqliteValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') return v;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v); // arrays (for json_each) and JSON objects
}

/** Gives SQLite constraint errors the PostgreSQL SQLSTATE codes the services check for. */
function withPgCode(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const msg = err.message;
  const code = /UNIQUE constraint failed/i.test(msg)
    ? '23505'
    : /FOREIGN KEY constraint failed/i.test(msg)
      ? '23503'
      : /CHECK constraint failed/i.test(msg)
        ? '23514'
        : /NOT NULL constraint failed/i.test(msg)
          ? '23502'
          : undefined;
  if (code) Object.assign(err, { code });
  return err;
}

const RETURNS_ROWS = /^\s*(select|with|pragma|values)\b|\breturning\b/i;

export async function createSqliteDatabase(path = ':memory:'): Promise<Database> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  db.function('gen_random_uuid', { deterministic: false }, () => randomUUID());
  db.function('now', { deterministic: false }, () => new Date().toISOString());
  db.function('char_length', { deterministic: true }, (s: unknown) => (s == null ? null : String(s).length));
  db.function('btrim', { deterministic: true }, (s: unknown) => (s == null ? null : String(s).trim()));
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;');

  const run = <T>(sql: string, params: unknown[] = []): QueryResult<T> => {
    try {
      return runRaw<T>(sql, params);
    } catch (err) {
      throw withPgCode(err);
    }
  };
  const runRaw = <T>(sql: string, params: unknown[]): QueryResult<T> => {
    const stmt = db.prepare(translateSql(sql));
    const args = params.map(toSqlite);
    if (RETURNS_ROWS.test(sql)) {
      const rows = stmt.all(...args) as T[];
      return { rows, rowCount: rows.length };
    }
    const res = stmt.run(...args);
    return { rows: [], rowCount: Number(res.changes) };
  };

  // One connection: everything (including whole transactions with awaits inside) runs in order.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  const handle: Tx = {
    async query<T>(sql: string, params?: unknown[]) {
      return run<T>(sql, params);
    },
    async exec(sql: string) {
      db.exec(translateSql(sql));
    },
  };

  return {
    kind: 'sqlite',
    query: (sql, params) => serial(() => run(sql, params)),
    exec: (sql) => serial(() => void db.exec(translateSql(sql))),
    tx: (fn) =>
      serial(async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(handle);
          db.exec('COMMIT');
          return result;
        } catch (err) {
          if (db.isTransaction) db.exec('ROLLBACK');
          throw err;
        }
      }),
    withLock: (_key, fn) => fn(),
    async ping() {
      await serial(() => run('SELECT 1'));
    },
    async close() {
      await serial(() => db.close());
    },
  };
}
