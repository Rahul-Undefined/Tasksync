import { existsSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig, isEntraConfigured } from './config.js';
import { createDatabase } from './db/database.js';
import { runMigrations } from './db/migrate.js';

async function main() {
  // Local convenience: load ./.env when present (hosted environments set real env vars).
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  const logger =
    config.env === 'development'
      ? { level: config.logLevel, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
      : { level: config.logLevel, redact: ['req.headers.authorization'] };

  const db = await createDatabase(config);
  if (db) {
    const applied = await runMigrations(db, (m) => console.log(`[migrate] ${m}`));
    console.log(`[migrate] ${applied.length ? `applied ${applied.join(', ')}` : 'schema up to date'}`);
  } else {
    console.warn('[startup] DATABASE_URL is not set. The API will report "not_configured" until it is.');
  }
  if (!isEntraConfigured(config) && !config.devAuth) {
    console.warn('[startup] ENTRA_TENANT_ID / ENTRA_CLIENT_ID are not set. Sign-in is disabled until they are.');
  }

  const { app } = await buildApp({ config, db, logger });
  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close().catch(() => undefined);
    await db?.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error('[startup] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
