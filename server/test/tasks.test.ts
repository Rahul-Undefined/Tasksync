import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { formatMention, type Task } from '@tasksync/shared';
import { createTestEnv, type TestEnv } from './helpers.js';

type U = Awaited<ReturnType<TestEnv['user']>>;
let env: TestEnv;
let rahul: U, stella: U, mike: U, nina: U, outsider: U;

const ids = (tasks: Task[]) => tasks.map((t) => t.id);
const list = async (u: U, view: string, extra = '') =>
  (await env.req('GET', `/api/tasks?view=${view}${extra}`, u.token)).body.tasks as Task[];

beforeAll(async () => {
  env = await createTestEnv();
  rahul = await env.user('Rahul Tester');
  stella = await env.user('Stella Tester');
  mike = await env.user('Mike Tester');
  nina = await env.user('Nina Tester');
  outsider = await env.user('Oscar Outsider');
});
afterAll(async () => env.close());

async function create(by: U, body: Record<string, unknown>) {
  const res = await env.req('POST', '/api/tasks', by.token, body);
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.task as Task;
}

describe('Task creation and assignment', () => {
  it('[T6] self-assignment: creator = assignee, shows in My Tasks, history records self_assigned', async () => {
    const task = await create(rahul, { title: 'Prepare MIS pack', assignToSelf: true, priority: 'high' });
    expect(task.createdBy.id).toBe(rahul.id);
    expect(task.assignees).toHaveLength(1);
    expect(task.assignees[0]).toMatchObject({ status: 'active', user: { id: rahul.id } });
    expect(task.status).toBe('pending');
    expect(ids(await list(rahul, 'my'))).toContain(task.id);
    // self-assigned tasks are not "assigned by me" to someone else
    expect(ids(await list(rahul, 'assigned'))).not.toContain(task.id);
    const detail = await env.req('GET', `/api/tasks/${task.id}`, rahul.token);
    expect(detail.body.activity.map((a: { type: string }) => a.type)).toEqual(['created', 'self_assigned']);
  });

  it('[T7] assigning to another employee: one record, visible to both in the right tabs, assignee notified', async () => {
    const due = new Date(Date.now() + 86400_000).toISOString();
    const task = await create(rahul, { title: 'Reconcile bank feed', assigneeIds: [stella.id], dueAt: due });
    expect(task.dueAt).toBe(due);
    expect(ids(await list(stella, 'my'))).toContain(task.id);
    expect(ids(await list(rahul, 'assigned'))).toContain(task.id);
    expect(ids(await list(rahul, 'my'))).not.toContain(task.id);
    const notes = await env.req('GET', '/api/notifications', stella.token);
    expect(notes.body.notifications[0]).toMatchObject({ type: 'assigned', taskId: task.id });
    expect(notes.body.unreadCount).toBeGreaterThan(0);
    // exactly one task row exists
    const { rows } = await env.db.query<{ n: number }>('SELECT count(*)::int AS n FROM tasks WHERE title = $1', [
      'Reconcile bank feed',
    ]);
    expect(rows[0]!.n).toBe(1);
  });

  it('[T8] multiple assignees share one task and one status', async () => {
    const task = await create(rahul, { title: 'Quarter close checklist', assigneeIds: [stella.id, mike.id, nina.id] });
    expect(task.assignees.map((a) => a.user.id).sort()).toEqual([stella.id, mike.id, nina.id].sort());
    for (const u of [stella, mike, nina]) expect(ids(await list(u, 'my'))).toContain(task.id);
    const done = await env.req('POST', `/api/tasks/${task.id}/status`, mike.token, { status: 'completed' });
    expect(done.status).toBe(200);
    for (const u of [stella, mike, nina, rahul]) {
      expect(ids(await list(u, 'my'))).not.toContain(task.id);
      expect(ids(await list(u, 'completed'))).toContain(task.id);
    }
  });

  it('validates input and rejects unknown/unapproved assignees', async () => {
    expect((await env.req('POST', '/api/tasks', rahul.token, { title: '', assignToSelf: true })).status).toBe(400);
    expect((await env.req('POST', '/api/tasks', rahul.token, { title: 'x'.repeat(201), assignToSelf: true })).status).toBe(400);
    expect((await env.req('POST', '/api/tasks', rahul.token, { title: 'Nobody' })).status).toBe(400);
    const bad = await env.req('POST', '/api/tasks', rahul.token, { title: 'Ghost', assigneeIds: [randomUUID()] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_assignees');
    const pending = await env.user('Penny Pending', { approve: false });
    const p = await env.req('POST', '/api/tasks', rahul.token, { title: 'To pending', assigneeIds: [pending.id] });
    expect(p.body.error.code).toBe('invalid_assignees');
    expect((await env.req('POST', '/api/tasks', rahul.token, { title: 'Bad prio', assignToSelf: true, priority: 'mega' })).status).toBe(400);
  });

  it('ignores client-supplied identity fields (created_by, status, version)', async () => {
    const res = await env.req('POST', '/api/tasks', rahul.token, {
      title: 'Spoof attempt',
      assignToSelf: true,
      createdBy: stella.id,
      created_by: stella.id,
      status: 'completed',
    });
    expect(res.status).toBe(201);
    expect(res.body.task.createdBy.id).toBe(rahul.id);
    expect(res.body.task.status).toBe('pending');
  });
});

describe('Shared completion and status changes', () => {
  it('[T9] Rahul assigns to Stella; Stella completes; it is completed for both with who/when recorded', async () => {
    const task = await create(rahul, { title: 'Send vendor statement', assigneeIds: [stella.id] });
    const started = await env.req('POST', `/api/tasks/${task.id}/status`, stella.token, { status: 'in_progress' });
    expect(started.body.task.status).toBe('in_progress');
    const done = await env.req('POST', `/api/tasks/${task.id}/status`, stella.token, { status: 'completed' });
    expect(done.status).toBe(200);
    expect(done.body.changed).toBe(true);
    const t = done.body.task as Task;
    expect(t.status).toBe('completed');
    expect(t.completedBy?.id).toBe(stella.id);
    expect(Date.parse(t.completedAt!)).toBeGreaterThan(Date.now() - 60_000);

    expect(ids(await list(stella, 'my'))).not.toContain(task.id);
    expect(ids(await list(rahul, 'assigned'))).not.toContain(task.id);
    expect(ids(await list(stella, 'completed'))).toContain(task.id);
    expect(ids(await list(rahul, 'completed'))).toContain(task.id);

    const { rows } = await env.db.query<{ status: string; completed_by: string; completed_at: Date }>(
      'SELECT status, completed_by, completed_at FROM tasks WHERE id = $1',
      [task.id],
    );
    expect(rows[0]).toMatchObject({ status: 'completed', completed_by: stella.id });
    expect(rows[0]!.completed_at).toBeTruthy();

    const notes = await env.req('GET', '/api/notifications', rahul.token);
    expect(notes.body.notifications.some((n: { type: string; taskId: string }) => n.type === 'completed' && n.taskId === task.id)).toBe(true);

    // completing again is idempotent
    const again = await env.req('POST', `/api/tasks/${task.id}/status`, stella.token, { status: 'completed' });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);

    // reopening brings it back for both
    const reopen = await env.req('POST', `/api/tasks/${task.id}/status`, rahul.token, { status: 'pending' });
    expect(reopen.body.task.status).toBe('pending');
    expect(reopen.body.task.completedAt).toBeNull();
    expect(ids(await list(stella, 'my'))).toContain(task.id);
  });

  it('[T11] cancellation is creator-only and closes the task for everyone', async () => {
    const task = await create(rahul, { title: 'Draft board memo', assigneeIds: [stella.id] });
    const byAssignee = await env.req('POST', `/api/tasks/${task.id}/status`, stella.token, { status: 'cancelled' });
    expect(byAssignee.status).toBe(403);
    const res = await env.req('POST', `/api/tasks/${task.id}/status`, rahul.token, { status: 'cancelled', note: 'No longer needed' });
    expect(res.body.task).toMatchObject({ status: 'cancelled', cancelledBy: { id: rahul.id } });
    expect(ids(await list(stella, 'my'))).not.toContain(task.id);
    expect(ids(await list(stella, 'completed'))).toContain(task.id);
    const notes = await env.req('GET', '/api/notifications', stella.token);
    expect(notes.body.notifications.some((n: { type: string; taskId: string }) => n.type === 'cancelled' && n.taskId === task.id)).toBe(true);
    // a cancelled task cannot be completed
    const complete = await env.req('POST', `/api/tasks/${task.id}/status`, stella.token, { status: 'completed' });
    expect(complete.status).toBe(409);
    expect(complete.body.error.code).toBe('invalid_transition');
    // only the creator can restore it
    expect((await env.req('POST', `/api/tasks/${task.id}/status`, stella.token, { status: 'pending' })).status).toBe(403);
    expect((await env.req('POST', `/api/tasks/${task.id}/status`, rahul.token, { status: 'pending' })).body.task.status).toBe('pending');
  });
});

describe('Decline, remove and reassign', () => {
  it('[T12] decline by sole assignee sets task Declined for the creator to act on', async () => {
    const task = await create(rahul, { title: 'Collect TDS certificates', assigneeIds: [stella.id] });
    const res = await env.req('POST', `/api/tasks/${task.id}/decline`, stella.token, { reason: 'On leave next week' });
    expect(res.status).toBe(200);
    const t = res.body.task as Task;
    expect(t.status).toBe('declined');
    expect(t.assignees[0]).toMatchObject({ status: 'declined', note: 'On leave next week' });
    expect(ids(await list(stella, 'my'))).not.toContain(task.id);
    expect(ids(await list(rahul, 'assigned'))).toContain(task.id);
    const notes = await env.req('GET', '/api/notifications', rahul.token);
    expect(notes.body.notifications[0]).toMatchObject({ type: 'declined', taskId: task.id });
    // non-assignees cannot decline
    expect((await env.req('POST', `/api/tasks/${task.id}/decline`, mike.token, {})).status).toBe(404);
    // creator re-assigns: task becomes Reassigned and active again
    const re = await env.req('POST', `/api/tasks/${task.id}/reassign`, rahul.token, { toUserIds: [mike.id] });
    expect(re.body.task.status).toBe('reassigned');
    expect(ids(await list(mike, 'my'))).toContain(task.id);
  });

  it('[T12] decline by one of several assignees keeps the task going for the rest', async () => {
    const task = await create(rahul, { title: 'Audit prep', assigneeIds: [stella.id, mike.id] });
    const res = await env.req('POST', `/api/tasks/${task.id}/decline`, stella.token, {});
    expect(res.body.task.status).toBe('pending');
    expect(ids(await list(mike, 'my'))).toContain(task.id);
    expect(ids(await list(stella, 'my'))).not.toContain(task.id);
  });

  it('[T12] creator removes an assignee; the last assignee cannot be removed', async () => {
    const task = await create(rahul, { title: 'Payroll inputs', assigneeIds: [stella.id, mike.id] });
    expect((await env.req('DELETE', `/api/tasks/${task.id}/assignees/${mike.id}`, stella.token)).status).toBe(403);
    const res = await env.req('DELETE', `/api/tasks/${task.id}/assignees/${mike.id}`, rahul.token);
    expect(res.body.task.assignees.find((a: { user: { id: string } }) => a.user.id === mike.id).status).toBe('removed');
    expect(ids(await list(mike, 'my'))).not.toContain(task.id);
    const last = await env.req('DELETE', `/api/tasks/${task.id}/assignees/${stella.id}`, rahul.token);
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('last_assignee');
    // add back
    const add = await env.req('POST', `/api/tasks/${task.id}/assignees`, rahul.token, { userIds: [nina.id] });
    expect(add.body.task.assignees.filter((a: { status: string }) => a.status === 'active')).toHaveLength(2);
  });

  it('[T10] reassignment changes ownership, keeps assignment history and notifies everyone', async () => {
    const task = await create(rahul, { title: 'GST filing', assigneeIds: [stella.id] });
    // an assignee can hand over their own assignment
    const res = await env.req('POST', `/api/tasks/${task.id}/reassign`, stella.token, {
      toUserIds: [mike.id],
      note: 'Mike owns GST now',
    });
    expect(res.status).toBe(200);
    const t = res.body.task as Task;
    expect(t.status).toBe('reassigned');
    expect(t.assignees.map((a) => [a.user.id, a.status])).toEqual([
      [stella.id, 'reassigned'],
      [mike.id, 'active'],
    ]);
    expect(ids(await list(stella, 'my'))).not.toContain(task.id);
    expect(ids(await list(mike, 'my'))).toContain(task.id);
    // the old assignee cannot reassign again
    expect((await env.req('POST', `/api/tasks/${task.id}/reassign`, stella.token, { toUserIds: [nina.id] })).status).toBe(403);
    // an assignee cannot reassign someone else's assignment
    const t2 = await create(rahul, { title: 'Two people', assigneeIds: [stella.id, mike.id] });
    const steal = await env.req('POST', `/api/tasks/${t2.id}/reassign`, mike.token, { fromUserId: stella.id, toUserIds: [nina.id] });
    expect(steal.status).toBe(403);

    const mikeNotes = (await env.req('GET', '/api/notifications', mike.token)).body.notifications;
    expect(mikeNotes.some((n: { taskId: string; type: string }) => n.taskId === task.id && n.type === 'assigned')).toBe(true);
    const rahulNotes = (await env.req('GET', '/api/notifications', rahul.token)).body.notifications;
    expect(rahulNotes.some((n: { taskId: string; type: string }) => n.taskId === task.id && n.type === 'reassigned')).toBe(true);

    // the new assignee starts it: status moves on from Reassigned
    const started = await env.req('POST', `/api/tasks/${task.id}/status`, mike.token, { status: 'in_progress' });
    expect(started.body.task.status).toBe('in_progress');
  });
});

describe('Comments, mentions, history and notifications', () => {
  it('[T13][T14] comments with @mentions notify participants, and history is complete and ordered', async () => {
    const task = await create(rahul, { title: 'Vendor KYC', assigneeIds: [stella.id, mike.id] });
    const body = `Please check this ${formatMention({ id: stella.id, displayName: stella.name })} and ${formatMention({ id: outsider.id, displayName: outsider.name })}`;
    const c = await env.req('POST', `/api/tasks/${task.id}/comments`, rahul.token, { body });
    expect(c.status).toBe(201);
    expect(c.body.comment.author.id).toBe(rahul.id);

    const stellaNotes = (await env.req('GET', '/api/notifications', stella.token)).body.notifications;
    expect(stellaNotes[0]).toMatchObject({ type: 'mentioned', taskId: task.id });
    const mikeNotes = (await env.req('GET', '/api/notifications', mike.token)).body.notifications;
    expect(mikeNotes[0]).toMatchObject({ type: 'commented', taskId: task.id });
    // mentioning a non-participant must not leak the task to them
    const outsiderNotes = (await env.req('GET', '/api/notifications', outsider.token)).body.notifications;
    expect(outsiderNotes.some((n: { taskId: string }) => n.taskId === task.id)).toBe(false);

    await env.req('POST', `/api/tasks/${task.id}/status`, stella.token, { status: 'in_progress' });
    await env.req('PATCH', `/api/tasks/${task.id}`, rahul.token, { priority: 'urgent', version: 2 });
    await env.req('POST', `/api/tasks/${task.id}/status`, mike.token, { status: 'completed' });

    const detail = (await env.req('GET', `/api/tasks/${task.id}`, stella.token)).body;
    expect(detail.comments).toHaveLength(1);
    expect(detail.task.commentCount).toBe(1);
    expect(detail.activity.map((a: { type: string }) => a.type)).toEqual([
      'created',
      'assigned',
      'assigned',
      'commented',
      'status_changed',
      'updated',
      'completed',
    ]);
    for (const a of detail.activity) expect(a.actor).toBeTruthy();

    const feed = (await env.req('GET', '/api/activity', mike.token)).body.activity;
    expect(feed[0]).toMatchObject({ type: 'completed', taskId: task.id, taskTitle: 'Vendor KYC' });
  });

  it('[T14] marks notifications read (own only) and respects notification preferences', async () => {
    const before = await env.req('GET', '/api/notifications', stella.token);
    expect(before.body.unreadCount).toBeGreaterThan(0);
    const one = before.body.notifications[0].id;
    // another user cannot mark Stella's notification
    await env.req('POST', '/api/notifications/read', mike.token, { ids: [one] });
    const still = (await env.req('GET', '/api/notifications?unread=true', stella.token)).body.notifications;
    expect(still.map((n: { id: string }) => n.id)).toContain(one);
    await env.req('POST', '/api/notifications/read', stella.token, { all: true });
    expect((await env.req('GET', '/api/notifications', stella.token)).body.unreadCount).toBe(0);

    await env.req('PUT', '/api/me/preferences', nina.token, { notifyAssigned: false });
    const prefs = await env.req('GET', '/api/me/preferences', nina.token);
    expect(prefs.body.preferences.notifyAssigned).toBe(false);
    const countBefore = (await env.req('GET', '/api/notifications', nina.token)).body.notifications.length;
    await create(rahul, { title: 'Muted assignment', assigneeIds: [nina.id] });
    expect((await env.req('GET', '/api/notifications', nina.token)).body.notifications.length).toBe(countBefore);
    await env.req('PUT', '/api/me/preferences', nina.token, { notifyAssigned: true });
  });
});

describe('Concurrency and idempotency', () => {
  it('[T16] concurrent edits: the second writer with a stale version gets 409 with the latest task', async () => {
    const task = await create(rahul, { title: 'Budget', assigneeIds: [stella.id] });
    const [a, b] = await Promise.all([
      env.req('PATCH', `/api/tasks/${task.id}`, rahul.token, { title: 'Budget v2', version: task.version }),
      env.req('PATCH', `/api/tasks/${task.id}`, rahul.token, { title: 'Budget v3', version: task.version }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('version_conflict');
    expect(loser.body.error.details.task.version).toBe(task.version + 1);
  });

  it('[T16] complete vs cancel race: exactly one wins and the loser gets a conflict', async () => {
    const task = await create(rahul, { title: 'Race me', assigneeIds: [stella.id] });
    const [complete, cancel] = await Promise.all([
      env.req('POST', `/api/tasks/${task.id}/status`, stella.token, { status: 'completed' }),
      env.req('POST', `/api/tasks/${task.id}/status`, rahul.token, { status: 'cancelled' }),
    ]);
    expect([complete.status, cancel.status].sort()).toEqual([200, 409]);
    const final = (await env.req('GET', `/api/tasks/${task.id}`, rahul.token)).body.task;
    expect(['completed', 'cancelled']).toContain(final.status);
  });

  it('[T16] many simultaneous completions produce exactly one completion record', async () => {
    const task = await create(rahul, { title: 'Everyone click done', assigneeIds: [stella.id, mike.id, nina.id] });
    const results = await Promise.all(
      [stella, mike, nina, stella, mike].map((u) => env.req('POST', `/api/tasks/${task.id}/status`, u.token, { status: 'completed' })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.changed)).toHaveLength(1);
    const detail = (await env.req('GET', `/api/tasks/${task.id}`, rahul.token)).body;
    expect(detail.activity.filter((a: { type: string }) => a.type === 'completed')).toHaveLength(1);
  });

  it('[T17] retried create with the same Idempotency-Key does not duplicate the task', async () => {
    const key = randomUUID();
    const first = await env.req('POST', '/api/tasks', rahul.token, { title: 'Retry-safe', assignToSelf: true }, { 'idempotency-key': key });
    const second = await env.req('POST', '/api/tasks', rahul.token, { title: 'Retry-safe', assignToSelf: true }, { 'idempotency-key': key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.task.id).toBe(first.body.task.id);
  });
});

describe('Permission boundaries', () => {
  it('[T18] non-participants cannot read or modify a task (404, no existence leak)', async () => {
    const task = await create(rahul, { title: 'Confidential payroll', assigneeIds: [stella.id] });
    const attempts = [
      ['GET', `/api/tasks/${task.id}`, undefined],
      ['PATCH', `/api/tasks/${task.id}`, { title: 'hacked', version: 1 }],
      ['POST', `/api/tasks/${task.id}/status`, { status: 'completed' }],
      ['POST', `/api/tasks/${task.id}/comments`, { body: 'hi' }],
      ['POST', `/api/tasks/${task.id}/reassign`, { toUserIds: [outsider.id] }],
      ['POST', `/api/tasks/${task.id}/assignees`, { userIds: [outsider.id] }],
      ['POST', `/api/tasks/${task.id}/decline`, {}],
    ] as const;
    for (const [method, url, body] of attempts) {
      const res = await env.req(method, url, outsider.token, body);
      expect(res.status, `${method} ${url}`).toBe(404);
    }
    const unknown = await env.req('GET', `/api/tasks/${randomUUID()}`, outsider.token);
    expect(unknown.status).toBe(404);
    expect(ids(await list(outsider, 'my'))).not.toContain(task.id);
    expect((await env.req('GET', '/api/activity', outsider.token)).body.activity.some((a: { taskId: string }) => a.taskId === task.id)).toBe(false);
    const after = (await env.req('GET', `/api/tasks/${task.id}`, rahul.token)).body.task;
    expect(after.title).toBe('Confidential payroll');
  });

  it('[T18] assignees cannot edit details; only the creator (or admin) can', async () => {
    const task = await create(rahul, { title: 'Original', assigneeIds: [stella.id] });
    const res = await env.req('PATCH', `/api/tasks/${task.id}`, stella.token, { title: 'Changed', version: task.version });
    expect(res.status).toBe(403);
    const admin = await env.admin();
    const byAdmin = await env.req('PATCH', `/api/tasks/${task.id}`, admin.token, { title: 'Admin fix', version: task.version });
    expect(byAdmin.status).toBe(200);
  });

  it('[T18] "tasks from this employee" only shows tasks shared with the viewer (admins see all)', async () => {
    const shared = await create(stella, { title: 'Stella to Mike', assigneeIds: [mike.id] });
    const mine = await create(stella, { title: 'Stella to Rahul', assigneeIds: [rahul.id] });
    const asMike = ids(await list(mike, 'involving', `&userId=${stella.id}`));
    expect(asMike).toContain(shared.id);
    expect(asMike).not.toContain(mine.id);
    const admin = await env.admin();
    const asAdmin = (await env.req('GET', `/api/tasks?view=involving&userId=${stella.id}`, admin.token)).body.tasks.map((t: Task) => t.id);
    expect(asAdmin).toEqual(expect.arrayContaining([shared.id, mine.id]));
    expect((await env.req('GET', '/api/tasks?view=all', mike.token)).status).toBe(403);
  });

  it('[T18] employee directory only exposes approved colleagues', async () => {
    const pending = await env.user('Hidden Pending', { approve: false });
    const dir = (await env.req('GET', '/api/users?q=hidden', rahul.token)).body.users;
    expect(dir).toHaveLength(0);
    expect((await env.req('GET', `/api/users/${pending.id}`, rahul.token)).status).toBe(404);
    const found = (await env.req('GET', '/api/users?q=stel', rahul.token)).body.users;
    expect(found.map((u: { id: string }) => u.id)).toEqual([stella.id]);
    // LIKE wildcards are escaped
    expect((await env.req('GET', '/api/users?q=%25', rahul.token)).body.users).toHaveLength(0);
  });

  it('rejects malformed ids and oversized payloads safely', async () => {
    expect((await env.req('GET', '/api/tasks/not-a-uuid', rahul.token)).status).toBe(400);
    const huge = await env.req('POST', '/api/tasks', rahul.token, { title: 'x', description: 'y'.repeat(300_000), assignToSelf: true });
    expect([400, 413]).toContain(huge.status);
    const sql = await env.req('GET', `/api/tasks?view=my'%20OR%201=1--`, rahul.token);
    expect(sql.status).toBe(400);
  });
});
