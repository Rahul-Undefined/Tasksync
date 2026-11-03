import { mkdirSync } from 'node:fs';
import pg from 'pg';
import { isSupabaseHost, SUPABASE_ROOT_CA_2021 } from './supabase-ca.js';
import type { AppConfig } from '../config.js';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Tx extends Queryable {
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  readonly kind: 'postgres' | 'pglite';
  /** Runs a multi-statement SQL script (used by migrations). */
  exec(sql: string): Promise<void>;
  /** Runs `fn` inside a transaction. The transaction is rolled back if `fn` throws. */
  tx<T>(fn: (q: Tx) => Promise<T>): Promise<T>;
  /** Runs `fn` while holding a database-wide advisory lock (single-runner jobs such as migrations). */
  withLock<T>(key: number, fn: () => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// node-postgres (production: Supabase PostgreSQL)
// ---------------------------------------------------------------------------

/**
 * TLS options for the database connection. With ssl=require the server certificate is always
 * verified: against DATABASE_CA_CERT if given, Supabase's public root CA for Supabase hosts,
 * or the system trust store otherwise.
 */
export function sslOptions(config: Pick<AppConfig['database'], 'url' | 'ssl' | 'caCert'>): pg.ClientConfig['ssl'] {
  if (config.ssl === 'disable') return false;
  if (config.ssl === 'no-verify') return { rejectUnauthorized: false };
  let host = '';
  try {
    host = new URL(config.url ?? '').hostname;
  } catch {
    // unparsable URL: pg reports the problem when connecting
  }
  const ca = config.caCert ?? (isSupabaseHost(host) ? SUPABASE_ROOT_CA_2021 : undefined);
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}

export function createPostgresDatabase(config: AppConfig['database']): Database {
  if (!config.url) throw new Error('DATABASE_URL is not set');
  const ssl = sslOptions(config);
  const pool = new pg.Pool({
    connectionString: stripSslParams(config.url),
    ssl,
    max: config.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    application_name: 'tasksync-api',
  });
  // An idle client erroring (e.g. the pooler restarting) must not crash the process.
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));

  const wrap = (client: pg.PoolClient | pg.Pool): Tx => ({
    async query<T>(sql: string, params?: unknown[]) {
      const res = await client.query(sql, params as unknown[] | undefined);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  });

  return {
    kind: 'postgres',
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async withLock(key, fn) {
      const client = await pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock($1)', [key]);
        try {
          return await fn();
        } finally {
          await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => undefined);
        }
      } finally {
        client.release();
      }
    },
    async ping() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}

/** `sslmode` in the URL would override the explicit ssl option, so we strip it and rely on DATABASE_SSL. */
function stripSslParams(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('ssl');
    return u.toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// PGlite (local development and automated tests: real PostgreSQL compiled to WASM)
// ---------------------------------------------------------------------------

export async function createPgliteDatabase(dataDir?: string): Promise<Database> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir && dataDir !== 'memory') mkdirSync(dataDir, { recursive: true });
  const db = dataDir && dataDir !== 'memory' ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;

  // PGlite is a single connection, so transactions must be serialised explicitly.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const direct: Queryable = {
    async query<T>(sql: string, params?: unknown[]) {
      const res = await db.query<T>(sql, params as unknown[] | undefined);
      return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
    },
  };

  return {
    kind: 'pglite',
    query: (sql, params) => serial(() => direct.query(sql, params)),
    exec: (sql) => serial(async () => void (await db.exec(sql))),
    tx: (fn) =>
      serial(() =>
        db.transaction(async (t) =>
          fn({
            async query<T>(sql: string, params?: unknown[]) {
              const res = await t.query<T>(sql, params as unknown[] | undefined);
              return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
            },
            async exec(sql: string) {
              await t.exec(sql);
            },
          }),
        ),
      ),
    withLock: (_key, fn) => fn(),
    async ping() {
      await serial(() => db.query('SELECT 1'));
    },
    async close() {
      await db.close();
    },
  };
}

export async function createDatabase(config: AppConfig): Promise<Database | null> {
  if (config.database.url) return createPostgresDatabase(config.database);
  // GitHub storage: the live database is in memory; Persistence restores and saves it.
  if (config.storage.mode === 'github') return config.storage.github ? createPgliteDatabase('memory') : null;
  if (config.env !== 'production' && config.database.pgliteDir) {
    return createPgliteDatabase(config.database.pgliteDir);
  }
  return null;
}
