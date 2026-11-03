import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgUrl: string;
  }
}

/**
 * With TEST_DB=postgres the suite runs against a real PostgreSQL server (multiple
 * concurrent connections, row locks), not just the embedded single-connection PGlite.
 */
export default async function setup(project: TestProject) {
  if (process.env.TEST_DB !== 'postgres') {
    project.provide('pgUrl', '');
    return;
  }
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = 54329;
  const databaseDir = path.join(os.tmpdir(), `tasksync-test-pg-${process.pid}`);
  const pg = new EmbeddedPostgres({ databaseDir, user: 'postgres', password: 'test-only', port, persistent: false, onLog: () => {} });
  await pg.initialise();
  await pg.start();
  project.provide('pgUrl', `postgres://postgres:test-only@127.0.0.1:${port}/postgres`);
  return async () => {
    if (process.platform === 'win32') {
      // embedded-postgres stops the postmaster with a signal, which on Windows can orphan
      // PostgreSQL 18 io_worker children. A pg_ctl "fast" shutdown stops the whole cluster.
      const { pg_ctl } = (await import('@embedded-postgres/windows-x64' as string)) as { pg_ctl: string };
      const { execFileSync } = await import('node:child_process');
      try {
        execFileSync(pg_ctl, ['stop', '-D', databaseDir, '-m', 'fast', '-w'], { stdio: 'ignore' });
      } catch {
        // already stopped
      }
    }
    await pg.stop().catch(() => undefined);
    await rm(databaseDir, { recursive: true, force: true }).catch(() => undefined);
  };
}
