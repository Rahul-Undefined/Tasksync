import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));

const boolish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const uuid = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be a GUID')
  .transform((v) => v.toLowerCase());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().trim().optional().transform((v) => v || undefined),
  /** require = TLS with certificate verification, no-verify = TLS without CA check, disable = plain TCP. */
  DATABASE_SSL: z.enum(['require', 'no-verify', 'disable']).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  /** PEM CA certificate for verifying the database's TLS certificate (Supabase uses its own CA). */
  DATABASE_CA_CERT: z.string().optional(),
  /** Development only: directory for an embedded PGlite database. Use "memory" for an in-memory database. */
  PGLITE_DATA_DIR: z.string().optional(),

  ENTRA_TENANT_ID: uuid.optional(),
  ENTRA_CLIENT_ID: uuid.optional(),
  ENTRA_API_SCOPE: z.string().default('access_as_user'),
  /** Optional Entra app role every user must hold (e.g. TaskSync.User). */
  ENTRA_REQUIRED_ROLE: z.string().trim().optional().transform((v) => v || undefined),
  ALLOW_GUEST_ACCOUNTS: boolish,
  ALLOWED_EMAIL_DOMAINS: csv,
  BOOTSTRAP_ADMIN_EMAILS: csv,

  PUBLIC_BASE_URL: z.string().url().optional(),
  CORS_ALLOWED_ORIGINS: csv,
  TRUST_PROXY: boolish,
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).default(300),
  WEB_DIST_DIR: z.string().optional(),

  /** Local development sign-in without Entra. Refused when NODE_ENV=production. */
  DEV_AUTH: boolish,
  REALTIME_RETENTION_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(72),
});

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  port: number;
  host: string;
  logLevel: string;
  database: {
    url?: string;
    ssl: 'require' | 'no-verify' | 'disable';
    caCert?: string;
    poolMax: number;
    pgliteDir?: string;
  };
  entra: {
    tenantId?: string;
    clientId?: string;
    scope: string;
    requiredRole?: string;
    allowGuests: boolean;
  };
  allowedEmailDomains: string[];
  bootstrapAdminEmails: string[];
  publicBaseUrl?: string;
  corsOrigins: string[];
  trustProxy: boolean;
  rateLimitPerMinute: number;
  webDistDir: string;
  devAuth: boolean;
  realtimeRetentionHours: number;
  version: string;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Blank variables (e.g. left empty in a hosting dashboard) mean "not set".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';

  if (production && e.DEV_AUTH) {
    throw new ConfigError('DEV_AUTH must never be enabled when NODE_ENV=production');
  }
  if (production && e.PGLITE_DATA_DIR) {
    throw new ConfigError('PGLITE_DATA_DIR is for local development only; set DATABASE_URL in production');
  }

  const domains = (e.ALLOWED_EMAIL_DOMAINS.length ? e.ALLOWED_EMAIL_DOMAINS : ['myomnifi.com']).map((d) =>
    d.toLowerCase().replace(/^@/, ''),
  );

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    database: {
      url: e.DATABASE_URL,
      ssl: e.DATABASE_SSL ?? (production ? 'require' : 'disable'),
      // Render env vars are single-line: accept "\n" escapes in the PEM.
      caCert: e.DATABASE_CA_CERT?.replace(/\\n/g, '\n'),
      poolMax: e.DATABASE_POOL_MAX,
      pgliteDir: e.PGLITE_DATA_DIR,
    },
    entra: {
      tenantId: e.ENTRA_TENANT_ID,
      clientId: e.ENTRA_CLIENT_ID,
      scope: e.ENTRA_API_SCOPE,
      requiredRole: e.ENTRA_REQUIRED_ROLE,
      allowGuests: e.ALLOW_GUEST_ACCOUNTS,
    },
    allowedEmailDomains: domains,
    bootstrapAdminEmails: e.BOOTSTRAP_ADMIN_EMAILS.map((x) => x.toLowerCase()),
    publicBaseUrl: e.PUBLIC_BASE_URL,
    corsOrigins: e.CORS_ALLOWED_ORIGINS,
    trustProxy: cleaned.TRUST_PROXY === undefined ? production : e.TRUST_PROXY,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    webDistDir: e.WEB_DIST_DIR ?? path.resolve(here, '../../web/dist'),
    devAuth: e.DEV_AUTH,
    realtimeRetentionHours: e.REALTIME_RETENTION_HOURS,
    version: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? process.env.npm_package_version ?? 'dev',
  };
}

export function isEntraConfigured(config: AppConfig): boolean {
  return Boolean(config.entra.tenantId && config.entra.clientId);
}
