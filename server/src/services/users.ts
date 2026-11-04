import type { Preferences, UserProfile, UserRole, UserStatus, UserSummary } from '@tasksync/shared';
import type { AppConfig } from '../config.js';
import type { Database, Queryable } from '../db/database.js';
import type { VerifiedIdentity } from '../auth/verify.js';
import { AuthError } from '../auth/verify.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { iso, isoOrNull } from '../lib/time.js';
import type { Outbox } from '../realtime/hub.js';
import { audit, notify } from './common.js';

export interface UserRow {
  id: string;
  entra_oid: string;
  tenant_id: string;
  email: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  approved_by: string | null;
  approved_at: Date | string | null;
  last_login_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  job_title: string | null;
  department: string | null;
  office_location: string | null;
  phone: string | null;
  about: string | null;
}

const USER_SELECT = `
  SELECT u.*, p.job_title, p.department, p.office_location, p.phone, p.about
  FROM users u LEFT JOIN employee_profiles p ON p.user_id = u.id`;

export function toSummary(u: Pick<UserRow, 'id' | 'display_name' | 'email' | 'job_title' | 'department'>): UserSummary {
  return {
    id: u.id,
    displayName: u.display_name,
    email: u.email,
    jobTitle: u.job_title ?? null,
    department: u.department ?? null,
  };
}

export function toProfile(u: UserRow): UserProfile {
  return {
    ...toSummary(u),
    role: u.role,
    status: u.status,
    officeLocation: u.office_location,
    phone: u.phone,
    about: u.about,
    createdAt: iso(u.created_at),
    lastLoginAt: isoOrNull(u.last_login_at),
  };
}

export async function getUserById(q: Queryable, id: string): Promise<UserRow | null> {
  const { rows } = await q.query<UserRow>(`${USER_SELECT} WHERE u.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function getUserByOid(q: Queryable, oid: string): Promise<UserRow | null> {
  const { rows } = await q.query<UserRow>(`${USER_SELECT} WHERE u.entra_oid = $1`, [oid]);
  return rows[0] ?? null;
}

const LOGIN_TOUCH_MS = 5 * 60_000;

/**
 * Maps a verified Entra identity to a TaskSync user, registering unknown employees as
 * "pending" so an administrator can approve them. Identity and role values always come
 * from the verified token or the database, never from the client.
 */
export async function resolveUser(
  db: Database,
  identity: VerifiedIdentity,
  config: AppConfig,
  publish: (o: Outbox) => void,
  makeOutbox: (q: Queryable) => Outbox,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<UserRow> {
  const existing = await getUserByOid(db, identity.oid);
  if (existing && existing.status === 'pending' && config.autoApproveEmployees) {
    // Approval was switched off after this person signed in: let them in now.
    await db.tx(async (q) => {
      await q.query(`UPDATE users SET status = 'approved', approved_at = now(), updated_at = now() WHERE id = $1`, [existing.id]);
      await q.query(
        `INSERT INTO admin_approvals (user_id, action, from_status, to_status, reason) VALUES ($1, 'approved', 'pending', 'approved', $2)`,
        [existing.id, 'Automatic: verified company Microsoft account'],
      );
    });
    return resolveUser(db, identity, config, publish, makeOutbox, meta);
  }
  if (existing) {
    const stale = !existing.last_login_at || Date.now() - new Date(existing.last_login_at).getTime() > LOGIN_TOUCH_MS;
    if (existing.email !== identity.email || existing.display_name !== identity.name || stale) {
      try {
        await db.query(
          `UPDATE users SET email = $2, display_name = $3, last_login_at = now(), updated_at = now() WHERE id = $1`,
          [existing.id, identity.email, identity.name],
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw identityConflict();
        throw err;
      }
      return { ...existing, email: identity.email, display_name: identity.name, last_login_at: new Date() };
    }
    return existing;
  }

  const bootstrap = config.bootstrapAdminEmails.includes(identity.email);
  // Verified company accounts get in straight away unless admin approval is switched on.
  const auto = !bootstrap && config.autoApproveEmployees;
  const approved = bootstrap || auto;
  try {
    let outbox: Outbox | undefined;
    const user = await db.tx(async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO users (entra_oid, tenant_id, email, display_name, role, status, approved_at, last_login_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (entra_oid) DO NOTHING
         RETURNING id`,
        [
          identity.oid,
          identity.tid,
          identity.email,
          identity.name,
          bootstrap ? 'admin' : 'employee',
          approved ? 'approved' : 'pending',
          approved ? new Date() : null,
        ],
      );
      if (!rows[0]) return null; // registered concurrently by another request
      const id = rows[0].id;
      await q.query('INSERT INTO employee_profiles (user_id) VALUES ($1)', [id]);
      await q.query('INSERT INTO user_preferences (user_id) VALUES ($1)', [id]);
      await q.query(
        `INSERT INTO admin_approvals (user_id, action, to_status, to_role, reason) VALUES ($1, $2, $3, $4, $5)`,
        [
          id,
          bootstrap ? 'bootstrap_admin' : auto ? 'approved' : 'requested',
          approved ? 'approved' : 'pending',
          bootstrap ? 'admin' : 'employee',
          bootstrap ? 'Listed in BOOTSTRAP_ADMIN_EMAILS' : auto ? 'Automatic: verified company Microsoft account' : null,
        ],
      );
      await audit(q, {
        actorId: id,
        action: bootstrap ? 'user.bootstrap_admin' : 'user.registered',
        targetType: 'user',
        targetId: id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        data: { email: identity.email },
      });
      if (auto) {
        // Tell admins who joined, and every colleague to refresh the @mention directory.
        outbox = makeOutbox(q);
        const everyone = await q.query<{ id: string; role: string }>(
          `SELECT id, role FROM users WHERE status = 'approved' AND id <> $1`,
          [id],
        );
        for (const a of everyone.rows.filter((u) => u.role === 'admin')) {
          await notify(q, outbox, {
            userId: a.id,
            type: 'account',
            actorId: id,
            taskId: null,
            title: `${identity.name} joined TaskSync`,
            body: `${identity.email} signed in with their Omnifi Microsoft account.`,
          });
        }
        await outbox.emit(
          everyone.rows.map((u) => u.id),
          'user.updated',
          null,
          { userId: id, status: 'approved', directoryChanged: true },
        );
      } else if (!bootstrap) {
        outbox = makeOutbox(q);
        const admins = await q.query<{ id: string }>(
          `SELECT id FROM users WHERE role = 'admin' AND status = 'approved'`,
        );
        for (const a of admins.rows) {
          await notify(q, outbox, {
            userId: a.id,
            type: 'account',
            actorId: id,
            taskId: null,
            title: `${identity.name} requested access`,
            body: `${identity.email} signed in and is waiting for approval.`,
          });
        }
        await outbox.emit(
          admins.rows.map((a) => a.id),
          'user.updated',
          null,
          { userId: id, status: 'pending' },
        );
      }
      return getUserById(q, id);
    });
    if (outbox) publish(outbox);
    if (user) return user;
    const raced = await getUserByOid(db, identity.oid);
    if (raced) return raced;
    throw new Error('User registration failed');
  } catch (err) {
    if (isUniqueViolation(err)) throw identityConflict();
    throw err;
  }
}

function identityConflict() {
  return new AuthError(
    'identity_conflict',
    'This email is already linked to a different Microsoft account. Ask a TaskSync administrator for help.',
    403,
  );
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

export async function searchDirectory(q: Queryable, query: string | undefined, limit = 50): Promise<UserSummary[]> {
  const term = (query ?? '').trim().toLowerCase().slice(0, 100);
  const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await q.query<UserRow>(
    `${USER_SELECT}
     WHERE u.status = 'approved'
       AND ($1 = '' OR lower(u.display_name) LIKE $2 ESCAPE '\\' OR u.email LIKE $2 ESCAPE '\\'
            OR lower(coalesce(p.department, '')) LIKE $2 ESCAPE '\\')
     ORDER BY lower(u.display_name)
     LIMIT $3`,
    [term, like, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map(toSummary);
}

export async function getUsersByIds(q: Queryable, ids: string[]): Promise<Map<string, UserSummary>> {
  const map = new Map<string, UserSummary>();
  if (ids.length === 0) return map;
  const { rows } = await q.query<UserRow>(`${USER_SELECT} WHERE u.id = ANY($1::uuid[])`, [[...new Set(ids)]]);
  for (const r of rows) map.set(r.id, toSummary(r));
  return map;
}

// ---------------------------------------------------------------------------
// Profile & preferences
// ---------------------------------------------------------------------------

export interface ProfilePatch {
  jobTitle?: string | null;
  department?: string | null;
  officeLocation?: string | null;
  phone?: string | null;
  about?: string | null;
}

export async function updateProfile(q: Queryable, userId: string, patch: ProfilePatch): Promise<void> {
  const clean = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : v.trim() || null);
  await q.query(
    `UPDATE employee_profiles SET
       job_title       = CASE WHEN $2::boolean THEN $3 ELSE job_title END,
       department      = CASE WHEN $4::boolean THEN $5 ELSE department END,
       office_location = CASE WHEN $6::boolean THEN $7 ELSE office_location END,
       phone           = CASE WHEN $8::boolean THEN $9 ELSE phone END,
       about           = CASE WHEN $10::boolean THEN $11 ELSE about END,
       updated_at = now()
     WHERE user_id = $1`,
    [
      userId,
      patch.jobTitle !== undefined,
      clean(patch.jobTitle) ?? null,
      patch.department !== undefined,
      clean(patch.department) ?? null,
      patch.officeLocation !== undefined,
      clean(patch.officeLocation) ?? null,
      patch.phone !== undefined,
      clean(patch.phone) ?? null,
      patch.about !== undefined,
      clean(patch.about) ?? null,
    ],
  );
}

interface PrefRow {
  notify_assigned: boolean;
  notify_status: boolean;
  notify_comments: boolean;
  desktop_toasts: boolean;
  widget_compact: boolean;
}

export async function getPreferences(q: Queryable, userId: string): Promise<Preferences> {
  const { rows } = await q.query<PrefRow>('SELECT * FROM user_preferences WHERE user_id = $1', [userId]);
  const r = rows[0];
  return {
    // Boolean() because SQLite returns 1/0
    notifyAssigned: Boolean(r?.notify_assigned ?? true),
    notifyStatus: Boolean(r?.notify_status ?? true),
    notifyComments: Boolean(r?.notify_comments ?? true),
    desktopToasts: Boolean(r?.desktop_toasts ?? true),
    widgetCompact: Boolean(r?.widget_compact ?? true),
  };
}

export async function updatePreferences(q: Queryable, userId: string, p: Partial<Preferences>): Promise<Preferences> {
  const cur = await getPreferences(q, userId);
  const next = { ...cur, ...p };
  await q.query(
    `INSERT INTO user_preferences (user_id, notify_assigned, notify_status, notify_comments, desktop_toasts, widget_compact)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       notify_assigned = EXCLUDED.notify_assigned, notify_status = EXCLUDED.notify_status,
       notify_comments = EXCLUDED.notify_comments, desktop_toasts = EXCLUDED.desktop_toasts,
       widget_compact = EXCLUDED.widget_compact, updated_at = now()`,
    [userId, next.notifyAssigned, next.notifyStatus, next.notifyComments, next.desktopToasts, next.widgetCompact],
  );
  return next;
}

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

export type AdminAction = 'approve' | 'reject' | 'deactivate' | 'reactivate';

const ADMIN_TRANSITIONS: Record<AdminAction, { from: UserStatus[]; to: UserStatus; record: string }> = {
  approve: { from: ['pending', 'rejected'], to: 'approved', record: 'approved' },
  reject: { from: ['pending'], to: 'rejected', record: 'rejected' },
  deactivate: { from: ['approved'], to: 'deactivated', record: 'deactivated' },
  reactivate: { from: ['deactivated'], to: 'approved', record: 'reactivated' },
};

export async function listUsersForAdmin(q: Queryable, status?: UserStatus): Promise<UserProfile[]> {
  const { rows } = await q.query<UserRow>(
    `${USER_SELECT} WHERE ($1::text IS NULL OR u.status = $1)
     ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, lower(u.display_name)
     LIMIT 1000`,
    [status ?? null],
  );
  return rows.map(toProfile);
}

async function countActiveAdmins(q: Queryable, excludingId?: string): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'approved' AND ($1::uuid IS NULL OR id <> $1)`,
    [excludingId ?? null],
  );
  return rows[0]?.n ?? 0;
}

export async function applyAdminAction(
  q: Queryable,
  outbox: Outbox,
  admin: UserRow,
  targetId: string,
  action: AdminAction,
  reason: string | undefined,
  meta: { ip?: string; userAgent?: string },
): Promise<UserProfile> {
  const target = await getUserById(q, targetId);
  if (!target) throw notFound('User not found');
  const rule = ADMIN_TRANSITIONS[action];
  if (target.id === admin.id && (action === 'deactivate' || action === 'reject')) {
    throw forbidden('self_action', 'You cannot deactivate your own account');
  }
  if (!rule.from.includes(target.status)) {
    throw conflict('invalid_transition', `Cannot ${action} a user whose status is ${target.status}`);
  }
  if (action === 'deactivate' && target.role === 'admin' && (await countActiveAdmins(q, target.id)) === 0) {
    throw conflict('last_admin', 'TaskSync must keep at least one active administrator');
  }
  await q.query(
    `UPDATE users SET status = $2, updated_at = now(),
       approved_by = CASE WHEN $2 = 'approved' THEN $3::uuid ELSE approved_by END,
       approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END
     WHERE id = $1`,
    [target.id, rule.to, admin.id],
  );
  await q.query(
    `INSERT INTO admin_approvals (user_id, decided_by, action, from_status, to_status, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [target.id, admin.id, rule.record, target.status, rule.to, reason ?? null],
  );
  await audit(q, {
    actorId: admin.id,
    action: `admin.user.${action}`,
    targetType: 'user',
    targetId: target.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
    data: { from: target.status, to: rule.to, reason: reason ?? null },
  });
  if (rule.to === 'approved') {
    await notify(q, outbox, {
      userId: target.id,
      type: 'account',
      actorId: admin.id,
      taskId: null,
      title: 'Your TaskSync access was approved',
      body: `${admin.display_name} approved your account. Welcome to TaskSync.`,
      force: true,
    });
  }
  await outbox.emit([target.id], 'user.updated', null, { userId: target.id, status: rule.to });
  // The employee directory changed (someone joined or left): let every colleague refresh it.
  if (rule.to === 'approved' || target.status === 'approved') {
    const { rows } = await q.query<{ id: string }>(
      `SELECT id FROM users WHERE status = 'approved' AND id <> $1`,
      [target.id],
    );
    await outbox.emit(
      rows.map((r) => r.id),
      'user.updated',
      null,
      { userId: target.id, status: rule.to, directoryChanged: true },
    );
  }
  const updated = await getUserById(q, target.id);
  return toProfile(updated!);
}

export async function changeRole(
  q: Queryable,
  outbox: Outbox,
  admin: UserRow,
  targetId: string,
  role: UserRole,
  meta: { ip?: string; userAgent?: string },
): Promise<UserProfile> {
  const target = await getUserById(q, targetId);
  if (!target) throw notFound('User not found');
  if (target.role === role) return toProfile(target);
  if (target.status !== 'approved') throw conflict('invalid_transition', 'Only approved users can change role');
  if (target.role === 'admin' && role !== 'admin' && (await countActiveAdmins(q, target.id)) === 0) {
    throw conflict('last_admin', 'TaskSync must keep at least one active administrator');
  }
  await q.query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [target.id, role]);
  await q.query(
    `INSERT INTO admin_approvals (user_id, decided_by, action, from_status, to_status, from_role, to_role)
     VALUES ($1, $2, 'role_changed', $3, $3, $4, $5)`,
    [target.id, admin.id, target.status, target.role, role],
  );
  await audit(q, {
    actorId: admin.id,
    action: 'admin.user.role',
    targetType: 'user',
    targetId: target.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
    data: { from: target.role, to: role },
  });
  await outbox.emit([target.id], 'user.updated', null, { userId: target.id, role });
  return toProfile((await getUserById(q, target.id))!);
}

export function assertAdmin(user: UserRow): void {
  if (user.role !== 'admin' || user.status !== 'approved') {
    throw forbidden('admin_required', 'Administrator access is required');
  }
}

export function validateRole(role: string): UserRole {
  if (role !== 'admin' && role !== 'employee') throw badRequest('Unknown role');
  return role;
}
