import { ACTIVE_STATUSES, compareTasksForList, type Task } from '@tasksync/shared';

// These mirror the server's list queries so a realtime update moves a task between
// tabs without a refetch (e.g. Stella completes → it leaves Rahul's "Assigned by Me").

export const isActiveAssignee = (t: Task, userId: string) =>
  t.assignees.some((a) => a.user.id === userId && a.status === 'active');

export function selectMy(tasks: Iterable<Task>, userId: string): Task[] {
  return [...tasks].filter((t) => ACTIVE_STATUSES.includes(t.status) && isActiveAssignee(t, userId)).sort(compareTasksForList);
}

export function selectAssigned(tasks: Iterable<Task>, userId: string): Task[] {
  return [...tasks]
    .filter(
      (t) =>
        t.createdBy.id === userId &&
        (ACTIVE_STATUSES.includes(t.status) || t.status === 'declined') &&
        t.assignees.some((a) => a.user.id !== userId),
    )
    .sort(compareTasksForList);
}

export function selectCompleted(tasks: Iterable<Task>, userId: string): Task[] {
  return [...tasks]
    .filter(
      (t) => (t.status === 'completed' || t.status === 'cancelled') && (t.createdBy.id === userId || isActiveAssignee(t, userId)),
    )
    .sort((a, b) => Date.parse(b.completedAt ?? b.cancelledAt ?? b.updatedAt) - Date.parse(a.completedAt ?? a.cancelledAt ?? a.updatedAt));
}

/** Returns the task that should win when two copies of the same task meet (stale-data guard). */
export function newer(current: Task | undefined, incoming: Task): Task {
  if (!current) return incoming;
  if (incoming.version > current.version) return incoming;
  if (incoming.version < current.version) return current;
  return Date.parse(incoming.updatedAt) >= Date.parse(current.updatedAt) ? incoming : current;
}

export type DueBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';

export function dueBucket(t: Task, now = new Date()): DueBucket {
  if (!t.dueAt) return 'none';
  const due = new Date(t.dueAt);
  if (due.getTime() < now.getTime()) return 'overdue';
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  if (due <= endOfToday) return 'today';
  const endOfWeek = new Date(endOfToday);
  endOfWeek.setDate(endOfWeek.getDate() + 6);
  return due <= endOfWeek ? 'week' : 'later';
}

export const BUCKET_LABELS: Record<DueBucket, string> = {
  overdue: 'Overdue',
  today: 'Due today',
  week: 'This week',
  later: 'Later',
  none: 'No due date',
};
