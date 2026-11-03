import { memo, useState } from 'react';
import { isActiveStatus, mentionsToPlainText, type Task } from '@tasksync/shared';
import { CalendarClock, Check, ChevronRight, MessageSquare, Play } from 'lucide-react';
import { formatDue, relativeTime } from '../lib/format';
import { changeStatus, openTask, toast, toastError } from '../lib/store';
import { useSurface } from '../lib/surface';
import { PersonLink } from './PersonMenu';
import { Avatar, PriorityBadge, StatusBadge } from './ui';

interface Props {
  task: Task;
  meId: string;
  compact?: boolean;
  /** Which relationship to emphasise in the meta line. */
  perspective?: 'assignee' | 'creator' | 'any';
}

export const TaskCard = memo(function TaskCard({ task, meId, compact, perspective = 'any' }: Props) {
  const [busy, setBusy] = useState(false);
  const surface = useSurface();
  const open_ = () => {
    openTask(task.id);
    if (surface === 'pip') window.focus(); // details open in the dashboard window
  };
  const active = task.assignees.filter((a) => a.status === 'active');
  const amAssignee = active.some((a) => a.user.id === meId);
  const amCreator = task.createdBy.id === meId;
  const open = isActiveStatus(task.status);
  const closed = task.status === 'completed' || task.status === 'cancelled';
  const overdue = open && task.dueAt && Date.parse(task.dueAt) < Date.now();
  const canComplete = open && (amAssignee || amCreator);
  const canReopen = task.status === 'completed' && (amAssignee || amCreator);

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      if (canComplete) {
        await changeStatus(task, 'completed');
        toast({ kind: 'success', title: 'Task completed', body: `“${task.title}” is now completed for everyone on it.` }, 3500);
      } else if (canReopen) {
        await changeStatus(task, 'pending');
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const start = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await changeStatus(task, 'in_progress');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      className={`task-card glass ${closed ? 'closed' : ''}`}
      tabIndex={0}
      onClick={open_}
      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && open_()}
      aria-label={task.title}
    >
      <button
        type="button"
        className={`check ${task.status === 'completed' ? 'done' : ''}`}
        onClick={toggle}
        disabled={busy || (!canComplete && !canReopen)}
        aria-label={task.status === 'completed' ? 'Reopen task' : 'Mark as completed'}
        title={task.status === 'completed' ? 'Completed — click to reopen' : canComplete ? 'Mark as completed' : undefined}
      >
        <Check size={15} strokeWidth={3} />
      </button>

      <div style={{ minWidth: 0 }}>
        <div className={`title ${task.status}`}>{task.title}</div>
        {!compact && task.description && <div className="desc">{mentionsToPlainText(task.description)}</div>}
        <div className="meta">
          {task.status !== 'pending' && <StatusBadge status={task.status} />}
          {task.priority !== 'medium' && <PriorityBadge priority={task.priority} />}
          {task.dueAt && (
            <span className={`row ${overdue ? 'overdue' : ''}`} style={{ gap: 4 }}>
              <CalendarClock size={13} /> {overdue ? `Overdue · ${formatDue(task.dueAt)}` : formatDue(task.dueAt)}
            </span>
          )}
          {perspective !== 'creator' && !amCreator && (
            <span>
              from <PersonLink user={task.createdBy} task={task} />
            </span>
          )}
          {perspective !== 'assignee' && active.length > 0 && !(active.length === 1 && active[0]!.user.id === meId) && (
            <span className="row" style={{ gap: 6 }}>
              to{' '}
              {active.slice(0, compact ? 1 : 3).map((a, i) => (
                <span key={a.assignmentId}>
                  {i > 0 && ', '}
                  <PersonLink user={a.user} task={task} />
                </span>
              ))}
              {active.length > (compact ? 1 : 3) && <span>+{active.length - (compact ? 1 : 3)}</span>}
            </span>
          )}
          {task.status === 'completed' && task.completedBy && (
            <span>
              completed by {task.completedBy.id === meId ? 'you' : task.completedBy.displayName} {relativeTime(task.completedAt!)}
            </span>
          )}
          {task.status === 'cancelled' && task.cancelledBy && <span>cancelled {relativeTime(task.cancelledAt!)}</span>}
          {task.commentCount > 0 && (
            <span className="row" style={{ gap: 4 }}>
              <MessageSquare size={13} /> {task.commentCount}
            </span>
          )}
        </div>
      </div>

      <div className="row card-actions" style={{ gap: 6 }}>
        {!compact && (
          <div className="avatar-stack hide-mobile">
            {active.slice(0, 3).map((a) => (
              <Avatar key={a.assignmentId} id={a.user.id} name={a.user.displayName} size="sm" />
            ))}
          </div>
        )}
        {amAssignee && (task.status === 'pending' || task.status === 'reassigned') && (
          <button className="btn btn-sm" onClick={start} disabled={busy} title="Mark as in progress">
            <Play size={13} /> {compact ? '' : 'Start'}
          </button>
        )}
        <ChevronRight size={18} className="faint hide-mobile" />
      </div>
    </article>
  );
});
