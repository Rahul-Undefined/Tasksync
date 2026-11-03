import { useCallback, useEffect, useState } from 'react';
import type { TaskActivity } from '@tasksync/shared';
import { Activity as ActivityIcon, RefreshCw } from 'lucide-react';
import { activityIcon, activityText } from '../components/activityText';
import { Empty, Spinner } from '../components/ui';
import { get } from '../lib/api';
import { formatDateTime, relativeTime } from '../lib/format';
import { openTask, toastError, useStore } from '../lib/store';

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

export function ActivityPage() {
  const me = useStore((s) => s.me)!;
  // Reload when any task changes (realtime) so the feed stays live.
  const tasks = useStore((s) => s.tasks);
  const [items, setItems] = useState<TaskActivity[] | null>(null);
  const [more, setMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await get<{ activity: TaskActivity[] }>('/api/activity?limit=100');
      setItems(res.activity);
      setMore(res.activity.length === 100);
    } catch (err) {
      toastError(err, 'Could not load activity');
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load, tasks]);

  const loadMore = async () => {
    if (!items?.length) return;
    setLoadingMore(true);
    try {
      const res = await get<{ activity: TaskActivity[] }>(`/api/activity?limit=100&before=${items.at(-1)!.id}`);
      setItems([...items, ...res.activity]);
      setMore(res.activity.length === 100);
    } finally {
      setLoadingMore(false);
    }
  };

  if (!items) return <div className="content-inner"><Spinner /></div>;
  if (items.length === 0)
    return (
      <div className="content-inner">
        <Empty icon={<ActivityIcon size={24} />} title="No activity yet">Everything that happens on tasks you're part of is recorded here.</Empty>
      </div>
    );

  const groups: [string, TaskActivity[]][] = [];
  for (const a of items) {
    const label = dayLabel(a.createdAt);
    const g = groups.at(-1);
    if (g && g[0] === label) g[1].push(a);
    else groups.push([label, [a]]);
  }

  return (
    <div className="content-inner">
      <div className="row">
        <span className="spacer" />
        <button className="btn btn-sm" onClick={load}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {groups.map(([label, list]) => (
        <section key={label} className="glass" style={{ padding: '14px 18px' }}>
          <div className="block-title">{label}</div>
          <div className="timeline">
            {list.map((a) => (
              <button
                key={a.id}
                className="tl-item"
                style={{ border: 'none', background: 'none', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer', padding: '7px 0' }}
                onClick={() => openTask(a.taskId)}
              >
                <span className="tl-icon">{activityIcon(a.type)}</span>
                <span>
                  {activityText(a, me.id, true)}
                  <span className="faint small" title={formatDateTime(a.createdAt)}>
                    {' '}
                    · {relativeTime(a.createdAt)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {more && (
        <button className="btn" onClick={loadMore} disabled={loadingMore} style={{ alignSelf: 'center' }}>
          {loadingMore ? <Spinner /> : 'Load older activity'}
        </button>
      )}
    </div>
  );
}
