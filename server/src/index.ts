import { existsSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig, isEntraConfigured } from './config.js';
import { createDatabase } from './db/database.js';
import { discoverTenantId } from './auth/tenant.js';
import { runMigrations } from './db/migrate.js';

async function main() {
  // Local convenience: load ./.env when present (hosted environments set real env vars).
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  const logger =
    config.env === 'development'
      ? { level: config.logLevel, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
      : { level: config.logLevel, redact: ['req.headers.authorization'] };

  if (config.entra.clientId && !config.entra.tenantId) {
    const domain = config.allowedEmailDomains[0]!;
    for (let attempt = 1; attempt <= 3 && !config.entra.tenantId; attempt++) {
      try {
        config.entra.tenantId = (await discoverTenantId(domain)) ?? undefined;
        if (!config.entra.tenantId) break; // not a Microsoft work domain: retrying won't help
      } catch (err) {
        console.warn(`[startup] tenant lookup for ${domain} failed (attempt ${attempt}):`, err instanceof Error ? err.message : err);
      }
    }
    console.log(
      config.entra.tenantId
        ? `[startup] Microsoft Entra tenant for ${domain}: ${config.entra.tenantId}`
        : `[startup] Could not find the Microsoft tenant for ${domain}. Set ENTRA_TENANT_ID.`,
    );
  }

  const db = await createDatabase(config);
  if (db) {
    const applied = await runMigrations(db, (m) => console.log(`[migrate] ${m}`));
    console.log(`[migrate] ${applied.length ? `applied ${applied.join(', ')}` : 'schema up to date'}`);
  } else {
    console.warn('[startup] DATABASE_URL is not set. The API will report "not_configured" until it is.');
  }
  if (!isEntraConfigured(config) && !config.devAuth) {
    console.warn('[startup] ENTRA_CLIENT_ID is not set. Sign-in is disabled until it is.');
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
