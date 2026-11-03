import type { FastifyInstance } from 'fastify';
import type { NotificationItem } from '@tasksync/shared';
import type { RouteContext } from './context.js';
import { isEntraConfigured } from '../config.js';
import { devTokenBody, eventsQuery, markReadBody, notificationsQuery, parse } from '../http/validate.js';
import { ApiError, forbidden, notFound } from '../lib/errors.js';
import { iso, isoOrNull } from '../lib/time.js';
import { emailDomainAllowed } from '../auth/verify.js';
import { readEventsSince } from '../realtime/replay.js';

const startedAt = Date.now();

export async function systemRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { config, auth, db, hub, devAuth } = ctx;

  /**
   * Liveness for Render's health check: returns 200 whenever the process can serve requests.
   * Add ?strict=1 to get 503 until the database and sign-in are configured and reachable.
   */
  app.get('/api/health', { config: { rateLimit: false } }, async (req, reply) => {
    let database: 'ok' | 'not_configured' | 'error' = 'not_configured';
    try {
      const d = db();
      await d.ping();
      database = 'ok';
    } catch (err) {
      database = err instanceof ApiError && err.code === 'not_configured' ? 'not_configured' : 'error';
    }
    const authMode = isEntraConfigured(config) ? 'entra' : devAuth ? 'dev' : 'not_configured';
    const ready = database === 'ok' && authMode !== 'not_configured';
    const strict = (req.query as { strict?: string }).strict === '1';
    if (strict && !ready) reply.code(503);
    reply.header('cache-control', 'no-store');
    return {
      status: ready ? 'ok' : 'degraded',
      database,
      auth: authMode,
      realtimeConnections: hub.connectionCount(),
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      time: new Date().toISOString(),
    };
  });

  /** Public, non-secret client configuration so the same web build works in every environment. */
  app.get('/api/config', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    const entra = isEntraConfigured(config)
      ? {
          tenantId: config.entra.tenantId!,
          clientId: config.entra.clientId!,
          authority: `https://login.microsoftonline.com/${config.entra.tenantId}`,
          tokenType: config.entra.tokenMode,
          scopes:
            config.entra.tokenMode === 'id'
              ? ['openid', 'profile', 'email']
              : [`api://${config.entra.clientId}/${config.entra.scope}`],
        }
      : null;
    return {
      authMode: entra ? 'entra' : devAuth ? 'dev' : 'not_configured',
      entra,
      allowedDomains: config.allowedEmailDomains,
      databaseConfigured: Boolean(config.database.url || config.database.pgliteDir),
      version: config.version,
    };
  });

  // ---- Notifications -----------------------------------------------------

  app.get('/api/notifications', async (req) => {
    const { user } = await auth.requireUser(req);
    const query = parse(notificationsQuery, req.query);
    const { rows } = await db().query<{
      id: string;
      type: NotificationItem['type'];
      title: string;
      body: string;
      task_id: string | null;
      read_at: Date | null;
      created_at: Date;
      actor_id: string | null;
      actor_name: string | null;
      actor_email: string | null;
    }>(
      `SELECT n.*, u.display_name AS actor_name, u.email AS actor_email
       FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
       WHERE n.user_id = $1 AND ($2::boolean IS NOT TRUE OR n.read_at IS NULL)
       ORDER BY n.created_at DESC LIMIT $3`,
      [user.id, query.unread === 'true', query.limit],
    );
    const { rows: count } = await db().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      [user.id],
    );
    const notifications: NotificationItem[] = rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      taskId: r.task_id,
      actor: r.actor_id
        ? { id: r.actor_id, displayName: r.actor_name ?? '', email: r.actor_email ?? '', jobTitle: null, department: null }
        : null,
      readAt: isoOrNull(r.read_at),
      createdAt: iso(r.created_at),
    }));
    return { notifications, unreadCount: count[0]?.n ?? 0 };
  });

  app.post('/api/notifications/read', async (req) => {
    const { user } = await auth.requireUser(req);
    const body = parse(markReadBody, req.body);
    const { rowCount } = await db().query(
      `UPDATE notifications SET read_at = now()
       WHERE user_id = $1 AND read_at IS NULL AND ($2::boolean OR id = ANY($3::uuid[]))`,
      [user.id, body.all === true, body.ids ?? []],
    );
    return { updated: rowCount };
  });

  // ---- Event replay (HTTP fallback for the WebSocket stream) --------------

  app.get('/api/events', async (req) => {
    const { user } = await auth.requireUser(req);
    const { since } = parse(eventsQuery, req.query);
    return readEventsSince(db(), user.id, since);
  });

  // ---- Local development sign-in -------------------------------------------

  if (devAuth) {
    if (config.env === 'production') throw new Error('Dev auth cannot be registered in production');
    app.post('/api/dev/token', async (req) => {
      const body = parse(devTokenBody, req.body);
      const email = body.email.toLowerCase();
      if (!emailDomainAllowed(email, config.allowedEmailDomains)) {
        throw forbidden('domain_not_allowed', `Dev sign-in only accepts ${config.allowedEmailDomains.join(', ')} addresses`);
      }
      return { accessToken: await devAuth.mint({ email, name: body.name }), expiresInSeconds: 8 * 3600 };
    });
  } else {
    app.post('/api/dev/token', async () => {
      throw notFound();
    });
  }
}
