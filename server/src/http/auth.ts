import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/database.js';
import type { TokenVerifier, VerifiedIdentity } from '../auth/verify.js';
import { AuthError } from '../auth/verify.js';
import { ApiError, forbidden, unauthorized } from '../lib/errors.js';
import { Outbox, type RealtimeHub } from '../realtime/hub.js';
import { audit } from '../services/common.js';
import { assertAdmin, resolveUser, type UserRow } from '../services/users.js';
import type { Actor } from '../services/tasks.js';

export interface AuthContext {
  identity: VerifiedIdentity;
  user: UserRow;
  actor: Actor;
}

interface Deps {
  config: AppConfig;
  db: Database | null;
  verifier: TokenVerifier | null;
  hub: RealtimeHub;
}

/** Counts failed authentications per client IP so token guessing is throttled. */
class FailureLimiter {
  private readonly hits = new Map<string, { n: number; since: number }>();
  constructor(
    private readonly max = 30,
    private readonly windowMs = 60_000,
  ) {}
  blocked(key: string): boolean {
    const h = this.hits.get(key);
    if (!h) return false;
    if (Date.now() - h.since > this.windowMs) {
      this.hits.delete(key);
      return false;
    }
    return h.n >= this.max;
  }
  fail(key: string): void {
    const h = this.hits.get(key);
    if (!h || Date.now() - h.since > this.windowMs) this.hits.set(key, { n: 1, since: Date.now() });
    else h.n++;
    if (this.hits.size > 10_000) this.hits.clear();
  }
}

export function createAuth(deps: Deps) {
  const failures = new FailureLimiter();
  const deniedLogged = new Map<string, number>();

  async function logDenied(req: FastifyRequest, err: AuthError) {
    if (!deps.db || err.status !== 403) return;
    const key = `${req.ip}:${err.code}`;
    const last = deniedLogged.get(key) ?? 0;
    if (Date.now() - last < 10 * 60_000) return;
    deniedLogged.set(key, Date.now());
    if (deniedLogged.size > 5000) deniedLogged.clear();
    await audit(deps.db, {
      actorId: null,
      action: 'auth.denied',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      data: { code: err.code },
    }).catch(() => undefined);
  }

  async function identify(token: string, req: FastifyRequest): Promise<AuthContext> {
    if (!deps.db) throw new ApiError(503, 'not_configured', 'TaskSync database is not configured yet');
    if (!deps.verifier) throw new ApiError(503, 'auth_not_configured', 'Microsoft sign-in is not configured yet');
    if (failures.blocked(req.ip)) throw new ApiError(429, 'too_many_failures', 'Too many failed sign-in attempts');
    let identity: VerifiedIdentity;
    try {
      identity = await deps.verifier(token);
    } catch (err) {
      failures.fail(req.ip);
      if (err instanceof AuthError) {
        await logDenied(req, err);
        throw err;
      }
      throw unauthorized('invalid_token', 'Access token validation failed');
    }
    const user = await resolveUser(
      deps.db,
      identity,
      deps.config,
      (o) => deps.hub.publish(o.events),
      (q) => new Outbox(q),
      { ip: req.ip, userAgent: req.headers['user-agent'] },
    );
    return { identity, user, actor: { id: user.id, role: user.role, displayName: user.display_name } };
  }

  function bearer(req: FastifyRequest): string {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) throw unauthorized();
    return header.slice(7).trim();
  }

  /** Any valid Omnifi identity, including users still waiting for approval. */
  async function requireIdentity(req: FastifyRequest): Promise<AuthContext> {
    return identify(bearer(req), req);
  }

  /** An approved, active employee. */
  async function requireUser(req: FastifyRequest): Promise<AuthContext> {
    const ctx = await requireIdentity(req);
    assertApproved(ctx.user);
    return ctx;
  }

  async function requireAdmin(req: FastifyRequest): Promise<AuthContext> {
    const ctx = await requireUser(req);
    assertAdmin(ctx.user);
    return ctx;
  }

  return { identify, requireIdentity, requireUser, requireAdmin };
}

export function assertApproved(user: UserRow): void {
  if (user.status === 'approved') return;
  const messages: Record<string, string> = {
    pending: 'Your access request is waiting for administrator approval',
    rejected: 'Your access request was not approved',
    deactivated: 'Your TaskSync access has been deactivated',
  };
  throw forbidden(`account_${user.status}`, messages[user.status] ?? 'Access denied');
}

export type Auth = ReturnType<typeof createAuth>;
