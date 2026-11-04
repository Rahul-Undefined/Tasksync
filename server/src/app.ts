import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { decodeJwt } from 'jose';
import { isEntraConfigured, type AppConfig } from './config.js';
import type { Database, Tx } from './db/database.js';
import type { Persistence } from './storage/persistence.js';
import { createTokenVerifier, type TokenVerifier } from './auth/verify.js';
import { createDevAuth, type DevAuth } from './auth/dev.js';
import { createAuth } from './http/auth.js';
import { registerStatic } from './http/static.js';
import { ApiError } from './lib/errors.js';
import { Outbox, RealtimeHub } from './realtime/hub.js';
import { pruneEvents } from './realtime/replay.js';
import { realtimeRoutes } from './realtime/ws.js';
import type { RouteContext } from './routes/context.js';
import { desktopRoutes } from './routes/desktop.js';
import { systemRoutes } from './routes/system.js';
import { taskRoutes } from './routes/tasks.js';
import { userRoutes } from './routes/users.js';

export interface BuildOptions {
  config: AppConfig;
  db: Database | null;
  /** Inject a verifier (tests). Defaults to Entra ID verification when configured. */
  verifier?: TokenVerifier | null;
  devAuth?: DevAuth | null;
  /** GitHub snapshot storage: requests wait until the stored data has been loaded. */
  persistence?: Persistence | null;
  logger?: boolean | Record<string, unknown>;
}

export interface BuiltApp {
  app: FastifyInstance;
  hub: RealtimeHub;
  devAuth: DevAuth | null;
}

const SERIALIZATION_FAILURES = new Set(['40001', '40P01']);

export async function buildApp(opts: BuildOptions): Promise<BuiltApp> {
  const { config, db } = opts;
  if (config.env === 'production' && (config.devAuth || opts.devAuth)) {
    throw new Error('Refusing to start: development sign-in is enabled in production');
  }

  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  // ---- Identity providers ---------------------------------------------------
  let devAuth = opts.devAuth ?? null;
  if (!devAuth && config.devAuth) {
    devAuth = await createDevAuth({ scope: config.entra.scope });
  }
  let verifier: TokenVerifier | null = opts.verifier ?? null;
  if (opts.verifier === undefined) {
    const entra = isEntraConfigured(config)
      ? createTokenVerifier({
          tenantId: config.entra.tenantId!,
          clientId: config.entra.clientId!,
          scope: config.entra.scope,
          allowedEmailDomains: config.allowedEmailDomains,
          allowGuests: config.entra.allowGuests,
          requiredRole: config.entra.requiredRole,
          acceptIdTokens: config.entra.tokenMode === 'id',
        })
      : null;
    const dev = devAuth
      ? createTokenVerifier({
          tenantId: devAuth.tenantId,
          clientId: devAuth.clientId,
          scope: config.entra.scope,
          allowedEmailDomains: config.allowedEmailDomains,
          keySet: devAuth.keySet,
        })
      : null;
    const devKid = devAuth?.keyId;
    if (entra && dev) {
      verifier = (token) => {
        const kid = safeKid(token);
        return kid === devKid ? dev(token) : entra(token);
      };
    } else {
      verifier = entra ?? dev;
    }
  }

  const hub = new RealtimeHub();
  const persistence = opts.persistence ?? null;
  const auth = createAuth({ config, db, verifier, hub, assertReady: () => void requireDb() });
  // eslint-disable-next-line prefer-const
  function requireDb(): Database {
    if (!db) throw new ApiError(503, 'not_configured', config.storage.problem ?? 'TaskSync database is not configured yet');
    if (persistence && !persistence.ready) {
      const s = persistence.status();
      throw s.state === 'error'
        ? new ApiError(503, 'storage_unavailable', 'TaskSync cannot reach its data store right now. Retrying.')
        : new ApiError(503, 'storage_loading', 'TaskSync is loading its data');
    }
    return db;
  }
  const mutate = async <T>(fn: (q: Tx, outbox: Outbox) => Promise<T>): Promise<T> => {
    const database = requireDb();
    for (let attempt = 1; ; attempt++) {
      let outbox: Outbox | undefined;
      try {
        const result = await database.tx(async (q) => {
          outbox = new Outbox(q);
          return fn(q, outbox);
        });
        hub.publish(outbox!.events);
        return result;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (attempt < 3 && code && SERIALIZATION_FAILURES.has(code)) continue;
        throw err;
      }
    }
  };
  const ctx: RouteContext = { config, auth, hub, devAuth, db: requireDb, mutate, persistence };

  // ---- Platform plugins -----------------------------------------------------
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'https://login.microsoftonline.com', ...wsOrigins(config)],
        frameSrc: ['https://login.microsoftonline.com'],
        frameAncestors: ["'none'"],
        formAction: ["'self'", 'https://login.microsoftonline.com'],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    // MSAL popup/redirect flows need the opener relationship with login.microsoftonline.com
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    strictTransportSecurity: config.env === 'production' ? { maxAge: 15552000, includeSubDomains: true } : false,
  });

  await app.register(cors, {
    // Same-origin by default. Extra origins only when the dashboard is hosted separately.
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitPerMinute,
    timeWindow: '1 minute',
    // Key by user (unverified oid is fine for bucketing; the request is still fully verified)
    // so colleagues behind one office IP do not share a bucket.
    keyGenerator: (req) => {
      const header = req.headers.authorization;
      if (header?.startsWith('Bearer ')) {
        try {
          const oid = decodeJwt(header.slice(7)).oid;
          if (typeof oid === 'string' && oid.length <= 64) return `user:${oid}`;
        } catch {
          // fall through to IP
        }
      }
      return `ip:${req.ip}`;
    },
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: { code: 'rate_limited', message: `Too many requests. Try again in ${Math.ceil(ctx.ttl / 1000)}s.` },
    }),
  });

  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // ---- Error handling -------------------------------------------------------
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string; error?: unknown };
    if (e.statusCode === 429) {
      return reply.code(429).send(e.error ? { error: e.error } : { error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      // Fastify-level client errors (bad JSON, body too large, unsupported media type).
      return reply.code(e.statusCode).send({ error: { code: 'bad_request', message: e.message ?? 'Bad request' } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply
      .code(500)
      .send({ error: { code: 'internal_error', message: 'Something went wrong. Please try again.', requestId: req.id } });
  });

  // ---- Routes ---------------------------------------------------------------
  await systemRoutes(app, ctx);
  await userRoutes(app, ctx);
  await taskRoutes(app, ctx);
  await realtimeRoutes(app, ctx);
  await desktopRoutes(app, ctx);
  const servingWeb = registerStatic(app, config.webDistDir);
  if (!servingWeb) {
    app.setNotFoundHandler((_req, reply) =>
      reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } }),
    );
  }

  // ---- Background maintenance -------------------------------------------------
  if (db && config.env !== 'test') {
    const timer = setInterval(() => {
      pruneEvents(db, config.realtimeRetentionHours).catch((err) => app.log.warn({ err }, 'event prune failed'));
    }, 30 * 60_000);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  return { app, hub, devAuth };
}

function safeKid(token: string): string | undefined {
  try {
    const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as { kid?: string };
    return header.kid;
  } catch {
    return undefined;
  }
}

function wsOrigins(config: AppConfig): string[] {
  const list: string[] = [];
  if (config.publicBaseUrl) {
    const u = new URL(config.publicBaseUrl);
    list.push(`${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`);
  }
  if (config.env !== 'production') list.push('ws://localhost:*', 'ws://127.0.0.1:*');
  return list;
}
