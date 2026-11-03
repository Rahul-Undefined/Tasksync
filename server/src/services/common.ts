import type { NotificationItem, NotificationType } from '@tasksync/shared';
import type { Queryable } from '../db/database.js';
import { iso } from '../lib/time.js';
import type { Outbox } from '../realtime/hub.js';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string;
  userAgent?: string;
  data?: Record<string, unknown>;
}

export async function audit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_log (actor_id, action, target_type, target_id, ip, user_agent, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      e.actorId,
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      e.ip ?? null,
      e.userAgent?.slice(0, 300) ?? null,
      JSON.stringify(e.data ?? {}),
    ],
  );
}

const PREFERENCE_FOR: Partial<Record<NotificationType, 'notify_assigned' | 'notify_status' | 'notify_comments'>> = {
  assigned: 'notify_assigned',
  reassigned: 'notify_assigned',
  unassigned: 'notify_assigned',
  status_changed: 'notify_status',
  completed: 'notify_status',
  cancelled: 'notify_status',
  declined: 'notify_status',
  commented: 'notify_comments',
  mentioned: 'notify_comments',
};

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  taskId: string | null;
  actorId: string | null;
  title: string;
  body?: string;
  /** Deliver even if the user muted this category (account notices). */
  force?: boolean;
}

/** Stores a notification (respecting the recipient's preferences) and queues a realtime event for it. */
export async function notify(q: Queryable, outbox: Outbox, n: NotifyInput): Promise<void> {
  if (n.actorId && n.actorId === n.userId) return;
  const pref = PREFERENCE_FOR[n.type];
  if (pref && !n.force) {
    const { rows } = await q.query<Record<string, boolean>>(
      `SELECT ${pref} AS enabled FROM user_preferences WHERE user_id = $1`,
      [n.userId],
    );
    if (rows[0] && rows[0].enabled === false) return;
  }
  const { rows } = await q.query<{ id: string; created_at: Date | string }>(
    `INSERT INTO notifications (user_id, task_id, actor_id, type, title, body)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
    [n.userId, n.taskId, n.actorId, n.type, n.title.slice(0, 300), (n.body ?? '').slice(0, 1000)],
  );
  const actor = n.actorId
    ? (
        await q.query<{ id: string; display_name: string; email: string }>(
          'SELECT id, display_name, email FROM users WHERE id = $1',
          [n.actorId],
        )
      ).rows[0]
    : undefined;
  const item: NotificationItem = {
    id: rows[0]!.id,
    type: n.type,
    title: n.title.slice(0, 300),
    body: (n.body ?? '').slice(0, 1000),
    taskId: n.taskId,
    actor: actor
      ? { id: actor.id, displayName: actor.display_name, email: actor.email, jobTitle: null, department: null }
      : null,
    readAt: null,
    createdAt: iso(rows[0]!.created_at),
  };
  await outbox.emit([n.userId], 'notification', n.taskId, item);
}
