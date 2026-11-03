import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context.js';
import {
  activityQuery,
  assigneesBody,
  commentBody,
  createTaskBody,
  declineBody,
  idParams,
  idUserParams,
  listTasksQuery,
  parse,
  reassignBody,
  statusBody,
  updateTaskBody,
} from '../http/validate.js';
import {
  addAssignees,
  addComment,
  changeStatus,
  createTask,
  declineAssignment,
  getTaskDetail,
  listActivity,
  listTasks,
  reassignTask,
  removeAssignee,
  updateTask,
} from '../services/tasks.js';

const WRITE_LIMIT = { rateLimit: { max: 90, timeWindow: '1 minute' } };

export async function taskRoutes(app: FastifyInstance, { auth, db, mutate }: RouteContext): Promise<void> {
  app.get('/api/tasks', async (req) => {
    const { actor } = await auth.requireUser(req);
    const query = parse(listTasksQuery, req.query);
    return { tasks: await listTasks(db(), actor, query.view, { userId: query.userId, limit: query.limit }) };
  });

  app.post('/api/tasks', { config: WRITE_LIMIT }, async (req, reply) => {
    const { actor } = await auth.requireUser(req);
    const body = parse(createTaskBody, req.body);
    const idempotencyKey = req.headers['idempotency-key'];
    const clientRequestId =
      body.clientRequestId ?? (typeof idempotencyKey === 'string' ? parse(idParams, { id: idempotencyKey }).id : undefined);
    const result = await mutate((q, outbox) => createTask(q, outbox, actor, { ...body, clientRequestId }));
    reply.code(result.created ? 201 : 200);
    return { task: result.task, created: result.created };
  });

  app.get('/api/tasks/:id', async (req) => {
    const { actor } = await auth.requireUser(req);
    const { id } = parse(idParams, req.params);
    return getTaskDetail(db(), actor, id);
  });

  app.patch('/api/tasks/:id', { config: WRITE_LIMIT }, async (req) => {
    const { actor } = await auth.requireUser(req);
    const { id } = parse(idParams, req.params);
    const { version, ...patch } = parse(updateTaskBody, req.body);
    return { task: await mutate((q, o) => updateTask(q, o, actor, id, patch, version)) };
  });

  app.post('/api/tasks/:id/status', { config: WRITE_LIMIT }, async (req) => {
    const { actor } = await auth.requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(statusBody, req.body);
    return mutate((q, o) => changeStatus(q, o, actor, id, body.status, body.note));
  });

  app.post('/api/tasks/:id/decline', { config: WRITE_LIMIT }, async (req) => {
    const { actor } = await auth.requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(declineBody, req.body);
    return { task: await mutate((q, o) => declineAssignment(q, o, actor, id, body.reason)) };
  });

  app.post('/api/tasks/:id/assignees', { config: WRITE_LIMIT }, async (req) => {
    const { actor } = await auth.requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(assigneesBody, req.body);
    return { task: await mutate((q, o) => addAssignees(q, o, actor, id, body.userIds)) };
  });

  app.delete('/api/tasks/:id/assignees/:userId', { config: WRITE_LIMIT }, async (req) => {
    const { actor } = await auth.requireUser(req);
    const { id, userId } = parse(idUserParams, req.params);
    return { task: await mutate((q, o) => removeAssignee(q, o, actor, id, userId)) };
  });

  app.post('/api/tasks/:id/reassign', { config: WRITE_LIMIT }, async (req) => {
    const { actor } = await auth.requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(reassignBody, req.body);
    return { task: await mutate((q, o) => reassignTask(q, o, actor, id, body)) };
  });

  app.post('/api/tasks/:id/comments', { config: WRITE_LIMIT }, async (req, reply) => {
    const { actor } = await auth.requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(commentBody, req.body);
    reply.code(201);
    return { comment: await mutate((q, o) => addComment(q, o, actor, id, body.body)) };
  });

  app.get('/api/activity', async (req) => {
    const { actor } = await auth.requireUser(req);
    const query = parse(activityQuery, req.query);
    return { activity: await listActivity(db(), actor, query) };
  });
}
