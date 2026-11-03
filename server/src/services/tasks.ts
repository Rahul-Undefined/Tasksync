import {
  ACTIVE_STATUSES,
  extractMentionIds,
  mentionsToPlainText,
  type ActivityType,
  type AssignmentStatus,
  type NotificationType,
  type Priority,
  type Task,
  type TaskActivity,
  type TaskComment,
  type TaskDetail,
  type TaskStatus,
  type TaskView,
  type UserRole,
  type UserSummary,
} from '@tasksync/shared';
import type { Queryable } from '../db/database.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { iso, isoOrNull } from '../lib/time.js';
import type { Outbox } from '../realtime/hub.js';
import { notify } from './common.js';
import { getUsersByIds } from './users.js';

export interface Actor {
  id: string;
  role: UserRole;
  displayName: string;
}

interface TaskRow {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  status: TaskStatus;
  due_at: Date | string | null;
  created_by: string;
  completed_at: Date | string | null;
  completed_by: string | null;
  cancelled_at: Date | string | null;
  cancelled_by: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  comment_count: number | string;
}

interface AssignmentRow {
  id: string;
  task_id: string;
  assignee_id: string;
  assigned_by: string;
  status: AssignmentStatus;
  assigned_at: Date | string;
  ended_at: Date | string | null;
  note: string | null;
}

const UNKNOWN_USER = (id: string): UserSummary => ({
  id,
  displayName: 'Unknown user',
  email: '',
  jobTitle: null,
  department: null,
});

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function loadTasks(q: Queryable, ids: string[]): Promise<Task[]> {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)];
  const { rows: tasks } = await q.query<TaskRow>(
    `SELECT t.*,
       (SELECT count(*) FROM task_comments c WHERE c.task_id = t.id AND c.deleted_at IS NULL)::int AS comment_count
     FROM tasks t WHERE t.id = ANY($1::uuid[])`,
    [unique],
  );
  const { rows: assignments } = await q.query<AssignmentRow>(
    `SELECT id, task_id, assignee_id, assigned_by, status, assigned_at, ended_at, note
     FROM task_assignments WHERE task_id = ANY($1::uuid[]) ORDER BY assigned_at, id`,
    [unique],
  );
  const userIds = new Set<string>();
  for (const t of tasks) {
    userIds.add(t.created_by);
    if (t.completed_by) userIds.add(t.completed_by);
    if (t.cancelled_by) userIds.add(t.cancelled_by);
  }
  for (const a of assignments) userIds.add(a.assignee_id);
  const users = await getUsersByIds(q, [...userIds]);
  const user = (id: string) => users.get(id) ?? UNKNOWN_USER(id);

  const byTask = new Map<string, AssignmentRow[]>();
  for (const a of assignments) {
    const list = byTask.get(a.task_id) ?? [];
    list.push(a);
    byTask.set(a.task_id, list);
  }

  const map = new Map<string, Task>();
  for (const t of tasks) {
    map.set(t.id, {
      id: t.id,
      title: t.title,
      description: t.description,
      priority: t.priority,
      status: t.status,
      dueAt: isoOrNull(t.due_at),
      createdAt: iso(t.created_at),
      updatedAt: iso(t.updated_at),
      version: Number(t.version),
      createdBy: user(t.created_by),
      completedAt: isoOrNull(t.completed_at),
      completedBy: t.completed_by ? user(t.completed_by) : null,
      cancelledAt: isoOrNull(t.cancelled_at),
      cancelledBy: t.cancelled_by ? user(t.cancelled_by) : null,
      commentCount: Number(t.comment_count),
      assignees: (byTask.get(t.id) ?? []).map((a) => ({
        assignmentId: a.id,
        user: user(a.assignee_id),
        status: a.status,
        assignedAt: iso(a.assigned_at),
        assignedById: a.assigned_by,
        endedAt: isoOrNull(a.ended_at),
        note: a.note,
      })),
    });
  }
  return ids.map((id) => map.get(id)).filter((t): t is Task => Boolean(t));
}

export async function loadTask(q: Queryable, id: string): Promise<Task | null> {
  return (await loadTasks(q, [id]))[0] ?? null;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export function participantIds(task: Task): string[] {
  return [...new Set([task.createdBy.id, ...task.assignees.map((a) => a.user.id)])];
}

export function activeAssigneeIds(task: Task): string[] {
  return task.assignees.filter((a) => a.status === 'active').map((a) => a.user.id);
}

export function canView(actor: Actor, task: Task): boolean {
  return actor.role === 'admin' || participantIds(task).includes(actor.id);
}

const isCreatorOrAdmin = (actor: Actor, task: Task) => actor.role === 'admin' || task.createdBy.id === actor.id;
const isActiveAssignee = (actor: Actor, task: Task) => activeAssigneeIds(task).includes(actor.id);
const isClosed = (s: TaskStatus) => s === 'completed' || s === 'cancelled';

/** Loads a task the actor may see. Missing and forbidden look identical (404) to prevent ID probing. */
async function getVisibleTask(q: Queryable, actor: Actor, id: string, lock = false): Promise<Task> {
  if (lock) {
    const { rows } = await q.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [id]);
    if (rows.length === 0) throw notFound('Task not found');
  }
  const task = await loadTask(q, id);
  if (!task || !canView(actor, task)) throw notFound('Task not found');
  return task;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function addActivity(
  q: Queryable,
  taskId: string,
  actorId: string,
  type: ActivityType,
  data: Record<string, unknown> = {},
): Promise<void> {
  await q.query('INSERT INTO task_activity (task_id, actor_id, type, data) VALUES ($1, $2, $3, $4)', [
    taskId,
    actorId,
    type,
    JSON.stringify(data),
  ]);
}

/** Emits the latest task state to every participant (plus any extra recipients). */
async function broadcastTask(q: Queryable, outbox: Outbox, taskId: string, extra: string[] = []): Promise<Task> {
  const task = (await loadTask(q, taskId))!;
  await outbox.emit([...participantIds(task), ...extra], 'task.upsert', task.id, task);
  return task;
}

async function validateAssignees(q: Queryable, ids: string[]): Promise<Map<string, UserSummary>> {
  const unique = [...new Set(ids.map((i) => i.toLowerCase()))];
  if (unique.length === 0) return new Map();
  const { rows } = await q.query<{ id: string }>(
    `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND status = 'approved'`,
    [unique],
  );
  const found = new Set(rows.map((r) => r.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length) {
    throw new ApiError(400, 'invalid_assignees', 'Some assignees are not approved TaskSync users', { missing });
  }
  return getUsersByIds(q, unique);
}

const ref = (u: UserSummary) => ({ id: u.id, name: u.displayName });
const quote = (title: string) => `“${title.length > 80 ? `${title.slice(0, 77)}…` : title}”`;

async function notifyMany(
  q: Queryable,
  outbox: Outbox,
  userIds: Iterable<string>,
  actor: Actor,
  taskId: string,
  type: NotificationType,
  title: string,
  body = '',
): Promise<void> {
  for (const userId of new Set(userIds)) {
    await notify(q, outbox, { userId, type, taskId, actorId: actor.id, title, body });
  }
}

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: Priority;
  dueAt?: string | null;
  assigneeIds?: string[];
  assignToSelf?: boolean;
  clientRequestId?: string;
}

export async function createTask(
  q: Queryable,
  outbox: Outbox,
  actor: Actor,
  input: CreateTaskInput,
): Promise<{ task: Task; created: boolean }> {
  if (input.clientRequestId) {
    // Idempotent retry (e.g. the network dropped after the server committed).
    const { rows } = await q.query<{ id: string }>(
      'SELECT id FROM tasks WHERE created_by = $1 AND client_request_id = $2',
      [actor.id, input.clientRequestId],
    );
    if (rows[0]) return { task: (await loadTask(q, rows[0].id))!, created: false };
  }

  const assigneeIds = new Set((input.assigneeIds ?? []).map((i) => i.toLowerCase()));
  if (input.assignToSelf) assigneeIds.add(actor.id);
  if (assigneeIds.size === 0) throw badRequest('Assign the task to at least one person (or to yourself)');
  const users = await validateAssignees(q, [...assigneeIds]);

  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO tasks (title, description, priority, due_at, created_by, client_request_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      input.title.trim(),
      (input.description ?? '').trim(),
      input.priority ?? 'medium',
      input.dueAt ?? null,
      actor.id,
      input.clientRequestId ?? null,
    ],
  );
  const taskId = rows[0]!.id;
  await addActivity(q, taskId, actor.id, 'created', { title: input.title.trim() });

  for (const uid of assigneeIds) {
    await q.query('INSERT INTO task_assignments (task_id, assignee_id, assigned_by) VALUES ($1, $2, $3)', [
      taskId,
      uid,
      actor.id,
    ]);
    const u = users.get(uid)!;
    if (uid === actor.id) await addActivity(q, taskId, actor.id, 'self_assigned', { assignee: ref(u) });
    else await addActivity(q, taskId, actor.id, 'assigned', { assignee: ref(u) });
  }

  await notifyMany(
    q,
    outbox,
    [...assigneeIds].filter((id) => id !== actor.id),
    actor,
    taskId,
    'assigned',
    `${actor.displayName} assigned you ${quote(input.title.trim())}`,
    mentionsToPlainText((input.description ?? '').trim()).slice(0, 200),
  );
  const task = await broadcastTask(q, outbox, taskId);
  return { task, created: true };
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: Priority;
  dueAt?: string | null;
}

export async function updateTask(
  q: Queryable,
  outbox: Outbox,
  actor: Actor,
  id: string,
  patch: UpdateTaskInput,
  expectedVersion: number,
): Promise<Task> {
  const task = await getVisibleTask(q, actor, id, true);
  if (!isCreatorOrAdmin(actor, task)) throw forbidden('not_creator', 'Only the task creator can edit task details');
  if (isClosed(task.status)) throw conflict('task_closed', 'Reopen the task before editing it', { task });

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const next = {
    title: patch.title !== undefined ? patch.title.trim() : task.title,
    description: patch.description !== undefined ? patch.description.trim() : task.description,
    priority: patch.priority ?? task.priority,
    dueAt: patch.dueAt !== undefined ? (patch.dueAt ? new Date(patch.dueAt).toISOString() : null) : task.dueAt,
  };
  for (const key of ['title', 'description', 'priority', 'dueAt'] as const) {
    if (next[key] !== task[key]) changes[key] = { from: task[key], to: next[key] };
  }
  if (Object.keys(changes).length === 0) return task;

  const { rowCount } = await q.query(
    `UPDATE tasks SET title = $3, description = $4, priority = $5, due_at = $6,
       version = version + 1, updated_at = now()
     WHERE id = $1 AND version = $2`,
    [id, expectedVersion, next.title, next.description, next.priority, next.dueAt],
  );
  if (rowCount === 0) {
    throw conflict('version_conflict', 'Someone else changed this task. Review the latest version and try again.', {
      task,
    });
  }
  if (changes.description) changes.description = { from: '(previous text)', to: '(updated)' };
  await addActivity(q, id, actor.id, 'updated', { changes });
  return broadcastTask(q, outbox, id);
}

// ---------------------------------------------------------------------------
// Status changes
// ---------------------------------------------------------------------------

type StatusTarget = 'pending' | 'in_progress' | 'completed' | 'cancelled';

const STATUS_RULES: Record<StatusTarget, { from: TaskStatus[]; who: 'participant' | 'creator' }> = {
  in_progress: { from: ['pending', 'reassigned'], who: 'participant' },
  completed: { from: ['pending', 'in_progress', 'reassigned'], who: 'participant' },
  pending: { from: ['in_progress', 'completed', 'cancelled'], who: 'participant' },
  cancelled: { from: ['pending', 'in_progress', 'reassigned', 'declined'], who: 'creator' },
};

export async function changeStatus(
  q: Queryable,
  outbox: Outbox,
  actor: Actor,
  id: string,
  target: StatusTarget,
  note?: string,
): Promise<{ task: Task; changed: boolean }> {
  const task = await getVisibleTask(q, actor, id, true);
  const rule = STATUS_RULES[target];
  const creatorOrAdmin = isCreatorOrAdmin(actor, task);
  const allowed =
    rule.who === 'creator' ||
    (target === 'pending' && task.status === 'cancelled') // restoring a cancelled task is the creator's call
      ? creatorOrAdmin
      : creatorOrAdmin || isActiveAssignee(actor, task);
  if (!allowed) {
    throw forbidden(
      'not_permitted',
      rule.who === 'creator' || task.status === 'cancelled'
        ? 'Only the task creator can do that'
        : 'Only assignees or the task creator can change this task',
    );
  }
  if (task.status === target) return { task, changed: false };
  if (!rule.from.includes(task.status)) {
    throw conflict('invalid_transition', `This task is ${task.status.replace('_', ' ')} and cannot become ${target.replace('_', ' ')}`, {
      task,
    });
  }

  let newStatus: TaskStatus = target;
  if (target === 'pending' && activeAssigneeIds(task).length === 0) newStatus = 'declined';

  const { rowCount } = await q.query(
    `UPDATE tasks SET status = $2, version = version + 1, updated_at = now(),
       completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE NULL END,
       completed_by = CASE WHEN $2 = 'completed' THEN $3::uuid ELSE NULL END,
       cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE NULL END,
       cancelled_by = CASE WHEN $2 = 'cancelled' THEN $3::uuid ELSE NULL END
     WHERE id = $1 AND status = ANY($4::text[])`,
    [id, newStatus, actor.id, rule.from],
  );
  if (rowCount === 0) {
    const latest = await loadTask(q, id);
    if (latest?.status === target) return { task: latest, changed: false };
    throw conflict('invalid_transition', 'The task changed while you were updating it', { task: latest });
  }

  const reopened = target === 'pending' && isClosed(task.status);
  const activityType: ActivityType =
    target === 'completed' ? 'completed' : target === 'cancelled' ? 'cancelled' : reopened ? 'reopened' : 'status_changed';
  await addActivity(q, id, actor.id, activityType, { from: task.status, to: newStatus, note: note ?? null });

  const t = quote(task.title);
  const others = participantsForNotice(task).filter((uid) => uid !== actor.id);
  if (target === 'completed') {
    await notifyMany(q, outbox, others, actor, id, 'completed', `${actor.displayName} completed ${t}`, note);
  } else if (target === 'cancelled') {
    await notifyMany(q, outbox, others, actor, id, 'cancelled', `${actor.displayName} cancelled ${t}`, note);
  } else if (reopened) {
    await notifyMany(q, outbox, others, actor, id, 'status_changed', `${actor.displayName} reopened ${t}`, note);
  } else {
    const label = target === 'in_progress' ? 'started' : 'paused';
    await notifyMany(q, outbox, others, actor, id, 'status_changed', `${actor.displayName} ${label} ${t}`, note);
  }
  return { task: await broadcastTask(q, outbox, id), changed: true };
}

/** Creator plus currently active assignees: the people who care about a status change. */
function participantsForNotice(task: Task): string[] {
  return [...new Set([task.createdBy.id, ...activeAssigneeIds(task)])];
}

// ---------------------------------------------------------------------------
// Assignment changes
// ---------------------------------------------------------------------------

export async function declineAssignment(
  q: Queryable,
  outbox: Outbox,
  actor: Actor,
  id: string,
  reason?: string,
): Promise<Task> {
  const task = await getVisibleTask(q, actor, id, true);
  if (!isActiveAssignee(actor, task)) throw forbidden('not_assignee', 'Only a current assignee can decline a task');
  if (isClosed(task.status)) throw conflict('task_closed', 'This task is already closed', { task });

  await q.query(
    `UPDATE task_assignments SET status = 'declined', ended_at = now(), ended_by = $3, note = $4
     WHERE task_id = $1 AND assignee_id = $2 AND status = 'active'`,
    [id, actor.id, actor.id, reason ?? null],
  );
  const remaining = activeAssigneeIds(task).filter((uid) => uid !== actor.id).length;
  await q.query(
    `UPDATE tasks SET status = CASE WHEN $2 THEN 'declined' ELSE status END,
       version = version + 1, updated_at = now() WHERE id = $1`,
    [id, remaining === 0],
  );
  await addActivity(q, id, actor.id, 'declined', {
    assignee: { id: actor.id, name: actor.displayName },
    reason: reason ?? null,
    allDeclined: remaining === 0,
  });
  if (task.createdBy.id !== actor.id) {
    await notify(q, outbox, {
      userId: task.createdBy.id,
      type: 'declined',
      taskId: id,
      actorId: actor.id,
      title: `${actor.displayName} declined ${quote(task.title)}`,
      body: reason ?? (remaining === 0 ? 'Nobody is assigned now. Reassign or cancel it.' : ''),
    });
  }
  return broadcastTask(q, outbox, id);
}

export async function addAssignees(
  q: Queryable,
  outbox: Outbox,
  actor: Actor,
  id: string,
  userIds: string[],
): Promise<Task> {
  const task = await getVisibleTask(q, actor, id, true);
  if (!isCreatorOrAdmin(actor, task)) throw forbidden('not_creator', 'Only the task creator can add assignees');
  if (isClosed(task.status)) throw conflict('task_closed', 'Reopen the task before changing assignees', { task });
  const active = new Set(activeAssigneeIds(task));
  const toAdd = [...new Set(userIds.map((u) => u.toLowerCase()))].filter((u) => !active.has(u));
  if (toAdd.length === 0) return task;
  const users = await validateAssignees(q, toAdd);

  for (const uid of toAdd) {
    await q.query('INSERT INTO task_assignments (task_id, assignee_id, assigned_by) VALUES ($1, $2, $3)', [
      id,
      uid,
      actor.id,
    ]);
    await addActivity(q, id, actor.id, uid === actor.id ? 'self_assigned' : 'assigned', { assignee: ref(users.get(uid)!) });
  }
  await q.query(
    `UPDATE tasks SET status = CASE WHEN status = 'declined' THEN 'pending' ELSE status END,
       version = version + 1, updated_at = now() WHERE id = $1`,
    [id],
  );
  await notifyMany(
    q,
    outbox,
    toAdd.filter((u) => u !== actor.id),
    actor,
    id,
    'assigned',
    `${actor.displayName} assigned you ${quote(task.title)}`,
  );
  return broadcastTask(q, outbox, id);
}

export async function removeAssignee(
  q: Queryable,
  outbox: Outbox,
  actor: Actor,
  id: string,
  userId: string,
): Promise<Task> {
  const task = await getVisibleTask(q, actor, id, true);
  if (!isCreatorOrAdmin(actor, task)) throw forbidden('not_creator', 'Only the task creator can remove assignees');
  if (isClosed(task.status)) throw conflict('task_closed', 'Reopen the task before changing assignees', { task });
  const active = activeAssigneeIds(task);
  const target = userId.toLowerCase();
  if (!active.includes(target)) throw notFound('That person is not currently assigned');
  if (active.length === 1) {
    throw conflict('last_assignee', 'A task needs at least one assignee. Reassign or cancel it instead.', { task });
  }
  const removed = task.assignees.find((a) => a.user.id === target && a.status === 'active')!.user;
  await q.query(
    `UPDATE task_assignments SET status = 'removed', ended_at = now(), ended_by = $3
     WHERE task_id = $1 AND assignee_id = $2 AND status = 'active'`,
    [id, target, actor.id],
  );
  await q.query('UPDATE tasks SET version = version + 1, updated_at = now() WHERE id = $1', [id]);
  await addActivity(q, id, actor.id, 'unassigned', { assignee: ref(removed) });
  await notify(q, outbox, {
    userId: target,
    type: 'unassigned',
    taskId: id,
    actorId: actor.id,
    title: `${actor.displayName} removed you from ${quote(task.title)}`,
  });
  return broadcastTask(q, outbox, id);
}

export interface ReassignInput {
  fromUserId?: string;
  toUserIds: string[];
  note?: string;
}

export async function reassignTask(
  q: Queryable,
  outbox: Outbox,
  actor: Actor,
  id: string,
  input: ReassignInput,
): Promise<Task> {
  const task = await getVisibleTask(q, actor, id, true);
  if (isClosed(task.status)) throw conflict('task_closed', 'Closed tasks cannot be reassigned', { task });
  const creatorOrAdmin = isCreatorOrAdmin(actor, task);
  const active = activeAssigneeIds(task);

  let from: string[];
  if (creatorOrAdmin) {
    from = input.fromUserId ? [input.fromUserId.toLowerCase()] : active;
  } else if (active.includes(actor.id)) {
    if (input.fromUserId && input.fromUserId.toLowerCase() !== actor.id) {
      throw forbidden('not_permitted', 'You can only hand over your own assignment');
    }
    from = [actor.id];
  } else {
    throw forbidden('not_permitted', 'Only the creator or a current assignee can reassign this task');
  }
  if (input.fromUserId && !active.includes(input.fromUserId.toLowerCase())) {
    throw notFound('That person is not currently assigned');
  }

  const to = [...new Set(input.toUserIds.map((u) => u.toLowerCase()))];
  if (to.length === 0) throw badRequest('Choose who should take over the task');
  const fromSet = new Set(from);
  if (to.every((u) => fromSet.has(u))) throw badRequest('Choose someone different to take over the task');
  const users = await validateAssignees(q, to);

  const fromUsers = task.assignees.filter((a) => a.status === 'active' && fromSet.has(a.user.id)).map((a) => a.user);
  for (const uid of from) {
    if (to.includes(uid)) continue;
    await q.query(
      `UPDATE task_assignments SET status = 'reassigned', ended_at = now(), ended_by = $3, note = $4
       WHERE task_id = $1 AND assignee_id = $2 AND status = 'active'`,
      [id, uid, actor.id, input.note ?? null],
    );
  }
  const stillActive = new Set(active.filter((u) => !fromSet.has(u) || to.includes(u)));
  const newcomers = to.filter((u) => !stillActive.has(u));
  for (const uid of newcomers) {
    await q.query('INSERT INTO task_assignments (task_id, assignee_id, assigned_by) VALUES ($1, $2, $3)', [
      id,
      uid,
      actor.id,
    ]);
  }
  await q.query(
    `UPDATE tasks SET status = 'reassigned', version = version + 1, updated_at = now() WHERE id = $1`,
    [id],
  );
  await addActivity(q, id, actor.id, 'reassigned', {
    from: fromUsers.filter((u) => !to.includes(u.id)).map(ref),
    to: to.map((u) => ref(users.get(u)!)),
    note: input.note ?? null,
  });

  const t = quote(task.title);
  const toNames = to.map((u) => users.get(u)!.displayName).join(', ');
  await notifyMany(q, outbox, newcomers, actor, id, 'assigned', `${actor.displayName} reassigned ${t} to you`, input.note);
  await notifyMany(
    q,
    outbox,
    [...from.filter((u) => !to.includes(u)), task.createdBy.id].filter((u) => !newcomers.includes(u)),
    actor,
    id,
    'reassigned',
    `${t} was reassigned to ${toNames}`,
    input.note,
  );
  return broadcastTask(q, outbox, id);
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

interface CommentRow {
  id: string;
  task_id: string;
  author_id: string;
  body: string;
  created_at: Date | string;
}

export async function addComment(
  q: Queryable,
  outbox: Outbox,
  actor: Actor,
  id: string,
  body: string,
): Promise<TaskComment> {
  const task = await getVisibleTask(q, actor, id, true);
  const text = body.trim();
  if (!text) throw badRequest('Comment cannot be empty');
  const { rows } = await q.query<CommentRow>(
    `INSERT INTO task_comments (task_id, author_id, body) VALUES ($1, $2, $3)
     RETURNING id, task_id, author_id, body, created_at`,
    [id, actor.id, text],
  );
  const row = rows[0]!;
  const plain = mentionsToPlainText(text);
  await addActivity(q, id, actor.id, 'commented', { commentId: row.id, excerpt: plain.slice(0, 140) });
  await q.query('UPDATE tasks SET updated_at = now() WHERE id = $1', [id]);

  // Only people already on the task can be mentioned, so a mention never leaks a task.
  const participants = new Set(participantIds(task));
  const mentioned = extractMentionIds(text).filter((uid) => participants.has(uid) && uid !== actor.id);
  const t = quote(task.title);
  await notifyMany(q, outbox, mentioned, actor, id, 'mentioned', `${actor.displayName} mentioned you on ${t}`, plain.slice(0, 200));
  await notifyMany(
    q,
    outbox,
    participantsForNotice(task).filter((uid) => uid !== actor.id && !mentioned.includes(uid)),
    actor,
    id,
    'commented',
    `${actor.displayName} commented on ${t}`,
    plain.slice(0, 200),
  );

  const author = (await getUsersByIds(q, [actor.id])).get(actor.id)!;
  const comment: TaskComment = { id: row.id, taskId: id, author, body: row.body, createdAt: iso(row.created_at) };
  await outbox.emit(participantIds(task), 'task.comment', id, comment);
  await broadcastTask(q, outbox, id);
  return comment;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

interface ActivityRow {
  id: string | number;
  task_id: string;
  task_title?: string;
  actor_id: string | null;
  type: ActivityType;
  data: Record<string, unknown> | string;
  created_at: Date | string;
}

async function mapActivity(q: Queryable, rows: ActivityRow[]): Promise<TaskActivity[]> {
  const users = await getUsersByIds(
    q,
    rows.map((r) => r.actor_id).filter((x): x is string => Boolean(x)),
  );
  return rows.map((r) => ({
    id: Number(r.id),
    taskId: r.task_id,
    taskTitle: r.task_title,
    actor: r.actor_id ? (users.get(r.actor_id) ?? UNKNOWN_USER(r.actor_id)) : null,
    type: r.type,
    data: typeof r.data === 'string' ? (JSON.parse(r.data) as Record<string, unknown>) : r.data,
    createdAt: iso(r.created_at),
  }));
}

export async function getTaskDetail(q: Queryable, actor: Actor, id: string): Promise<TaskDetail> {
  const task = await getVisibleTask(q, actor, id);
  const { rows: commentRows } = await q.query<CommentRow>(
    `SELECT id, task_id, author_id, body, created_at FROM task_comments
     WHERE task_id = $1 AND deleted_at IS NULL ORDER BY created_at, id LIMIT 500`,
    [id],
  );
  const authors = await getUsersByIds(q, commentRows.map((c) => c.author_id));
  const { rows: activityRows } = await q.query<ActivityRow>(
    'SELECT * FROM task_activity WHERE task_id = $1 ORDER BY id LIMIT 500',
    [id],
  );
  return {
    task,
    comments: commentRows.map((c) => ({
      id: c.id,
      taskId: c.task_id,
      author: authors.get(c.author_id) ?? UNKNOWN_USER(c.author_id),
      body: c.body,
      createdAt: iso(c.created_at),
    })),
    activity: await mapActivity(q, activityRows),
  };
}

const PARTICIPANT_SQL = `(t.created_by = $1 OR EXISTS (
  SELECT 1 FROM task_assignments pa WHERE pa.task_id = t.id AND pa.assignee_id = $1))`;

export async function listTasks(
  q: Queryable,
  actor: Actor,
  view: TaskView,
  opts: { userId?: string; limit?: number } = {},
): Promise<Task[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  let sql: string;
  let params: unknown[];
  switch (view) {
    case 'my':
      sql = `SELECT t.id FROM tasks t
             WHERE t.status = ANY($2::text[])
               AND EXISTS (SELECT 1 FROM task_assignments a WHERE a.task_id = t.id AND a.assignee_id = $1 AND a.status = 'active')
             ORDER BY t.due_at ASC NULLS LAST, t.created_at DESC LIMIT $3`;
      params = [actor.id, ACTIVE_STATUSES, limit];
      break;
    case 'assigned':
      sql = `SELECT t.id FROM tasks t
             WHERE t.created_by = $1 AND t.status = ANY($2::text[])
               AND EXISTS (SELECT 1 FROM task_assignments a WHERE a.task_id = t.id AND a.assignee_id <> $1)
             ORDER BY t.due_at ASC NULLS LAST, t.created_at DESC LIMIT $3`;
      params = [actor.id, [...ACTIVE_STATUSES, 'declined'], limit];
      break;
    case 'completed':
      sql = `SELECT t.id FROM tasks t
             WHERE t.status IN ('completed', 'cancelled')
               AND (t.created_by = $1 OR EXISTS (
                 SELECT 1 FROM task_assignments a WHERE a.task_id = t.id AND a.assignee_id = $1 AND a.status = 'active'))
             ORDER BY coalesce(t.completed_at, t.cancelled_at) DESC LIMIT $2`;
      params = [actor.id, limit];
      break;
    case 'involving': {
      if (!opts.userId) throw badRequest('userId is required for this view');
      const other = opts.userId.toLowerCase();
      if (actor.role === 'admin') {
        sql = `SELECT t.id FROM tasks t WHERE ${PARTICIPANT_SQL} ORDER BY t.updated_at DESC LIMIT $2`;
        params = [other, limit];
      } else {
        // Employees only see tasks they share with that colleague.
        sql = `SELECT t.id FROM tasks t
               WHERE ${PARTICIPANT_SQL}
                 AND (t.created_by = $2 OR EXISTS (
                   SELECT 1 FROM task_assignments b WHERE b.task_id = t.id AND b.assignee_id = $2))
               ORDER BY t.updated_at DESC LIMIT $3`;
        params = [actor.id, other, limit];
      }
      break;
    }
    case 'all':
      if (actor.role !== 'admin') throw forbidden('admin_required', 'Administrator access is required');
      sql = 'SELECT t.id FROM tasks t ORDER BY t.updated_at DESC LIMIT $1';
      params = [limit];
      break;
    default:
      throw badRequest('Unknown view');
  }
  const { rows } = await q.query<{ id: string }>(sql, params);
  return loadTasks(
    q,
    rows.map((r) => r.id),
  );
}

export async function listActivity(
  q: Queryable,
  actor: Actor,
  opts: { before?: number; limit?: number } = {},
): Promise<TaskActivity[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const { rows } = await q.query<ActivityRow>(
    `SELECT ta.*, t.title AS task_title
     FROM task_activity ta JOIN tasks t ON t.id = ta.task_id
     WHERE ${PARTICIPANT_SQL} AND ($2::bigint IS NULL OR ta.id < $2)
     ORDER BY ta.id DESC LIMIT $3`,
    [actor.id, opts.before ?? null, limit],
  );
  return mapActivity(q, rows);
}
