import { useState } from 'react';
import { PRIORITIES, PRIORITY_LABELS, type Priority, type UserSummary } from '@tasksync/shared';
import { ChevronDown, Plus, SlidersHorizontal, UserRound, X } from 'lucide-react';
import { fromLocalInput } from '../lib/format';
import { createTask, getState, searchDirectory, toast, toastError, useStore } from '../lib/store';
import { MentionInput } from './MentionInput';
import { Avatar } from './ui';

export function TaskComposer({ compact, autoFocus }: { compact?: boolean; autoFocus?: boolean }) {
  const directory = useStore((s) => s.directory);
  const me = useStore((s) => s.me);
  const [title, setTitle] = useState('');
  const [assignees, setAssignees] = useState<UserSummary[]>([]);
  const [self, setSelf] = useState(true);
  const [selfTouched, setSelfTouched] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);

  const candidates = directory.filter((u) => !assignees.some((a) => a.id === u.id));

  const addAssignee = (u: UserSummary) => {
    if (u.id === me?.id) {
      setSelf(true);
      setSelfTouched(true);
      return 'consume' as const;
    }
    setAssignees((a) => (a.some((x) => x.id === u.id) ? a : [...a, u]));
    if (!selfTouched) setSelf(false); // mentioning a colleague usually means "assign to them"
    return 'consume' as const;
  };

  const reset = () => {
    setAssignees([]);
    setSelf(true);
    setSelfTouched(false);
    setDescription('');
    setPriority('medium');
    setDue('');
  };

  const submit = async () => {
    const t = title.trim();
    if (!t || busy) return;
    if (!self && assignees.length === 0) {
      toast({ kind: 'error', title: 'Who is this for?', body: 'Type @ to assign a colleague, or assign it to yourself.' });
      return;
    }
    setBusy(true);
    try {
      await createTask({
        title: t,
        description: description.trim() || undefined,
        priority,
        dueAt: fromLocalInput(due),
        assigneeIds: assignees.map((a) => a.id),
        assignToSelf: self,
      });
      const names = [...(self ? ['you'] : []), ...assignees.map((a) => a.displayName)];
      if (getState().queued === 0) toast({ kind: 'success', title: 'Task created', body: `Assigned to ${names.join(', ')}.` }, 3000);
      reset();
      // Keep anything typed while the task was being saved (e.g. the next task).
      setTitle((current) => (current.trim() === t ? '' : current));
    } catch (err) {
      toastError(err, 'Could not create the task');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="composer glass">
      <div className="composer-main">
        <MentionInput
          value={title}
          onChange={setTitle}
          candidates={candidates}
          onPick={addAssignee}
          onQuery={(q) => void searchDirectory(q).catch(() => undefined)}
          onSubmit={submit}
          autoFocus={autoFocus}
          placeholder={compact ? 'Quick add… @name to assign' : 'Add a task… type @ to assign colleagues'}
          ariaLabel="New task title"
        />
        {!compact && (
          <button className={`icon-btn ${expanded ? 'on' : ''}`} onClick={() => setExpanded((v) => !v)} aria-label="More options" title="Details, priority and due date">
            <SlidersHorizontal size={17} />
          </button>
        )}
        <button className="btn btn-primary" onClick={submit} disabled={!title.trim() || busy} style={{ height: compact ? 38 : 44 }}>
          <Plus size={17} /> {compact ? '' : 'Add'}
        </button>
      </div>

      <div className="row wrap" style={{ gap: 6 }}>
        <button
          type="button"
          className="chip"
          style={{ opacity: self ? 1 : 0.55, cursor: 'pointer', paddingRight: 10 }}
          onClick={() => {
            setSelf((v) => !v);
            setSelfTouched(true);
          }}
          aria-pressed={self}
          title="Assign to me"
        >
          <span className="avatar sm" style={{ background: 'var(--accent-grad)' }}>
            <UserRound size={12} />
          </span>
          {self ? 'Me' : 'Not me'}
        </button>
        {assignees.map((a) => (
          <span className="chip" key={a.id}>
            <Avatar id={a.id} name={a.displayName} size="sm" />
            {a.displayName}
            <button aria-label={`Remove ${a.displayName}`} onClick={() => setAssignees((list) => list.filter((x) => x.id !== a.id))}>
              <X size={13} />
            </button>
          </span>
        ))}
        {!compact && !expanded && (priority !== 'medium' || due) && (
          <button className="chip" style={{ paddingRight: 10, cursor: 'pointer' }} onClick={() => setExpanded(true)}>
            {PRIORITY_LABELS[priority]}
            {due ? ` · due ${new Date(due).toLocaleDateString()}` : ''} <ChevronDown size={13} />
          </button>
        )}
      </div>

      {expanded && !compact && (
        <div className="composer-extra">
          <div className="field">
            <label className="label" htmlFor="new-desc">Description</label>
            <textarea id="new-desc" className="textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Context, links, acceptance criteria…" maxLength={5000} />
          </div>
          <div className="field">
            <label className="label" htmlFor="new-prio">Priority</label>
            <select id="new-prio" className="select" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="new-due">Due</label>
            <input id="new-due" className="input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          </div>
        </div>
      )}
    </div>
  );
}
