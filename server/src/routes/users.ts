import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context.js';
import {
  adminReasonBody,
  adminRoleBody,
  adminUsersQuery,
  directoryQuery,
  idParams,
  parse,
  preferencesBody,
  profileBody,
} from '../http/validate.js';
import { notFound } from '../lib/errors.js';
import { iso } from '../lib/time.js';
import {
  applyAdminAction,
  changeRole,
  getPreferences,
  getUserById,
  listUsersForAdmin,
  searchDirectory,
  toProfile,
  updatePreferences,
  updateProfile,
  type AdminAction,
} from '../services/users.js';

const ADMIN_LIMIT = { rateLimit: { max: 60, timeWindow: '1 minute' } };

export async function userRoutes(app: FastifyInstance, { auth, db, mutate, hub }: RouteContext): Promise<void> {
  /** Works for pending/rejected users too, so the UI can show their access state. */
  app.get('/api/me', async (req) => {
    const { user } = await auth.requireIdentity(req);
    const preferences = user.status === 'approved' ? await getPreferences(db(), user.id) : null;
    return { user: toProfile(user), preferences };
  });

  app.patch('/api/me/profile', { config: ADMIN_LIMIT }, async (req) => {
    const { user } = await auth.requireUser(req);
    const body = parse(profileBody, req.body);
    await updateProfile(db(), user.id, body);
    return { user: toProfile((await getUserById(db(), user.id))!) };
  });

  app.get('/api/me/preferences', async (req) => {
    const { user } = await auth.requireUser(req);
    return { preferences: await getPreferences(db(), user.id) };
  });

  app.put('/api/me/preferences', { config: ADMIN_LIMIT }, async (req) => {
    const { user } = await auth.requireUser(req);
    const body = parse(preferencesBody, req.body);
    return { preferences: await updatePreferences(db(), user.id, body) };
  });

  app.get('/api/users', async (req) => {
    await auth.requireUser(req);
    const query = parse(directoryQuery, req.query);
    return { users: await searchDirectory(db(), query.q, query.limit) };
  });

  app.get('/api/users/:id', async (req) => {
    await auth.requireUser(req);
    const { id } = parse(idParams, req.params);
    const user = await getUserById(db(), id);
    // Employees can only see approved colleagues; pending/deactivated records are admin-only.
    if (!user || user.status !== 'approved') throw notFound('Employee not found');
    const profile = toProfile(user);
    return { user: { ...profile, online: hub.isOnline(user.id) } };
  });

  // ---- Administration ----------------------------------------------------

  app.get('/api/admin/users', async (req) => {
    await auth.requireAdmin(req);
    const query = parse(adminUsersQuery, req.query);
    return { users: await listUsersForAdmin(db(), query.status) };
  });

  for (const action of ['approve', 'reject', 'deactivate', 'reactivate'] as AdminAction[]) {
    app.post(`/api/admin/users/:id/${action}`, { config: ADMIN_LIMIT }, async (req) => {
      const { user: admin } = await auth.requireAdmin(req);
      const { id } = parse(idParams, req.params);
      const body = parse(adminReasonBody, req.body);
      const profile = await mutate((q, o) =>
        applyAdminAction(q, o, admin, id, action, body.reason, { ip: req.ip, userAgent: req.headers['user-agent'] }),
      );
      if (action === 'deactivate' || action === 'reject') {
        // Access is revoked immediately: open realtime sessions are closed.
        hub.disconnectUser(id, 4403, 'access_revoked');
      }
      return { user: profile };
    });
  }

  app.post('/api/admin/users/:id/role', { config: ADMIN_LIMIT }, async (req) => {
    const { user: admin } = await auth.requireAdmin(req);
    const { id } = parse(idParams, req.params);
    const { role } = parse(adminRoleBody, req.body);
    return {
      user: await mutate((q, o) => changeRole(q, o, admin, id, role, { ip: req.ip, userAgent: req.headers['user-agent'] })),
    };
  });

  app.get('/api/admin/users/:id/history', async (req) => {
    await auth.requireAdmin(req);
    const { id } = parse(idParams, req.params);
    const { rows } = await db().query<{
      id: string;
      action: string;
      from_status: string | null;
      to_status: string | null;
      from_role: string | null;
      to_role: string | null;
      reason: string | null;
      created_at: Date;
      decided_by_name: string | null;
    }>(
      `SELECT a.*, u.display_name AS decided_by_name FROM admin_approvals a
       LEFT JOIN users u ON u.id = a.decided_by WHERE a.user_id = $1 ORDER BY a.created_at DESC LIMIT 100`,
      [id],
    );
    return {
      history: rows.map((r) => ({
        id: r.id,
        action: r.action,
        fromStatus: r.from_status,
        toStatus: r.to_status,
        fromRole: r.from_role,
        toRole: r.to_role,
        reason: r.reason,
        decidedBy: r.decided_by_name,
        createdAt: iso(r.created_at),
      })),
    };
  });

  app.get('/api/admin/audit', async (req) => {
    await auth.requireAdmin(req);
    const { rows } = await db().query<{
      id: string;
      action: string;
      target_type: string | null;
      target_id: string | null;
      ip: string | null;
      data: unknown;
      created_at: Date;
      actor_name: string | null;
    }>(
      `SELECT l.id, l.action, l.target_type, l.target_id, l.ip, l.data, l.created_at, u.display_name AS actor_name
       FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id ORDER BY l.id DESC LIMIT 200`,
    );
    return {
      entries: rows.map((r) => ({
        id: Number(r.id),
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        ip: r.ip,
        data: r.data,
        actor: r.actor_name,
        createdAt: iso(r.created_at),
      })),
    };
  });
}
