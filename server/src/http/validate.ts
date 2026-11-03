import { z } from 'zod';
import { PRIORITIES, TASK_LIMITS } from '@tasksync/shared';
import { badRequest } from '../lib/errors.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    throw badRequest(
      'Invalid request',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

const guid = z.guid().transform((v) => v.toLowerCase());
const optionalText = (max: number) => z.string().max(max).optional();
const nullableText = (max: number) => z.string().max(max).nullable().optional();

export const idParams = z.object({ id: guid });
export const idUserParams = z.object({ id: guid, userId: guid });

export const createTaskBody = z.object({
  title: z.string().trim().min(1, 'Title is required').max(TASK_LIMITS.titleMax),
  description: optionalText(TASK_LIMITS.descriptionMax),
  priority: z.enum(PRIORITIES).optional(),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  assigneeIds: z.array(guid).max(TASK_LIMITS.maxAssignees).optional(),
  assignToSelf: z.boolean().optional(),
  clientRequestId: guid.optional(),
});

export const updateTaskBody = z.object({
  title: z.string().trim().min(1).max(TASK_LIMITS.titleMax).optional(),
  description: optionalText(TASK_LIMITS.descriptionMax),
  priority: z.enum(PRIORITIES).optional(),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  version: z.number().int().positive(),
});

export const statusBody = z.object({
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  note: optionalText(TASK_LIMITS.noteMax),
});

export const declineBody = z.object({ reason: optionalText(TASK_LIMITS.noteMax) });

export const assigneesBody = z.object({ userIds: z.array(guid).min(1).max(TASK_LIMITS.maxAssignees) });

export const reassignBody = z.object({
  fromUserId: guid.optional(),
  toUserIds: z.array(guid).min(1).max(TASK_LIMITS.maxAssignees),
  note: optionalText(TASK_LIMITS.noteMax),
});

export const commentBody = z.object({ body: z.string().trim().min(1).max(TASK_LIMITS.commentMax) });

export const listTasksQuery = z.object({
  view: z.enum(['my', 'assigned', 'completed', 'involving', 'all']).default('my'),
  userId: guid.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const activityQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const notificationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  unread: z.enum(['true', 'false']).optional(),
});

export const markReadBody = z.object({
  ids: z.array(guid).max(200).optional(),
  all: z.boolean().optional(),
});

export const eventsQuery = z.object({ since: z.coerce.number().int().min(0).default(0) });

export const directoryQuery = z.object({
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const profileBody = z.object({
  jobTitle: nullableText(120),
  department: nullableText(120),
  officeLocation: nullableText(120),
  phone: nullableText(40),
  about: nullableText(500),
});

export const preferencesBody = z.object({
  notifyAssigned: z.boolean().optional(),
  notifyStatus: z.boolean().optional(),
  notifyComments: z.boolean().optional(),
  desktopToasts: z.boolean().optional(),
  widgetCompact: z.boolean().optional(),
});

export const adminUsersQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'deactivated']).optional(),
});

export const adminReasonBody = z.object({ reason: optionalText(500) });
export const adminRoleBody = z.object({ role: z.enum(['admin', 'employee']) });

export const devTokenBody = z.object({
  email: z.email().max(200),
  name: z.string().trim().min(1).max(200),
});
