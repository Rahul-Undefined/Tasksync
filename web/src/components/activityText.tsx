import { STATUS_LABELS, type TaskActivity, type TaskStatus } from '@tasksync/shared';
import { ArrowRightLeft, Ban, CheckCircle2, CircleDot, MessageSquare, Pencil, PlusCircle, RotateCcw, UserMinus, UserPlus, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';

type Ref = { id: string; name: string };
const names = (list: unknown) => (Array.isArray(list) ? (list as Ref[]).map((r) => r.name).join(', ') : '');

export function activityIcon(type: TaskActivity['type']): ReactNode {
  const s = 13;
  switch (type) {
    case 'created':
      return <PlusCircle size={s} />;
    case 'self_assigned':
    case 'assigned':
      return <UserPlus size={s} />;
    case 'unassigned':
      return <UserMinus size={s} />;
    case 'declined':
      return <XCircle size={s} />;
    case 'reassigned':
      return <ArrowRightLeft size={s} />;
    case 'completed':
      return <CheckCircle2 size={s} color="#34d399" />;
    case 'cancelled':
      return <Ban size={s} color="#f87171" />;
    case 'reopened':
      return <RotateCcw size={s} />;
    case 'updated':
      return <Pencil size={s} />;
    case 'commented':
      return <MessageSquare size={s} />;
    default:
      return <CircleDot size={s} />;
  }
}

/** Human sentence for an activity entry, e.g. "Stella completed the task". */
export function activityText(a: TaskActivity, meId: string | undefined, withTitle = false): string {
  const who = a.actor ? (a.actor.id === meId ? 'You' : a.actor.displayName) : 'Someone';
  const d = a.data as Record<string, unknown>;
  const t = withTitle && a.taskTitle ? ` “${a.taskTitle}”` : '';
  const assignee = (d.assignee as Ref | undefined)?.name ?? 'someone';
  switch (a.type) {
    case 'created':
      return `${who} created${t || ' the task'}`;
    case 'self_assigned':
      return `${who} assigned${t || ' it'} to themselves`;
    case 'assigned':
      return `${who} assigned${t || ' it'} to ${assignee}`;
    case 'unassigned':
      return `${who} removed ${assignee} from${t || ' the task'}`;
    case 'declined':
      return `${who} declined${t || ' the task'}${d.reason ? `: “${String(d.reason)}”` : ''}`;
    case 'reassigned':
      return `${who} reassigned${t || ' it'}${names(d.from) ? ` from ${names(d.from)}` : ''} to ${names(d.to)}${d.note ? ` — “${String(d.note)}”` : ''}`;
    case 'completed':
      return `${who} completed${t || ' the task'}`;
    case 'cancelled':
      return `${who} cancelled${t || ' the task'}${d.note ? `: “${String(d.note)}”` : ''}`;
    case 'reopened':
      return `${who} reopened${t || ' the task'}`;
    case 'status_changed':
      return `${who} moved${t || ' it'} to ${STATUS_LABELS[(d.to as TaskStatus) ?? 'pending'] ?? String(d.to)}`;
    case 'updated': {
      const fields = Object.keys((d.changes as Record<string, unknown>) ?? {}).map((f) => (f === 'dueAt' ? 'due date' : f));
      return `${who} edited ${fields.join(', ') || 'details'}${t ? ` of${t}` : ''}`;
    }
    case 'commented':
      return `${who} commented${t ? ` on${t}` : ''}${d.excerpt ? `: “${String(d.excerpt)}”` : ''}`;
    default:
      return `${who} updated${t || ' the task'}`;
  }
}
