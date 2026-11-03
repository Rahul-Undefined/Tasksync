import { useEffect, useMemo, useState } from 'react';
import {
  formatMention,
  isActiveStatus,
  MENTION_PATTERN,
  PRIORITIES,
  PRIORITY_LABELS,
  type Priority,
  type Task,
  type UserSummary,
} from '@tasksync/shared';
import {
  ArrowRightLeft,
  Ban,
  Check,
  Clock3,
  MessageSquareShare,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Send,
  UserMinus,
  UserPlus,
  X,
  XCircle,
} from 'lucide-react';
import { formatDateTime, formatDue, fromLocalInput, relativeTime, toLocalInput } from '../lib/format';
import {
  addAssignees,
  addComment,
  changeStatus,
  declineTask,
  openTask,
  reassignTask,
  removeAssignee,
  toast,
  toastError,
  updateTask,
  useStore,
} from '../lib/store';
import { activityIcon, activityText } from './activityText';
import { MentionInput } from './MentionInput';
import { PeoplePicker } from './PeoplePicker';
import { PersonLink, startTeamsMessage } from './PersonMenu';
import { Avatar, Modal, PriorityBadge, Spinner, StatusBadge } from './ui';

type Dialog = null | 'reassign' | 'add' | 'decline' | 'cancel' | 'handover';

export function TaskDrawer() {
  const taskId = useStore((s) => s.openTaskId);
  const detail = useStore((s) => (taskId ? s.details.get(taskId) : undefined));
  const task = useStore((s) => (taskId ? s.tasks.get(taskId) : undefined)) ?? detail?.task;
  const me = useStore((s) => s.me);
  const [dialog, setDialog] = useState<Dialog>(null);

  useEffect(() => {
    if (!taskId) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !dialog && openTask(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [taskId, dialog]);

  if (!taskId) return null;
  return (
    <>
      <div className="scrim" onClick={() => openTask(null)} />
      <aside className="drawer glass glass-strong" role="dialog" aria-modal="true" aria-label="Task details">
        {!task || !me ? (
          <div className="center-screen">
            <Spinner />
          </div>
        ) : (
          <DrawerContent task={task} meId={me.id} isAdmin={me.role === 'admin'} setDialog={setDialog} />
        )}
      </aside>
      {task && dialog && <TaskDialog kind={dialog} task={task} meId={me!.id} onClose={() => setDialog(null)} />}
    </>
  );
}

function DrawerContent({ task, meId, isAdmin, setDialog }: { task: Task; meId: string; isAdmin: boolean; setDialog: (d: Dialog) => void }) {
  const detail = useStore((s) => s.details.get(task.id));
  const active = task.assignees.filter((a) => a.status === 'active');
  const past = task.assignees.filter((a) => a.status !== 'active');
  const amAssignee = active.some((a) => a.user.id === meId);
  const amCreator = task.createdBy.id === meId;
  const canManage = amCreator || isAdmin;
  const open = isActiveStatus(task.status);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await fn();
      if (success) toast({ kind: 'success', title: success }, 3000);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="drawer-head">
        <div className="col" style={{ flex: 1, minWidth: 0, gap: 8 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            <StatusBadge status={task.status} />
            <PriorityBadge priority={task.priority} />
            {task.dueAt && (
              <span className={`badge plain ${open && Date.parse(task.dueAt) < Date.now() ? 'p-urgent' : 'p-low'}`}>
                <Clock3 size={11} /> {formatDue(task.dueAt)}
              </span>
            )}
          </div>
          {editing ? (
            <EditForm task={task} onDone={() => setEditing(false)} />
          ) : (
            <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 21, lineHeight: 1.3, overflowWrap: 'anywhere' }}>{task.title}</h2>
          )}
        </div>
        {canManage && open && !editing && (
          <button className="icon-btn" onClick={() => setEditing(true)} aria-label="Edit task" title="Edit">
            <Pencil size={17} />
          </button>
        )}
        <button className="icon-btn" onClick={() => openTask(null)} aria-label="Close">
          <X size={19} />
        </button>
      </header>

      <div className="drawer-body">
        {/* Primary actions depend on the viewer's relationship to the task */}
        <div className="row wrap" style={{ gap: 8 }}>
          {open && (amAssignee || canManage) && (
            <button className="btn btn-success" disabled={busy} onClick={() => run(() => changeStatus(task, 'completed'), 'Completed for everyone')}>
              <Check size={16} /> Complete
            </button>
          )}
          {open && amAssignee && task.status !== 'in_progress' && (
            <button className="btn" disabled={busy} onClick={() => run(() => changeStatus(task, 'in_progress'))}>
              <Play size={15} /> Start
            </button>
          )}
          {task.status === 'in_progress' && (amAssignee || canManage) && (
            <button className="btn" disabled={busy} onClick={() => run(() => changeStatus(task, 'pending'))}>
              <Pause size={15} /> Pause
            </button>
          )}
          {open && amAssignee && !canManage && (
            <button className="btn" disabled={busy} onClick={() => setDialog('handover')}>
              <ArrowRightLeft size={15} /> Hand over
            </button>
          )}
          {(open || task.status === 'declined') && canManage && (
            <button className="btn" disabled={busy} onClick={() => setDialog('reassign')}>
              <ArrowRightLeft size={15} /> Reassign
            </button>
          )}
          {(open || task.status === 'declined') && canManage && (
            <button className="btn" disabled={busy} onClick={() => setDialog('add')}>
              <UserPlus size={15} /> Add people
            </button>
          )}
          {open && amAssignee && (
            <button className="btn" disabled={busy} onClick={() => setDialog('decline')}>
              <XCircle size={15} /> Decline
            </button>
          )}
          {task.status === 'completed' && (amAssignee || canManage) && (
            <button className="btn" disabled={busy} onClick={() => run(() => changeStatus(task, 'pending'), 'Task reopened')}>
              <RotateCcw size={15} /> Reopen
            </button>
          )}
          {task.status === 'cancelled' && canManage && (
            <button className="btn" disabled={busy} onClick={() => run(() => changeStatus(task, 'pending'), 'Task restored')}>
              <RotateCcw size={15} /> Restore
            </button>
          )}
          {(open || task.status === 'declined') && canManage && (
            <button className="btn btn-danger" disabled={busy} onClick={() => setDialog('cancel')}>
              <Ban size={15} /> Cancel task
            </button>
          )}
        </div>

        {task.status === 'declined' && canManage && (
          <div className="banner glass warn">Everyone declined this task. Reassign it or cancel it.</div>
        )}

        <section>
          <div className="kv">
            <span className="k">Created by</span>
            <span className="row" style={{ gap: 8 }}>
              <Avatar id={task.createdBy.id} name={task.createdBy.displayName} size="sm" />
              <PersonLink user={task.createdBy} task={task} />
              <span className="faint small">{relativeTime(task.createdAt)}</span>
            </span>
            <span className="k">Assigned to</span>
            <span className="col" style={{ gap: 6 }}>
              {active.length === 0 && <span className="faint">Nobody</span>}
              {active.map((a) => (
                <span key={a.assignmentId} className="row" style={{ gap: 8 }}>
                  <Avatar id={a.user.id} name={a.user.displayName} size="sm" />
                  <PersonLink user={a.user} task={task} />
                  {a.user.id === meId && <span className="faint small">(you)</span>}
                  <span className="spacer" />
                  {a.user.id !== meId && (
                    <button className="icon-btn" title={`Message ${a.user.displayName} in Teams`} onClick={() => startTeamsMessage(a.user, task)}>
                      <MessageSquareShare size={15} />
                    </button>
                  )}
                  {canManage && open && active.length > 1 && (
                    <button className="icon-btn" title="Remove from task" onClick={() => run(() => removeAssignee(task, a.user.id), `${a.user.displayName} removed`)}>
                      <UserMinus size={15} />
                    </button>
                  )}
                </span>
              ))}
            </span>
            {past.length > 0 && (
              <>
                <span className="k">Previously</span>
                <span className="small muted">
                  {past.map((a, i) => (
                    <span key={a.assignmentId}>
                      {i > 0 && ' · '}
                      {a.user.displayName} <span className="faint">({a.status})</span>
                    </span>
                  ))}
                </span>
              </>
            )}
            {task.completedBy && task.completedAt && (
              <>
                <span className="k">Completed</span>
                <span>
                  by {task.completedBy.id === meId ? 'you' : task.completedBy.displayName} · {formatDateTime(task.completedAt)}
                </span>
              </>
            )}
            {task.cancelledBy && task.cancelledAt && (
              <>
                <span className="k">Cancelled</span>
                <span>
                  by {task.cancelledBy.displayName} · {formatDateTime(task.cancelledAt)}
                </span>
              </>
            )}
          </div>
        </section>

        {task.description && (
          <section>
            <div className="block-title">Description</div>
            <div className="comment-body muted">
              <RichText text={task.description} />
            </div>
          </section>
        )}

        <section>
          <div className="block-title">Comments {detail ? `(${detail.comments.length})` : ''}</div>
          {!detail && <div className="skeleton" />}
          <div className="col" style={{ gap: 10 }}>
            {detail?.comments.map((c) => (
              <div key={c.id} className="comment">
                <div className="row" style={{ gap: 8 }}>
                  <Avatar id={c.author.id} name={c.author.displayName} size="sm" />
                  <PersonLink user={c.author} task={task} />
                  <span className="faint small">{relativeTime(c.createdAt)}</span>
                </div>
                <div className="comment-body">
                  <RichText text={c.body} />
                </div>
              </div>
            ))}
          </div>
          <CommentBox task={task} meId={meId} />
        </section>

        <section>
          <div className="block-title">History</div>
          <div className="timeline">
            {detail?.activity.map((a) => (
              <div key={a.id} className="tl-item">
                <span className="tl-icon">{activityIcon(a.type)}</span>
                <span className="small">
                  {activityText(a, meId)}
                  <span className="faint" title={formatDateTime(a.createdAt)}>
                    {' '}
                    · {relativeTime(a.createdAt)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

/** Renders text with @[Name](id) mention tokens as highlighted names. */
function RichText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(MENTION_PATTERN.source, 'gi'))) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push(
      <span key={m.index} className="mention">
        @{m[1]}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function CommentBox({ task, meId }: { task: Task; meId: string }) {
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<UserSummary[]>([]);
  const [busy, setBusy] = useState(false);
  // Only people on the task can be mentioned (the server enforces the same rule).
  const people = useMemo(() => {
    const map = new Map<string, UserSummary>();
    map.set(task.createdBy.id, task.createdBy);
    for (const a of task.assignees) map.set(a.user.id, a.user);
    map.delete(meId);
    return [...map.values()];
  }, [task, meId]);

  const submit = async () => {
    let body = text.trim();
    if (!body || busy) return;
    for (const m of mentions) body = body.replace(`@${m.displayName}`, formatMention(m));
    setBusy(true);
    try {
      await addComment(task.id, body);
      setText('');
      setMentions([]);
    } catch (err) {
      toastError(err, 'Comment not posted');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col" style={{ gap: 8, marginTop: 10 }}>
      <MentionInput
        multiline
        value={text}
        onChange={setText}
        candidates={people}
        onPick={(u) => {
          setMentions((m) => (m.some((x) => x.id === u.id) ? m : [...m, u]));
          return 'insert';
        }}
        onSubmit={submit}
        placeholder="Write a comment… @ to mention someone on this task (Ctrl+Enter to send)"
        ariaLabel="New comment"
      />
      <div className="row">
        <span className="faint tiny">Mentions notify the person instantly.</span>
        <span className="spacer" />
        <button className="btn btn-primary btn-sm" onClick={submit} disabled={!text.trim() || busy}>
          <Send size={14} /> Comment
        </button>
      </div>
    </div>
  );
}

function EditForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [due, setDue] = useState(toLocalInput(task.dueAt));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await updateTask(task, { title: title.trim(), description, priority, dueAt: fromLocalInput(due) });
      onDone();
    } catch (err) {
      toastError(err, 'Could not save changes');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="col" style={{ gap: 10 }}>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} aria-label="Title" />
      <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} aria-label="Description" placeholder="Description" />
      <div className="row" style={{ gap: 8 }}>
        <select className="select" value={priority} onChange={(e) => setPriority(e.target.value as Priority)} aria-label="Priority">
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
        <input className="input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !title.trim()}>
          Save
        </button>
      </div>
    </div>
  );
}

function TaskDialog({ kind, task, meId, onClose }: { kind: NonNullable<Dialog>; task: Task; meId: string; onClose: () => void }) {
  const directory = useStore((s) => s.directory);
  const me = useStore((s) => s.me);
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const active = task.assignees.filter((a) => a.status === 'active').map((a) => a.user.id);
  const people = me && !directory.some((d) => d.id === me.id) ? [me, ...directory] : directory;

  const config = {
    reassign: { title: 'Reassign task', cta: 'Reassign', needsPeople: true, exclude: active },
    handover: { title: 'Hand over to a colleague', cta: 'Hand over', needsPeople: true, exclude: [meId] },
    add: { title: 'Add people', cta: 'Add', needsPeople: true, exclude: active },
    decline: { title: 'Decline this task', cta: 'Decline', needsPeople: false, exclude: [] },
    cancel: { title: 'Cancel this task', cta: 'Cancel task', needsPeople: false, exclude: [] },
  }[kind];

  const submit = async () => {
    setBusy(true);
    try {
      if (kind === 'reassign') await reassignTask(task, selected, note || undefined);
      if (kind === 'handover') await reassignTask(task, selected, note || undefined, meId);
      if (kind === 'add') await addAssignees(task, selected);
      if (kind === 'decline') await declineTask(task, note || undefined);
      if (kind === 'cancel') await changeStatus(task, 'cancelled', note || undefined);
      toast({ kind: 'success', title: `${config.title.replace(/ task$/, '')} — done` }, 3000);
      onClose();
      if (kind === 'decline' || kind === 'handover') openTask(null);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={config.title}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Back
          </button>
          <button
            className={`btn ${kind === 'cancel' || kind === 'decline' ? 'btn-danger' : 'btn-primary'}`}
            onClick={submit}
            disabled={busy || (config.needsPeople && selected.length === 0)}
          >
            {config.cta}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {kind === 'decline' && <p className="muted" style={{ margin: 0 }}>The creator is notified. If nobody else is assigned, the task returns to them as Declined.</p>}
        {kind === 'cancel' && <p className="muted" style={{ margin: 0 }}>Cancelling closes the task for every assignee. You can restore it later.</p>}
        {kind === 'reassign' && <p className="muted" style={{ margin: 0 }}>Current assignees are replaced. Their assignment is kept in the history.</p>}
        {config.needsPeople && <PeoplePicker people={people} selected={selected} onChange={setSelected} exclude={config.exclude} />}
        {kind !== 'add' && (
          <div className="field">
            <label className="label" htmlFor="dlg-note">{kind === 'decline' ? 'Reason (optional)' : 'Note (optional)'}</label>
            <input id="dlg-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </div>
        )}
      </div>
    </Modal>
  );
}
