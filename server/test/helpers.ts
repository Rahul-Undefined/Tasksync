import { createHash } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPgliteDatabase, createPostgresDatabase, type Database } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrate.js';
import { createTokenVerifier } from '../src/auth/verify.js';
import type { RealtimeHub } from '../src/realtime/hub.js';

// Fictional tenant and people. No real Omnifi identities or data are used in tests.
export const TENANT = '7a3b0c1d-2e4f-4a5b-8c6d-1e2f3a4b5c6d';
export const OTHER_TENANT = '3c2b1a09-8f7e-4d6c-9b5a-0f1e2d3c4b5a';
export const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
export const CLIENT = '0f1e2d3c-4b5a-4968-8776-655443322110';
export const DOMAIN = 'example.com';
export const ADMIN_EMAIL = `admin@${DOMAIN}`;

export function oidFor(email: string): string {
  const h = createHash('sha256').update(email.toLowerCase()).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface Res<T = any> {
  status: number;
  body: T;
}

export interface TestEnv {
  app: FastifyInstance;
  db: Database;
  hub: RealtimeHub;
  mint(email: string, claims?: Record<string, unknown>, opts?: { iss?: string; aud?: string; exp?: string; key?: 'good' | 'rogue' }): Promise<string>;
  req<T = any>(method: string, url: string, token?: string, body?: unknown, headers?: Record<string, string>): Promise<Res<T>>;
  /** Signs in a person (registering them) and approves them via the admin API unless approve=false. */
  user(name: string, opts?: { approve?: boolean }): Promise<{ token: string; id: string; email: string; name: string }>;
  admin(): Promise<{ token: string; id: string }>;
  close(): Promise<void>;
}

export async function createTestEnv(envOverrides: Record<string, string> = {}): Promise<TestEnv> {
  const good = await generateKeyPair('RS256', { extractable: true });
  const rogue = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(good.publicKey)), kid: 'test-key', alg: 'RS256' };
  const verifier = createTokenVerifier({
    tenantId: TENANT,
    clientId: CLIENT,
    scope: 'access_as_user',
    allowedEmailDomains: [DOMAIN],
    requiredRole: envOverrides.ENTRA_REQUIRED_ROLE,
    keySet: createLocalJWKSet({ keys: [jwk] }),
  });
  const config = loadConfig({
    NODE_ENV: 'test',
    ENTRA_TENANT_ID: TENANT,
    ENTRA_CLIENT_ID: CLIENT,
    ALLOWED_EMAIL_DOMAINS: DOMAIN,
    BOOTSTRAP_ADMIN_EMAILS: ADMIN_EMAIL,
    WEB_DIST_DIR: './does-not-exist',
    RATE_LIMIT_PER_MINUTE: '100000',
    ...envOverrides,
  });
  const db = await createTestDatabase();
  await runMigrations(db);
  const { app, hub } = await buildApp({ config, db, verifier });
  await app.ready();

  const mint: TestEnv['mint'] = async (email, claims = {}, opts = {}) => {
    const tid = (claims.tid as string) ?? TENANT;
    return new SignJWT({
      tid,
      oid: oidFor(email),
      preferred_username: email,
      name: email.split('@')[0],
      scp: 'access_as_user',
      ver: '2.0',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(opts.iss ?? `https://login.microsoftonline.com/${tid}/v2.0`)
      .setAudience(opts.aud ?? CLIENT)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '1h')
      .sign(opts.key === 'rogue' ? rogue.privateKey : good.privateKey);
  };

  const req: TestEnv['req'] = async (method, url, token, body, headers = {}) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    let parsed: unknown = res.body;
    try {
      parsed = res.json();
    } catch {
      // non-JSON body
    }
    return { status: res.statusCode, body: parsed as any };
  };

  let adminCache: { token: string; id: string } | undefined;
  const admin = async () => {
    if (adminCache) return adminCache;
    const token = await mint(ADMIN_EMAIL, { name: 'Ada Admin' });
    const me = await req('GET', '/api/me', token);
    adminCache = { token, id: me.body.user.id };
    return adminCache;
  };

  const user: TestEnv['user'] = async (name, opts = {}) => {
    const email = `${name.toLowerCase().replace(/\s+/g, '.')}@${DOMAIN}`;
    const token = await mint(email, { name });
    const me = await req('GET', '/api/me', token);
    if (me.status !== 200) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(me.body)}`);
    if (opts.approve !== false) {
      const a = await admin();
      const r = await req('POST', `/api/admin/users/${me.body.user.id}/approve`, a.token, {});
      if (r.status !== 200) throw new Error(`approve failed: ${JSON.stringify(r.body)}`);
    }
    return { token, id: me.body.user.id, email, name };
  };

  return {
    app,
    db,
    hub,
    mint,
    req,
    user,
    admin,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

/** A fresh, isolated database per test environment: real PostgreSQL when TEST_DB=postgres, else PGlite. */
async function createTestDatabase(): Promise<Database> {
  const adminUrl = inject('pgUrl');
  if (!adminUrl) return createPgliteDatabase('memory');
  const name = `ts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return createPostgresDatabase({ url: url.toString(), ssl: 'disable', poolMax: 10 });
}

export const usingRealPostgres = () => Boolean(inject('pgUrl'));
