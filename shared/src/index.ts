// Domain vocabulary shared by the TaskSync API, web dashboard and desktop widget.
// Keep this file free of runtime dependencies so it can be bundled anywhere.

export const TASK_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
  'declined',
  'reassigned',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses where work is still expected. Tasks in these states appear in active lists. */
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'reassigned'];
/** Statuses that close a task for every participant. */
export const CLOSED_STATUSES: readonly TaskStatus[] = ['completed', 'cancelled'];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  declined: 'Declined',
  reassigned: 'Reassigned',
};

export const STATUS_DESCRIPTIONS: Record<TaskStatus, string> = {
  pending: 'Assigned and waiting to be started.',
  in_progress: 'An assignee is working on it.',
  completed: 'Work is finished. Completed for every participant.',
  cancelled: 'The creator cancelled the task.',
  declined: 'Every assignee declined or was removed. The creator needs to reassign or cancel it.',
  reassigned: 'Ownership changed. Waiting for the new assignee to start.',
};

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};
export const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export const ASSIGNMENT_STATUSES = ['active', 'declined', 'removed', 'reassigned'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const USER_ROLES = ['admin', 'employee'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['pending', 'approved', 'rejected', 'deactivated'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ACTIVITY_TYPES = [
  'created',
  'self_assigned',
  'assigned',
  'unassigned',
  'declined',
  'reassigned',
  'status_changed',
  'completed',
  'cancelled',
  'reopened',
  'updated',
  'commented',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const NOTIFICATION_TYPES = [
  'assigned',
  'mentioned',
  'status_changed',
  'completed',
  'cancelled',
  'declined',
  'reassigned',
  'unassigned',
  'commented',
  'account',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const TASK_LIMITS = {
  titleMax: 200,
  descriptionMax: 5000,
  commentMax: 4000,
  noteMax: 500,
  maxAssignees: 25,
} as const;

// ---------------------------------------------------------------------------
// DTOs returned by the API
// ---------------------------------------------------------------------------

export interface UserSummary {
  id: string;
  displayName: string;
  email: string;
  jobTitle: string | null;
  department: string | null;
}

export interface UserProfile extends UserSummary {
  role: UserRole;
  status: UserStatus;
  officeLocation: string | null;
  phone: string | null;
  about: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface Preferences {
  notifyAssigned: boolean;
  notifyStatus: boolean;
  notifyComments: boolean;
  desktopToasts: boolean;
  widgetCompact: boolean;
}

export interface TaskAssignee {
  assignmentId: string;
  user: UserSummary;
  status: AssignmentStatus;
  assignedAt: string;
  assignedById: string;
  endedAt: string | null;
  note: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  status: TaskStatus;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  createdBy: UserSummary;
  completedAt: string | null;
  completedBy: UserSummary | null;
  cancelledAt: string | null;
  cancelledBy: UserSummary | null;
  assignees: TaskAssignee[];
  commentCount: number;
}

export interface TaskComment {
  id: string;
  taskId: string;
  author: UserSummary;
  body: string;
  createdAt: string;
}

export interface TaskActivity {
  id: number;
  taskId: string;
  taskTitle?: string;
  actor: UserSummary | null;
  type: ActivityType;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface TaskDetail {
  task: Task;
  comments: TaskComment[];
  activity: TaskActivity[];
}

export interface NotificationItem {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  taskId: string | null;
  actor: UserSummary | null;
  readAt: string | null;
  createdAt: string;
}

export type TaskView = 'my' | 'assigned' | 'completed' | 'involving' | 'all';

// ---------------------------------------------------------------------------
// Realtime protocol
// ---------------------------------------------------------------------------

export type RealtimeEventType =
  | 'task.upsert'
  | 'task.comment'
  | 'notification'
  | 'user.updated'
  | 'session.revoked';

export interface RealtimeEvent<T = unknown> {
  /** Monotonic per-deployment id. Clients persist the highest id they have applied. */
  id: number;
  type: RealtimeEventType;
  taskId: string | null;
  data: T;
  createdAt: string;
}

export type ClientMessage =
  | { type: 'auth'; token: string; since?: number }
  | { type: 'ping'; t?: number };

export type ServerMessage =
  | { type: 'ready'; userId: string; lastEventId: number; replayed: number }
  | { type: 'event'; event: RealtimeEvent }
  | { type: 'resync'; reason: string; lastEventId: number }
  | { type: 'pong'; t?: number }
  | { type: 'error'; code: string; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isActiveStatus(status: TaskStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/**
 * Mentions are stored inline as `@[Display Name](user-uuid)` so the text stays readable
 * when exported while still carrying an unambiguous user id.
 */
export const MENTION_PATTERN =
  /@\[([^\]\n]{1,200})\]\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

export function extractMentionIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    if (match[2]) ids.add(match[2].toLowerCase());
  }
  return [...ids];
}

export function formatMention(user: Pick<UserSummary, 'id' | 'displayName'>): string {
  const safeName = user.displayName.replace(/[\[\]\n]/g, '').trim() || 'user';
  return `@[${safeName}](${user.id})`;
}

/** Replace mention tokens with plain `@Name` text (used for notifications and images). */
export function mentionsToPlainText(text: string): string {
  return text.replace(MENTION_PATTERN, (_m, name: string) => `@${name}`);
}

export interface TeamsChatLinkOptions {
  /** Recipient UPN / email address. */
  email: string;
  /** Optional prefilled message. Teams lets the user edit it before sending. */
  message?: string;
  /** Use the `msteams:` protocol to open the desktop client directly. */
  protocol?: 'https' | 'msteams';
}

/**
 * Builds a Microsoft Teams one-to-one chat deep link.
 * Teams deep links can prefill text but cannot attach files or images, so the
 * TaskSync workflow copies a PNG to the clipboard for the user to paste.
 */
export function buildTeamsChatLink({ email, message, protocol = 'https' }: TeamsChatLinkOptions): string {
  const cleanEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error('A valid email address is required to open a Teams chat');
  }
  if (!/^[a-z0-9._%+'-]+@[a-z0-9.-]+$/.test(cleanEmail)) {
    throw new Error('Unsupported characters in email address');
  }
  // encodeURIComponent (not URLSearchParams) so spaces become %20; Teams shows "+" literally.
  let query = `users=${cleanEmail}`;
  if (message) query += `&message=${encodeURIComponent(message.slice(0, 1000))}`;
  const base = protocol === 'msteams' ? 'msteams:/l/chat/0/0' : 'https://teams.microsoft.com/l/chat/0/0';
  return `${base}?${query}`;
}

/** Sort comparator: overdue and urgent first, then due date, then newest. */
export function compareTasksForList(a: Task, b: Task): number {
  const ad = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
  const bd = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
  const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (ad !== bd) return ad - bd;
  if (pr !== 0) return pr;
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}
