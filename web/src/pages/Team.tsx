import { useEffect, useMemo, useState } from 'react';
import type { Task, UserSummary } from '@tasksync/shared';
import { ArrowLeft, ListChecks, MessageSquareShare, Search, UserRound, Users } from 'lucide-react';
import { matchPeople } from '../components/MentionInput';
import { openPersonMenu, openProfile, startTeamsMessage } from '../components/PersonMenu';
import { TaskCard } from '../components/TaskCard';
import { Avatar, Empty, Spinner } from '../components/ui';
import { get } from '../lib/api';
import { navigate } from '../lib/router';
import { refreshDirectory, toastError, upsertTasks, useStore } from '../lib/store';

export function TeamPage() {
  const directory = useStore((s) => s.directory);
  const me = useStore((s) => s.me)!;
  const tasks = useStore((s) => s.tasks);
  const [q, setQ] = useState('');
  useEffect(() => {
    refreshDirectory().catch(() => undefined);
  }, []);

  const openCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tasks.values()) {
      if (t.status === 'completed' || t.status === 'cancelled') continue;
      for (const a of t.assignees) if (a.status === 'active' && a.user.id !== me.id) counts.set(a.user.id, (counts.get(a.user.id) ?? 0) + 1);
    }
    return counts;
  }, [tasks, me.id]);

  const people = useMemo(() => matchPeople(directory, q, 500), [directory, q]);

  return (
    <div className="content-inner">
      <div className="row" style={{ position: 'relative', maxWidth: 420 }}>
        <Search size={15} className="faint" style={{ position: 'absolute', left: 12 }} />
        <input className="input" style={{ paddingLeft: 34 }} placeholder="Search by name, email or department" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {people.length === 0 ? (
        <Empty icon={<Users size={24} />} title="No colleagues found">
          Colleagues appear here once they sign in to TaskSync and an administrator approves them.
        </Empty>
      ) : (
        <div className="grid-people">
          {people.map((u) => (
            <div key={u.id} className="person-card glass">
              <Avatar id={u.id} name={u.displayName} size="lg" />
              <div className="col" style={{ gap: 2, minWidth: 0, flex: 1 }}>
                <button
                  className="person-link truncate"
                  style={{ alignSelf: 'flex-start', maxWidth: '100%' }}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    openPersonMenu(u, { x: r.left, y: r.bottom + 6 });
                  }}
                >
                  {u.displayName}
                  {u.id === me.id ? ' (you)' : ''}
                </button>
                <span className="small muted truncate">{[u.jobTitle, u.department].filter(Boolean).join(' · ') || u.email}</span>
                {openCount.get(u.id) ? <span className="tiny faint">{openCount.get(u.id)} open task(s) with you</span> : null}
              </div>
              <div className="col" style={{ gap: 2 }}>
                <button className="icon-btn" title="View tasks" onClick={() => navigate(`/team/${u.id}`)}>
                  <ListChecks size={16} />
                </button>
                {u.id !== me.id && (
                  <button className="icon-btn" title="Message in Teams" onClick={() => startTeamsMessage(u)}>
                    <MessageSquareShare size={16} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function EmployeeTasksPage({ userId }: { userId: string }) {
  const me = useStore((s) => s.me)!;
  const directory = useStore((s) => s.directory);
  const allTasks = useStore((s) => s.tasks);
  const [ids, setIds] = useState<string[] | null>(null);
  const [person, setPerson] = useState<UserSummary | null>(directory.find((d) => d.id === userId) ?? null);

  useEffect(() => {
    setIds(null);
    get<{ tasks: Task[] }>(`/api/tasks?view=involving&userId=${userId}`)
      .then((r) => {
        upsertTasks(r.tasks);
        setIds(r.tasks.map((t) => t.id));
      })
      .catch((err) => {
        toastError(err, 'Could not load tasks');
        setIds([]);
      });
    if (!person) {
      get<{ user: UserSummary }>(`/api/users/${userId}`)
        .then((r) => setPerson(r.user))
        .catch(() => undefined);
    }
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live: include any task (e.g. newly created) that now involves both people.
  const tasks = useMemo(() => {
    const set = new Set(ids ?? []);
    for (const t of allTasks.values()) {
      const involvesThem = t.createdBy.id === userId || t.assignees.some((a) => a.user.id === userId);
      const involvesMe = t.createdBy.id === me.id || t.assignees.some((a) => a.user.id === me.id);
      if (involvesThem && (involvesMe || me.role === 'admin')) set.add(t.id);
    }
    return [...set].map((id) => allTasks.get(id)).filter((t): t is Task => Boolean(t));
  }, [ids, allTasks, userId, me]);

  const open = tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
  const closed = tasks.filter((t) => t.status === 'completed' || t.status === 'cancelled');

  return (
    <div className="content-inner">
      <div className="glass row wrap" style={{ padding: 18, gap: 16 }}>
        <button className="icon-btn" onClick={() => navigate('/team')} aria-label="Back to team">
          <ArrowLeft size={18} />
        </button>
        {person ? <Avatar id={person.id} name={person.displayName} size="lg" /> : <Spinner />}
        <div className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
          <strong style={{ fontSize: 18 }}>{person?.displayName ?? 'Employee'}</strong>
          <span className="muted small">
            {me.role === 'admin' ? 'All tasks this employee is part of (admin view)' : 'Tasks you share with this colleague'}
          </span>
        </div>
        {person && (
          <div className="row">
            <button className="btn" onClick={() => openProfile(person)}>
              <UserRound size={15} /> Profile
            </button>
            {person.id !== me.id && (
              <button className="btn btn-primary" onClick={() => startTeamsMessage(person)}>
                <MessageSquareShare size={15} /> Message in Teams
              </button>
            )}
          </div>
        )}
      </div>
      {ids === null ? (
        <Spinner />
      ) : tasks.length === 0 ? (
        <Empty icon={<ListChecks size={24} />} title="No shared tasks">
          You don't have any tasks with {person?.displayName ?? 'this colleague'} yet.
        </Empty>
      ) : (
        <>
          <div className="section-head">
            Open <span className="n">{open.length}</span>
          </div>
          <div className="task-list">
            {open.map((t) => (
              <TaskCard key={t.id} task={t} meId={me.id} />
            ))}
          </div>
          {closed.length > 0 && (
            <>
              <div className="section-head">
                Closed <span className="n">{closed.length}</span>
              </div>
              <div className="task-list">
                {closed.map((t) => (
                  <TaskCard key={t.id} task={t} meId={me.id} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
