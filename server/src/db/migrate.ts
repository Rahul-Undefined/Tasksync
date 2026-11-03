import type { Database } from './database.js';
import { migrations } from './migrations.js';

const MIGRATION_LOCK_KEY = 74_221_001;

/**
 * Re-applied after every migration run so tables added later are locked down too
 * (Supabase grants anon/authenticated access to new public tables by default).
 */
const LOCKDOWN_SQL = /* sql */ `
DO $$
DECLARE
  t record;
  r text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t.tablename, r);
      END IF;
    END LOOP;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
    END IF;
  END LOOP;
END
$$;
`;

export async function runMigrations(db: Database, log: (msg: string) => void = () => undefined): Promise<string[]> {
  return db.withLock(MIGRATION_LOCK_KEY, async () => {
    await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await db.query<{ id: string }>('SELECT id FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.id));
    const ran: string[] = [];
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      log(`applying migration ${m.id}`);
      await db.tx(async (q) => {
        await q.exec(m.sql);
        await q.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
      });
      ran.push(m.id);
    }
    await db.exec(LOCKDOWN_SQL);
    return ran;
  });
}
