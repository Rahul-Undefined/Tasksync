import { readFileSync } from 'node:fs';
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

  /** GitHub storage (no external database): encrypted snapshots in a private repository. */
  GITHUB_DATA_TOKEN: z.string().trim().optional(),
  GITHUB_DATA_REPO: z.string().trim().optional(),
  GITHUB_DATA_BRANCH: z.string().trim().default('main'),
  GITHUB_API_URL: z.string().url().default('https://api.github.com'),
  DATA_ENCRYPTION_KEY: z.string().optional(),
  /** Set by Render, e.g. "Rahul-Undefined/Tasksync"; used to guess the data repository's owner. */
  RENDER_GIT_REPO_SLUG: z.string().optional(),
  /** Public GitHub repository whose "desktop-v*" releases the Windows app updates from (default: the code repo). */
  DESKTOP_RELEASES_REPO: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, 'must be owner/name').optional(),

  ENTRA_TENANT_ID: uuid.optional(),
  ENTRA_CLIENT_ID: uuid.optional(),
  ENTRA_API_SCOPE: z.string().default('access_as_user'),
  /**
   * id (default): the web app signs in with openid/profile/email only and sends the ID token —
   * no "Expose an API" setup and no admin consent needed.
   * access: the web app requests api://<client-id>/<scope> access tokens (needs the API exposed + consent).
   */
  ENTRA_TOKEN_MODE: z.enum(['id', 'access']).default('id'),
  /** Optional Entra app role every user must hold (e.g. TaskSync.User). */
  ENTRA_REQUIRED_ROLE: z.string().trim().optional().transform((v) => v || undefined),
  ALLOW_GUEST_ACCOUNTS: boolish,
  ALLOWED_EMAIL_DOMAINS: csv,
  BOOTSTRAP_ADMIN_EMAILS: csv,
  /** true (default): anyone with a verified company Microsoft account gets in without admin approval. */
  AUTO_APPROVE_EMPLOYEES: z.enum(['true', 'false', '1', '0', 'yes', 'no']).optional(),

  PUBLIC_BASE_URL: z.string().url().optional(),
  /** Set automatically by Render (e.g. https://tasksync-vgam.onrender.com); used when PUBLIC_BASE_URL is unset. */
  RENDER_EXTERNAL_URL: z.string().url().optional(),
  CORS_ALLOWED_ORIGINS: csv,
  TRUST_PROXY: boolish,
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).default(300),
  WEB_DIST_DIR: z.string().optional(),

  /** Local development sign-in without Entra. Refused when NODE_ENV=production. */
  DEV_AUTH: boolish,
  REALTIME_RETENTION_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(72),
});

export interface GitHubStorageConfig {
  repo: string;
  token: string;
  branch: string;
  apiUrl: string;
  encryptionKey: string;
}

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  storage: {
    /** postgres = DATABASE_URL; github = in-memory PostgreSQL saved to a private GitHub repo; pglite = local dev. */
    mode: 'postgres' | 'github' | 'pglite' | 'none';
    github?: GitHubStorageConfig;
    /** Why the configured storage can't be used yet (shown in /api/health). */
    problem?: string;
  };
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
    tokenMode: 'id' | 'access';
    requiredRole?: string;
    allowGuests: boolean;
  };
  allowedEmailDomains: string[];
  bootstrapAdminEmails: string[];
  autoApproveEmployees: boolean;
  publicBaseUrl?: string;
  corsOrigins: string[];
  trustProxy: boolean;
  rateLimitPerMinute: number;
  webDistDir: string;
  devAuth: boolean;
  realtimeRetentionHours: number;
  /** Where the Windows app looks for updates (GitHub releases tagged desktop-vX.Y.Z). */
  desktopReleases: { repo?: string; apiUrl: string };
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

  const storage: AppConfig['storage'] = { mode: 'none' };
  if (e.DATABASE_URL) {
    storage.mode = 'postgres';
  } else if (e.GITHUB_DATA_TOKEN) {
    storage.mode = 'github';
    const owner = e.RENDER_GIT_REPO_SLUG?.split('/')[0];
    const repo = e.GITHUB_DATA_REPO ?? (owner ? `${owner}/tasksync-data` : undefined);
    if (!repo) storage.problem = 'Set GITHUB_DATA_REPO to owner/name of the private data repository';
    else if (!e.DATA_ENCRYPTION_KEY || e.DATA_ENCRYPTION_KEY.length < 16) {
      storage.problem = 'Set DATA_ENCRYPTION_KEY to a secret of at least 16 characters (keep a copy: without it the data cannot be read)';
    } else {
      storage.github = {
        repo,
        token: e.GITHUB_DATA_TOKEN,
        branch: e.GITHUB_DATA_BRANCH,
        apiUrl: e.GITHUB_API_URL,
        encryptionKey: e.DATA_ENCRYPTION_KEY,
      };
    }
  } else if (!production && e.PGLITE_DATA_DIR) {
    storage.mode = 'pglite';
  }

  return {
    env: e.NODE_ENV,
    storage,
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
      tokenMode: e.ENTRA_TOKEN_MODE,
      requiredRole: e.ENTRA_REQUIRED_ROLE,
      allowGuests: e.ALLOW_GUEST_ACCOUNTS,
    },
    allowedEmailDomains: domains,
    bootstrapAdminEmails: e.BOOTSTRAP_ADMIN_EMAILS.map((x) => x.toLowerCase()),
    autoApproveEmployees: e.AUTO_APPROVE_EMPLOYEES === undefined ? true : ['true', '1', 'yes'].includes(e.AUTO_APPROVE_EMPLOYEES),
    publicBaseUrl: e.PUBLIC_BASE_URL ?? e.RENDER_EXTERNAL_URL,
    corsOrigins: e.CORS_ALLOWED_ORIGINS,
    trustProxy: cleaned.TRUST_PROXY === undefined ? production : e.TRUST_PROXY,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    webDistDir: e.WEB_DIST_DIR ?? path.resolve(here, '../../web/dist'),
    devAuth: e.DEV_AUTH,
    realtimeRetentionHours: e.REALTIME_RETENTION_HOURS,
    desktopReleases: { repo: e.DESKTOP_RELEASES_REPO ?? e.RENDER_GIT_REPO_SLUG, apiUrl: e.GITHUB_API_URL },
    version: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? process.env.npm_package_version ?? packageVersion(),
  };
}

export function isEntraConfigured(config: AppConfig): boolean {
  return Boolean(config.entra.tenantId && config.entra.clientId);
}

/** Version from the root package.json (used when the server is started without npm, e.g. in Docker). */
function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(path.resolve(here, '../../package.json'), 'utf8')) as { version?: string }).version ?? 'dev';
  } catch {
    return 'dev';
  }
}
