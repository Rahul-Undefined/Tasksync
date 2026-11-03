import { useSyncExternalStore } from 'react';
import type {
  NotificationItem,
  Preferences,
  RealtimeEvent,
  Task,
  TaskComment,
  TaskDetail,
  UserProfile,
  UserSummary,
} from '@tasksync/shared';
import { ApiError, del, errorMessage, get, patch, post, put } from './api';
import type { ConnectionStatus } from './realtime';
import { newer } from './views';
import { desktop } from './desktop';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  title: string;
  body?: string;
  taskId?: string | null;
}

export interface State {
  me: UserProfile | null;
  preferences: Preferences | null;
  tasks: Map<string, Task>;
  loaded: boolean;
  loadError: string | null;
  notifications: NotificationItem[];
  unreadCount: number;
  directory: UserSummary[];
  details: Map<string, TaskDetail>;
  connection: ConnectionStatus;
  serverWaking: boolean;
  queued: number;
  toasts: Toast[];
  openTaskId: string | null;
}

let state: State = {
  me: null,
  preferences: null,
  tasks: new Map(),
  loaded: false,
  loadError: null,
  notifications: [],
  unreadCount: 0,
  directory: [],
  details: new Map(),
  connection: 'idle',
  serverWaking: false,
  queued: 0,
  toasts: [],
  openTaskId: null,
};

const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
export const getState = () => state;
export function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

// ---------------------------------------------------------------------------
// Tasks map
// ---------------------------------------------------------------------------

export function upsertTasks(tasks: Task[]) {
  if (!tasks.length) return;
  const map = new Map(state.tasks);
  const details = new Map(state.details);
  for (const t of tasks) {
    const winner = newer(map.get(t.id), t);
    map.set(t.id, winner);
    const d = details.get(t.id);
    if (d) details.set(t.id, { ...d, task: winner });
  }
  set({ tasks: map, details });
}

export function setConnection(connection: ConnectionStatus) {
  set({ connection });
}
export function setServerWaking(serverWaking: boolean) {
  if (state.serverWaking !== serverWaking) set({ serverWaking });
}
export function setMe(me: UserProfile | null, preferences: Preferences | null = state.preferences) {
  set({ me, preferences });
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastSeq = 0;
export function toast(t: Omit<Toast, 'id'>, ms = 5000) {
  const id = ++toastSeq;
  set({ toasts: [...state.toasts.slice(-3), { ...t, id }] });
  setTimeout(() => dismissToast(id), ms);
}
export function dismissToast(id: number) {
  set({ toasts: state.toasts.filter((t) => t.id !== id) });
}
export function toastError(err: unknown, title = 'Could not complete that') {
  toast({ kind: 'error', title, body: errorMessage(err) }, 7000);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function loadAll() {
  try {
    const [my, assigned, completed, notes, dir] = await Promise.all([
      get<{ tasks: Task[] }>('/api/tasks?view=my'),
      get<{ tasks: Task[] }>('/api/tasks?view=assigned'),
      get<{ tasks: Task[] }>('/api/tasks?view=completed'),
      get<{ notifications: NotificationItem[]; unreadCount: number }>('/api/notifications?limit=50'),
      get<{ users: UserSummary[] }>('/api/users?limit=200'),
    ]);
    // A full reload replaces the map so tasks we lost access to disappear.
    const map = new Map<string, Task>();
    for (const t of [...my.tasks, ...assigned.tasks, ...completed.tasks]) map.set(t.id, newer(map.get(t.id), t));
    for (const [id, t] of state.tasks) if (state.details.has(id) && !map.has(id)) map.set(id, t);
    set({
      tasks: map,
      loaded: true,
      loadError: null,
      notifications: notes.notifications,
      unreadCount: notes.unreadCount,
      directory: dir.users,
    });
  } catch (err) {
    set({ loadError: errorMessage(err), loaded: state.loaded });
    throw err;
  }
}

export async function refreshDirectory() {
  const dir = await get<{ users: UserSummary[] }>('/api/users?limit=200');
  set({ directory: dir.users });
}

/** Server-side directory search (for colleagues not yet in the local cache). */
export async function searchDirectory(q: string): Promise<void> {
  const res = await get<{ users: UserSummary[] }>(`/api/users?q=${encodeURIComponent(q)}&limit=20`);
  const known = new Set(state.directory.map((u) => u.id));
  const fresh = res.users.filter((u) => !known.has(u.id));
  if (fresh.length) set({ directory: [...state.directory, ...fresh].sort((a, b) => a.displayName.localeCompare(b.displayName)) });
}

export async function loadDetail(taskId: string): Promise<TaskDetail> {
  const detail = await get<TaskDetail>(`/api/tasks/${taskId}`);
  const details = new Map(state.details);
  details.set(taskId, detail);
  set({ details });
  upsertTasks([detail.task]);
  return detail;
}

export function openTask(taskId: string | null) {
  set({ openTaskId: taskId });
  if (taskId) loadDetail(taskId).catch((err) => toastError(err, 'Could not open task'));
}

// ---------------------------------------------------------------------------
// Realtime events
// ---------------------------------------------------------------------------

export function applyEvent(event: RealtimeEvent) {
  switch (event.type) {
    case 'task.upsert':
      upsertTasks([event.data as Task]);
      break;
    case 'task.comment': {
      const c = event.data as TaskComment;
      const d = state.details.get(c.taskId);
      if (d && !d.comments.some((x) => x.id === c.id)) {
        const details = new Map(state.details);
        details.set(c.taskId, { ...d, comments: [...d.comments, c] });
        set({ details });
        // refresh history in the background so the timeline stays complete
        loadDetail(c.taskId).catch(() => undefined);
      }
      break;
    }
    case 'notification': {
      const n = event.data as NotificationItem;
      if (state.notifications.some((x) => x.id === n.id)) break;
      set({ notifications: [n, ...state.notifications].slice(0, 100), unreadCount: state.unreadCount + 1 });
      toast({ kind: 'info', title: n.title, body: n.body, taskId: n.taskId });
      if (state.preferences?.desktopToasts !== false) desktop.notify(n.title, n.body, n.taskId);
      if (state.openTaskId && n.taskId === state.openTaskId) loadDetail(n.taskId).catch(() => undefined);
      break;
    }
    case 'user.updated':
      onUserUpdated?.(event.data as { userId: string });
      break;
    case 'session.revoked':
      onUserUpdated?.({ userId: state.me?.id ?? '' });
      break;
  }
}

let onUserUpdated: ((d: { userId: string }) => void) | null = null;
export function setUserUpdatedHandler(fn: (d: { userId: string }) => void) {
  onUserUpdated = fn;
}

// ---------------------------------------------------------------------------
// Offline outbox: idempotent writes that failed for network reasons are retried
// automatically when the connection comes back.
// ---------------------------------------------------------------------------

interface QueuedOp {
  label: string;
  run: () => Promise<void>;
}
const outbox: QueuedOp[] = [];
let flushing = false;

function isNetworkError(err: unknown) {
  return err instanceof ApiError && err.code === 'network_error';
}

async function withOutbox(label: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    outbox.push({ label, run });
    set({ queued: outbox.length });
    toast({ kind: 'info', title: 'Saved offline', body: `“${label}” will sync when you're back online.` });
  }
}

export async function flushOutbox() {
  if (flushing || outbox.length === 0) return;
  flushing = true;
  try {
    while (outbox.length) {
      const op = outbox[0]!;
      try {
        await op.run();
      } catch (err) {
        if (isNetworkError(err)) break;
        toastError(err, `Could not sync “${op.label}”`);
      }
      outbox.shift();
      set({ queued: outbox.length });
    }
  } finally {
    flushing = false;
  }
}
if (typeof window !== 'undefined') window.addEventListener('online', () => void flushOutbox());

// ---------------------------------------------------------------------------
// Task actions
// ---------------------------------------------------------------------------

export interface NewTask {
  title: string;
  description?: string;
  priority?: Task['priority'];
  dueAt?: string | null;
  assigneeIds: string[];
  assignToSelf: boolean;
}

export async function createTask(input: NewTask): Promise<void> {
  const clientRequestId = crypto.randomUUID();
  await withOutbox(input.title, async () => {
    const res = await post<{ task: Task }>('/api/tasks', { ...input, clientRequestId }, { retry: true });
    upsertTasks([res.task]);
  });
}

export async function changeStatus(task: Task, status: 'pending' | 'in_progress' | 'completed' | 'cancelled', note?: string) {
  const previous = state.tasks.get(task.id) ?? task;
  // Optimistic: reflect the change immediately, roll back if the server refuses.
  upsertTasks([{ ...previous, status, updatedAt: new Date().toISOString() }]);
  try {
    await withOutbox(task.title, async () => {
      const res = await post<{ task: Task; changed: boolean }>(`/api/tasks/${task.id}/status`, { status, note }, { retry: true });
      forceTask(res.task);
    });
  } catch (err) {
    forceTask(previous);
    if (err instanceof ApiError && err.status === 409 && (err.details as { task?: Task })?.task) {
      forceTask((err.details as { task: Task }).task);
    }
    throw err;
  }
}

/** Replace a task even if the local copy looks newer (used to undo optimistic updates). */
function forceTask(t: Task) {
  const map = new Map(state.tasks);
  map.set(t.id, t);
  const details = new Map(state.details);
  const d = details.get(t.id);
  if (d) details.set(t.id, { ...d, task: t });
  set({ tasks: map, details });
}

export async function updateTask(task: Task, fields: Partial<Pick<Task, 'title' | 'description' | 'priority' | 'dueAt'>>) {
  try {
    const res = await patch<{ task: Task }>(`/api/tasks/${task.id}`, { ...fields, version: task.version });
    upsertTasks([res.task]);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'version_conflict') {
      const latest = (err.details as { task?: Task })?.task;
      if (latest) forceTask(latest);
    }
    throw err;
  }
}

async function taskCall(path: string, body?: unknown, method: 'POST' | 'DELETE' = 'POST') {
  const res = method === 'POST' ? await post<{ task: Task }>(path, body) : await del<{ task: Task }>(path);
  upsertTasks([res.task]);
  if (state.details.has(res.task.id)) loadDetail(res.task.id).catch(() => undefined);
  return res.task;
}

export const declineTask = (task: Task, reason?: string) => taskCall(`/api/tasks/${task.id}/decline`, { reason });
export const reassignTask = (task: Task, toUserIds: string[], note?: string, fromUserId?: string) =>
  taskCall(`/api/tasks/${task.id}/reassign`, { toUserIds, note, fromUserId });
export const addAssignees = (task: Task, userIds: string[]) => taskCall(`/api/tasks/${task.id}/assignees`, { userIds });
export const removeAssignee = (task: Task, userId: string) =>
  taskCall(`/api/tasks/${task.id}/assignees/${userId}`, undefined, 'DELETE');

export async function addComment(taskId: string, body: string) {
  const res = await post<{ comment: TaskComment }>(`/api/tasks/${taskId}/comments`, { body });
  const d = state.details.get(taskId);
  if (d && !d.comments.some((c) => c.id === res.comment.id)) {
    const details = new Map(state.details);
    details.set(taskId, { ...d, comments: [...d.comments, res.comment] });
    set({ details });
  }
  loadDetail(taskId).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Notifications & preferences
// ---------------------------------------------------------------------------

export async function markNotificationsRead(ids?: string[]) {
  const all = !ids;
  await post('/api/notifications/read', all ? { all: true } : { ids });
  const now = new Date().toISOString();
  const notifications = state.notifications.map((n) => (all || ids!.includes(n.id) ? { ...n, readAt: n.readAt ?? now } : n));
  set({ notifications, unreadCount: notifications.filter((n) => !n.readAt).length });
}

export async function savePreferences(p: Partial<Preferences>) {
  const res = await put<{ preferences: Preferences }>('/api/me/preferences', p);
  set({ preferences: res.preferences });
}

export async function saveProfile(p: Partial<Pick<UserProfile, 'jobTitle' | 'department' | 'officeLocation' | 'phone' | 'about'>>) {
  const res = await patch<{ user: UserProfile }>('/api/me/profile', p);
  set({ me: res.user });
}

export function resetStore() {
  set({
    me: null,
    preferences: null,
    tasks: new Map(),
    loaded: false,
    notifications: [],
    unreadCount: 0,
    directory: [],
    details: new Map(),
    openTaskId: null,
  });
}
