import { useMemo, useState } from 'react';
import type { Task } from '@tasksync/shared';
import { CheckCheck, Inbox, Send, Sparkles } from 'lucide-react';
import { TaskCard } from '../components/TaskCard';
import { TaskComposer } from '../components/TaskComposer';
import { Empty } from '../components/ui';
import { useStore } from '../lib/store';
import { BUCKET_LABELS, dueBucket, selectAssigned, selectCompleted, selectMy, type DueBucket } from '../lib/views';

const ORDER: DueBucket[] = ['overdue', 'today', 'week', 'later', 'none'];

export function GroupedTasks({ tasks, meId, perspective }: { tasks: Task[]; meId: string; perspective: 'assignee' | 'creator' | 'any' }) {
  const groups = useMemo(() => {
    const map = new Map<DueBucket, Task[]>();
    for (const t of tasks) {
      const b = dueBucket(t);
      map.set(b, [...(map.get(b) ?? []), t]);
    }
    return ORDER.filter((b) => map.has(b)).map((b) => [b, map.get(b)!] as const);
  }, [tasks]);
  return (
    <>
      {groups.map(([bucket, list]) => (
        <section key={bucket} className="col" style={{ gap: 10 }}>
          <div className={`section-head ${bucket}`}>
            {BUCKET_LABELS[bucket]} <span className="n">{list.length}</span>
          </div>
          <div className="task-list">
            {list.map((t) => (
              <TaskCard key={t.id} task={t} meId={meId} perspective={perspective} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function Loading() {
  return (
    <div className="task-list">
      {[0, 1, 2].map((i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  );
}

export function MyTasksPage() {
  const tasks = useStore((s) => s.tasks);
  const me = useStore((s) => s.me)!;
  const loaded = useStore((s) => s.loaded);
  const list = useMemo(() => selectMy(tasks.values(), me.id), [tasks, me.id]);
  const overdue = list.filter((t) => dueBucket(t) === 'overdue').length;
  const today = list.filter((t) => dueBucket(t) === 'today').length;
  const inProgress = list.filter((t) => t.status === 'in_progress').length;
  const completedToday = useMemo(
    () =>
      selectCompleted(tasks.values(), me.id).filter(
        (t) => t.completedAt && new Date(t.completedAt).toDateString() === new Date().toDateString(),
      ).length,
    [tasks, me.id],
  );

  return (
    <div className="content-inner">
      <div className="stats">
        <div className="stat glass accent">
          <div className="v">{list.length}</div>
          <div className="l">Open tasks</div>
        </div>
        <div className="stat glass">
          <div className="v" style={{ color: overdue ? '#ff9b9b' : undefined }}>{overdue}</div>
          <div className="l">Overdue</div>
        </div>
        <div className="stat glass">
          <div className="v">{today}</div>
          <div className="l">Due today · {inProgress} in progress</div>
        </div>
        <div className="stat glass">
          <div className="v" style={{ color: '#4ee0a7' }}>{completedToday}</div>
          <div className="l">Completed today</div>
        </div>
      </div>
      <TaskComposer />
      {!loaded ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty icon={<Sparkles size={26} />} title="You're all caught up">
          Add a task above. Type <strong>@</strong> to assign it to a colleague — it appears on their dashboard and desktop widget instantly.
        </Empty>
      ) : (
        <GroupedTasks tasks={list} meId={me.id} perspective="assignee" />
      )}
    </div>
  );
}

export function AssignedByMePage() {
  const tasks = useStore((s) => s.tasks);
  const me = useStore((s) => s.me)!;
  const loaded = useStore((s) => s.loaded);
  const list = useMemo(() => selectAssigned(tasks.values(), me.id), [tasks, me.id]);
  const declined = list.filter((t) => t.status === 'declined');
  const rest = list.filter((t) => t.status !== 'declined');
  return (
    <div className="content-inner">
      <TaskComposer />
      {!loaded ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty icon={<Send size={24} />} title="Nothing delegated right now">
          Tasks you assign to colleagues show up here so you can follow progress. When they complete one, it moves to Completed for both of you.
        </Empty>
      ) : (
        <>
          {declined.length > 0 && (
            <section className="col" style={{ gap: 10 }}>
              <div className="section-head overdue">
                Needs your attention — declined <span className="n">{declined.length}</span>
              </div>
              <div className="task-list">
                {declined.map((t) => (
                  <TaskCard key={t.id} task={t} meId={me.id} perspective="creator" />
                ))}
              </div>
            </section>
          )}
          <GroupedTasks tasks={rest} meId={me.id} perspective="creator" />
        </>
      )}
    </div>
  );
}

export function CompletedPage() {
  const tasks = useStore((s) => s.tasks);
  const me = useStore((s) => s.me)!;
  const loaded = useStore((s) => s.loaded);
  const [filter, setFilter] = useState<'completed' | 'cancelled'>('completed');
  const all = useMemo(() => selectCompleted(tasks.values(), me.id), [tasks, me.id]);
  const list = all.filter((t) => t.status === filter);
  return (
    <div className="content-inner">
      <div className="row">
        <div className="tabs" role="tablist">
          {(['completed', 'cancelled'] as const).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={`tab ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
              {f === 'completed' ? 'Completed' : 'Cancelled'} · {all.filter((t) => t.status === f).length}
            </button>
          ))}
        </div>
      </div>
      {!loaded ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty icon={filter === 'completed' ? <CheckCheck size={26} /> : <Inbox size={26} />} title={filter === 'completed' ? 'No completed tasks yet' : 'No cancelled tasks'}>
          {filter === 'completed' ? 'When anyone on a task marks it complete, it appears here for every participant.' : 'Tasks cancelled by their creator are kept here for reference.'}
        </Empty>
      ) : (
        <div className="task-list">
          {list.map((t) => (
            <TaskCard key={t.id} task={t} meId={me.id} />
          ))}
        </div>
      )}
    </div>
  );
}
