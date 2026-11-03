import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { createPgliteDatabase, sslOptions } from '../src/db/database.js';
import { discoverTenantId } from '../src/auth/tenant.js';
import { X509Certificate } from 'node:crypto';
import { runMigrations } from '../src/db/migrate.js';
import { createTestEnv, type TestEnv } from './helpers.js';

describe('Configuration guards', () => {
  it('refuses DEV_AUTH or PGlite storage in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DEV_AUTH: 'true' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'production', PGLITE_DATA_DIR: './.data' })).toThrow(ConfigError);
    expect(() => loadConfig({ ENTRA_TENANT_ID: 'not-a-guid' })).toThrow(ConfigError);
  });

  it('accepts a database CA certificate pasted as a single line', () => {
    const c = loadConfig({ DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----' });
    expect(c.database.caCert).toBe('-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----');
  });

  it('treats blank environment variables as unset', () => {
    const c = loadConfig({ NODE_ENV: 'production', ENTRA_TENANT_ID: '', ENTRA_CLIENT_ID: '  ', DATABASE_URL: '' });
    expect(c.entra.tenantId).toBeUndefined();
    expect(c.database.url).toBeUndefined();
  });

  it('defaults to the Omnifi domain and strict settings in production', () => {
    const c = loadConfig({ NODE_ENV: 'production' });
    expect(c.allowedEmailDomains).toEqual(['myomnifi.com']);
    expect(c.database.ssl).toBe('require');
    expect(c.trustProxy).toBe(true);
    expect(c.entra.allowGuests).toBe(false);
  });

  it('cannot build a production app with a dev identity provider', async () => {
    const config = loadConfig({ NODE_ENV: 'production' });
    await expect(buildApp({ config, db: null, devAuth: {} as never })).rejects.toThrow(/development sign-in/);
  });
});

describe('Zero-paperwork configuration', () => {
  it('verifies Supabase connections with the bundled Supabase root CA (no certificate to paste)', () => {
    const ssl = sslOptions({ url: 'postgresql://postgres.abc:pw@aws-0-eu-north-1.pooler.supabase.com:5432/postgres', ssl: 'require' }) as {
      rejectUnauthorized: boolean;
      ca: string;
    };
    expect(ssl.rejectUnauthorized).toBe(true);
    const cert = new X509Certificate(ssl.ca);
    expect(cert.subject).toContain('CN=Supabase Root 2021 CA');
    expect(cert.ca).toBe(true);
    expect(cert.fingerprint256).toBe('80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA');
    // other hosts use the system trust store; an explicit CA always wins; no-verify/disable are honoured
    expect(sslOptions({ url: 'postgresql://u:p@db.example.com/x', ssl: 'require' })).toEqual({ rejectUnauthorized: true });
    expect(sslOptions({ url: 'postgresql://u:p@db.x.supabase.co/x', ssl: 'require', caCert: 'PEM' })).toEqual({ rejectUnauthorized: true, ca: 'PEM' });
    expect(sslOptions({ url: 'postgresql://u:p@h/x', ssl: 'no-verify' })).toEqual({ rejectUnauthorized: false });
    expect(sslOptions({ url: 'postgresql://u:p@h/x', ssl: 'disable' })).toBe(false);
  });

  it('finds the Entra tenant from the company domain and rejects personal or malformed answers', async () => {
    const fake = (issuer: unknown, ok = true) =>
      (async () => ({ ok, json: async () => ({ issuer }) })) as unknown as typeof fetch;
    const tid = '7a3b0c1d-2e4f-4a5b-8c6d-1e2f3a4b5c6d';
    expect(await discoverTenantId('example.com', fake(`https://login.microsoftonline.com/${tid}/v2.0`))).toBe(tid);
    expect(await discoverTenantId('outlook.com', fake('https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0'))).toBeNull();
    expect(await discoverTenantId('example.com', fake('https://evil.example/abc/v2.0'))).toBeNull();
    expect(await discoverTenantId('example.com', fake(undefined, false))).toBeNull();
    expect(await discoverTenantId('not a domain/../x', fake(`https://login.microsoftonline.com/${tid}/v2.0`))).toBeNull();
  });

  it("uses Render's own URL when PUBLIC_BASE_URL isn't set", () => {
    expect(loadConfig({ RENDER_EXTERNAL_URL: 'https://tasksync-vgam.onrender.com' }).publicBaseUrl).toBe('https://tasksync-vgam.onrender.com');
  });
});

describe('Unconfigured deployment (fresh Render service)', () => {
  it('stays up, reports what is missing, and refuses data access', async () => {
    const { app } = await buildApp({ config: loadConfig({ NODE_ENV: 'test', WEB_DIST_DIR: './nope' }), db: null });
    const health = await app.inject('/api/health');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'degraded', database: 'not_configured', auth: 'not_configured' });
    expect((await app.inject('/api/health?strict=1')).statusCode).toBe(503);
    const cfg = (await app.inject('/api/config')).json();
    expect(cfg).toMatchObject({ authMode: 'not_configured', entra: null, databaseConfigured: false });
    const me = await app.inject({ url: '/api/me', headers: { authorization: 'Bearer x' } });
    expect(me.statusCode).toBe(503);
    await app.close();
  });
});

describe('HTTP hardening', () => {
  let env: TestEnv;
  let dist: string;
  beforeAll(async () => {
    dist = await mkdtemp(path.join(os.tmpdir(), 'tasksync-dist-'));
    await mkdir(path.join(dist, 'assets'));
    await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>TaskSync</title>');
    await writeFile(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
    await writeFile(path.join(os.tmpdir(), 'tasksync-secret.txt'), 'SECRET');
    env = await createTestEnv({ WEB_DIST_DIR: dist });
  });
  afterAll(async () => {
    await env.close();
    await rm(dist, { recursive: true, force: true });
    await rm(path.join(os.tmpdir(), 'tasksync-secret.txt'), { force: true });
  });

  it('sends security headers including a strict CSP', async () => {
    const res = await env.app.inject('/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('serves the SPA shell for client routes and hashed assets with long caching', async () => {
    expect((await env.app.inject('/team')).body).toContain('<title>TaskSync</title>');
    const asset = await env.app.inject('/assets/app-abc123.js');
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await env.app.inject('/assets/missing.js')).statusCode).toBe(404);
    expect((await env.app.inject('/api/unknown')).statusCode).toBe(404);
  });

  it('blocks path traversal outside the web build', async () => {
    for (const url of ['/../tasksync-secret.txt', '/..%2ftasksync-secret.txt', '/%2e%2e/%2e%2e/tasksync-secret.txt', '/assets/..%5c..%5ctasksync-secret.txt']) {
      const res = await env.app.inject(url);
      expect(res.body, url).not.toContain('SECRET');
    }
    expect((await env.app.inject('/a%00b')).statusCode).toBe(400);
  });

  it('does not reflect arbitrary origins in CORS responses', async () => {
    const res = await env.app.inject({ method: 'OPTIONS', url: '/api/tasks', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns safe errors without stack traces', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/api/tasks', headers: { authorization: 'Bearer x', 'content-type': 'application/json' }, payload: '{bad json' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.body).not.toMatch(/at .*\.ts:\d+/);
  });
});

describe('Rate limiting', () => {
  it('limits per user and throttles repeated failed sign-ins per IP', async () => {
    const env = await createTestEnv({ RATE_LIMIT_PER_MINUTE: '15' });
    try {
      const u = await env.user('Rita Ratelimit');
      let limited = 0;
      for (let i = 0; i < 25; i++) if ((await env.req('GET', '/api/tasks', u.token)).status === 429) limited++;
      expect(limited).toBeGreaterThan(0);

      const env2 = await createTestEnv();
      try {
        const codes: number[] = [];
        for (let i = 0; i < 40; i++) codes.push((await env2.req('GET', '/api/me', `garbage.${i}.token`)).status);
        expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
        expect(codes.at(-1)).toBe(429);
      } finally {
        await env2.close();
      }
    } finally {
      await env.close();
    }
  });
});

describe('Local development sign-in', () => {
  it('mints tokens that pass the same verifier, only for allowed domains', async () => {
    const db = await createPgliteDatabase('memory');
    await runMigrations(db);
    const config = loadConfig({
      NODE_ENV: 'development',
      DEV_AUTH: 'true',
      ALLOWED_EMAIL_DOMAINS: 'example.com',
      BOOTSTRAP_ADMIN_EMAILS: 'dev.admin@example.com',
      WEB_DIST_DIR: './nope',
    });
    const { app } = await buildApp({ config, db });
    try {
      expect((await app.inject('/api/config')).json().authMode).toBe('dev');
      const denied = await app.inject({ method: 'POST', url: '/api/dev/token', payload: { email: 'x@gmail.com', name: 'X' } });
      expect(denied.statusCode).toBe(403);
      const ok = await app.inject({ method: 'POST', url: '/api/dev/token', payload: { email: 'dev.admin@example.com', name: 'Dev Admin' } });
      const token = ok.json().accessToken as string;
      const me = await app.inject({ url: '/api/me', headers: { authorization: `Bearer ${token}` } });
      expect(me.json().user).toMatchObject({ role: 'admin', status: 'approved' });
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('is not available unless explicitly enabled', async () => {
    const { app } = await buildApp({ config: loadConfig({ NODE_ENV: 'development', WEB_DIST_DIR: './nope' }), db: null });
    const res = await app.inject({ method: 'POST', url: '/api/dev/token', payload: { email: 'a@myomnifi.com', name: 'A' } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('Database lock-down', () => {
  it('enables row level security on every application table', async () => {
    const env = await createTestEnv();
    try {
      const { rows } = await env.db.query<{ relname: string; relrowsecurity: boolean }>(
        `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(12);
      for (const r of rows) expect(r.relrowsecurity, r.relname).toBe(true);
    } finally {
      await env.close();
    }
  });
});
