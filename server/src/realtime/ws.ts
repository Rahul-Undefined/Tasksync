import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { ClientMessage, RealtimeEvent, ServerMessage } from '@tasksync/shared';
import type { RouteContext } from '../routes/context.js';
import { ApiError } from '../lib/errors.js';
import { assertApproved, type AuthContext } from '../http/auth.js';
import { getUserById } from '../services/users.js';
import type { RealtimeClient } from './hub.js';
import { readEventsSince } from './replay.js';

const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 25_000;

/**
 * WebSocket protocol:
 *   client → { type: 'auth', token, since }   (first message, and again to refresh the token)
 *   server → missed events, then { type: 'ready', lastEventId }
 *   server → { type: 'event', event } for every committed change the user may see
 *   either  → ping/pong heartbeats
 * Close codes: 4401 auth failed/expired, 4403 access revoked, 4408 auth timeout.
 */
export async function realtimeRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { auth, hub, db, config } = ctx;

  app.get('/api/realtime', { websocket: true }, (socket: WebSocket, req) => {
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin, req.headers.host, config.corsOrigins)) {
      socket.close(4403, 'origin_not_allowed');
      return;
    }

    let session: AuthContext | null = null;
    let replaying = false;
    const buffered: RealtimeEvent[] = [];
    let alive = true;
    let expiryTimer: NodeJS.Timeout | undefined;

    const send = (msg: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const client: RealtimeClient = {
      send(msg) {
        if (msg.type === 'event' && replaying) buffered.push(msg.event);
        else send(msg);
      },
      close(code, reason) {
        socket.close(code, reason);
      },
    };

    const authTimer = setTimeout(() => {
      if (!session) socket.close(4408, 'auth_timeout');
    }, AUTH_TIMEOUT_MS);

    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, HEARTBEAT_MS);
    socket.on('pong', () => (alive = true));

    const cleanup = () => {
      clearTimeout(authTimer);
      clearTimeout(expiryTimer);
      clearInterval(heartbeat);
      if (session) hub.remove(session.user.id, client);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    socket.on('message', async (raw) => {
      alive = true;
      let msg: ClientMessage;
      try {
        const text = raw.toString();
        if (text.length > 32_768) throw new Error('too large');
        msg = JSON.parse(text) as ClientMessage;
      } catch {
        send({ type: 'error', code: 'bad_message', message: 'Invalid message' });
        return;
      }

      if (msg.type === 'ping') {
        send({ type: 'pong', t: msg.t });
        return;
      }
      if (msg.type !== 'auth' || typeof msg.token !== 'string') {
        send({ type: 'error', code: 'bad_message', message: 'Unknown message type' });
        return;
      }

      try {
        const next = await auth.identify(msg.token, req);
        if (session && next.user.id !== session.user.id) {
          socket.close(4401, 'identity_changed');
          return;
        }
        assertApproved(next.user);
        const first = !session;
        session = next;
        clearTimeout(authTimer);
        clearTimeout(expiryTimer);
        expiryTimer = setTimeout(
          () => socket.close(4401, 'token_expired'),
          Math.max(1_000, next.identity.expiresAt - Date.now()),
        );
        if (!first) return; // token refresh only

        replaying = true;
        hub.add(next.user.id, client);
        const since = typeof msg.since === 'number' && msg.since >= 0 ? Math.floor(msg.since) : 0;
        const replay = await readEventsSince(db(), next.user.id, since);
        if (replay.resync) {
          send({ type: 'resync', reason: 'missed_events', lastEventId: replay.lastEventId });
        } else {
          for (const event of replay.events) send({ type: 'event', event });
        }
        let last = replay.lastEventId;
        replaying = false;
        for (const event of buffered.splice(0)) {
          if (event.id > last || replay.resync) send({ type: 'event', event });
          last = Math.max(last, event.id);
        }
        send({ type: 'ready', userId: next.user.id, lastEventId: last, replayed: replay.events.length });
      } catch (err) {
        const code = err instanceof ApiError ? err.code : 'auth_failed';
        send({ type: 'error', code, message: err instanceof ApiError ? err.message : 'Authentication failed' });
        // 4403 = signed in but not allowed (do not retry), 4401 = token problem (refresh and retry)
        const status = err instanceof ApiError ? err.status : 401;
        socket.close(status === 403 ? 4403 : status === 503 ? 4503 : 4401, code.slice(0, 100));
      }
    });
  });

  // Re-check approval status of connected users periodically so revocations made
  // directly in the database also take effect.
  const recheck = setInterval(async () => {
    try {
      const d = db();
      for (const userId of hub.connectedUserIds()) {
        const user = await getUserById(d, userId);
        if (!user || user.status !== 'approved') hub.disconnectUser(userId, 4403, 'access_revoked');
      }
    } catch {
      // database unavailable; try again next interval
    }
  }, 60_000);
  recheck.unref();
  app.addHook('onClose', async () => clearInterval(recheck));
}

function originAllowed(origin: string, host: string | undefined, allowed: string[]): boolean {
  try {
    const o = new URL(origin);
    if (host && o.host === host) return true;
    return allowed.some((a) => a === origin);
  } catch {
    return false;
  }
}
