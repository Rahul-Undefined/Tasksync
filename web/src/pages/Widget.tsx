import { useEffect, useMemo, useState } from 'react';
import { Bell, Check, ExternalLink, Maximize2, Minimize2, Minus, PictureInPicture2, Pin, PinOff, X } from 'lucide-react';
import { TaskCard } from '../components/TaskCard';
import { TaskComposer } from '../components/TaskComposer';
import { ConnectionPill } from '../components/ui';
import { desktop, isDesktop, type HostState } from '../lib/desktop';
import { navigate } from '../lib/router';
import { shapeAppWindow } from '../lib/pwa';
import { floatingWidgetSupported, openFloatingWidget } from '../lib/pip';
import { relativeTime } from '../lib/format';
import { markNotificationsRead, openTask, useStore } from '../lib/store';
import { dueBucket, selectAssigned, selectMy } from '../lib/views';

/**
 * The widget UI, used in three places:
 *  - "host": inside the native Windows app (WebView2) — pin, tray, drag and size come from the host;
 *  - "browser": the /widget route in Edge, e.g. an installed Edge app window sized like a widget;
 *  - "pip": the pop-out always-on-top window (Document Picture-in-Picture), no install needed.
 * Compact: counts + next tasks + quick add. Expanded: tabs for My Tasks, Assigned and Alerts.
 */
export function WidgetPage({
  onReconnect,
  variant = isDesktop ? 'host' : 'browser',
  onClose,
}: {
  onReconnect?: () => void;
  variant?: 'host' | 'browser' | 'pip';
  onClose?: () => void;
}) {
  const me = useStore((s) => s.me)!;
  const tasks = useStore((s) => s.tasks);
  const connection = useStore((s) => s.connection);
  const queued = useStore((s) => s.queued);
  const notifications = useStore((s) => s.notifications);
  const unread = useStore((s) => s.unreadCount);
  const [host, setHost] = useState<HostState | null>(null);
  const [localMode, setLocalMode] = useState<'compact' | 'expanded'>(variant === 'pip' ? 'expanded' : 'compact');
  const [tab, setTab] = useState<'my' | 'assigned' | 'alerts'>('my');
  const mode = variant === 'host' ? (host?.mode ?? 'compact') : localMode;
  const isHost = variant === 'host';

  useEffect(() => {
    const off = desktop.onMessage((m) => m.type === 'hostState' && setHost(m.state));
    desktop.requestState();
    return off;
  }, []);

  const my = useMemo(() => selectMy(tasks.values(), me.id), [tasks, me.id]);
  const assigned = useMemo(() => selectAssigned(tasks.values(), me.id), [tasks, me.id]);
  const overdue = my.filter((t) => dueBucket(t) === 'overdue').length;
  const today = my.filter((t) => dueBucket(t) === 'today').length;

  useEffect(() => desktop.setBadge(my.length), [my.length]);

  const setMode = (m: 'compact' | 'expanded') => {
    if (!isHost) return setLocalMode(m);
    desktop.setMode(m);
    setHost((h) => (h ? { ...h, mode: m } : h));
  };
  const openDashboard = () => {
    if (isHost) desktop.openDashboard('/');
    else if (variant === 'pip') window.focus(); // the dashboard is the window that opened this one
    else {
      shapeAppWindow('dashboard');
      navigate('/');
    }
  };

  const list = tab === 'my' ? my : assigned;

  return (
    <div className="widget">
      <div
        className="widget-bar glass"
        onMouseDown={(e) => {
          if (!isHost || (e.target as HTMLElement).closest('button') || e.button !== 0) return;
          desktop.startDrag();
        }}
        onDoubleClick={(e) => !(e.target as HTMLElement).closest('button') && setMode(mode === 'compact' ? 'expanded' : 'compact')}
      >
        <div className="brand-mark" style={{ width: 22, height: 22, borderRadius: 7 }}>
          <Check size={13} strokeWidth={3.4} color="#fff" />
        </div>
        <strong style={{ fontFamily: 'var(--font-display)', fontSize: 13.5 }}>TaskSync</strong>
        <span className="spacer" />
        <ConnectionPill status={connection} queued={queued} onRetry={onReconnect} />
        {isHost && (
          <button className={`icon-btn ${host?.alwaysOnTop ? 'on' : ''}`} title={host?.alwaysOnTop ? 'Unpin from top' : 'Keep on top'} onClick={() => {
            const v = !host?.alwaysOnTop;
            desktop.setAlwaysOnTop(v);
            setHost((h) => (h ? { ...h, alwaysOnTop: v } : h));
          }}>
            {host?.alwaysOnTop ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
        )}
        {variant === 'browser' && floatingWidgetSupported() && (
          <button className="icon-btn" title="Pop out (always on top)" onClick={() => void openFloatingWidget()}>
            <PictureInPicture2 size={14} />
          </button>
        )}
        <button className="icon-btn" title={mode === 'compact' ? 'Expand' : 'Compact'} onClick={() => setMode(mode === 'compact' ? 'expanded' : 'compact')}>
          {mode === 'compact' ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
        </button>
        <button className="icon-btn" title="Open full dashboard" onClick={openDashboard}>
          <ExternalLink size={14} />
        </button>
        {isHost && (
          <button className="icon-btn" title="Minimise to tray" onClick={() => desktop.minimizeToTray()}>
            <Minus size={14} />
          </button>
        )}
        {variant === 'pip' && onClose && (
          <button className="icon-btn" title="Close floating widget" onClick={onClose}>
            <X size={14} />
          </button>
        )}
      </div>

      <div className="widget-stats">
        <div className="stat glass accent">
          <div className="v">{my.length}</div>
          <div className="l">Open</div>
        </div>
        <div className="stat glass">
          <div className="v" style={{ color: overdue ? '#ff9b9b' : undefined }}>{overdue}</div>
          <div className="l">Overdue</div>
        </div>
        <div className="stat glass">
          <div className="v">{today}</div>
          <div className="l">Due today</div>
        </div>
      </div>

      <TaskComposer compact />

      {mode === 'expanded' && (
        <div className="tabs" role="tablist" style={{ alignSelf: 'flex-start' }}>
          <button className={`tab ${tab === 'my' ? 'active' : ''}`} onClick={() => setTab('my')}>My Tasks · {my.length}</button>
          <button className={`tab ${tab === 'assigned' ? 'active' : ''}`} onClick={() => setTab('assigned')}>Assigned · {assigned.length}</button>
          <button className={`tab ${tab === 'alerts' ? 'active' : ''}`} onClick={() => setTab('alerts')}>
            <Bell size={12} /> {unread}
          </button>
        </div>
      )}

      <div className="widget-body">
        {tab === 'alerts' && mode === 'expanded' ? (
          <>
            {unread > 0 && (
              <button className="btn btn-sm" style={{ alignSelf: 'flex-end' }} onClick={() => markNotificationsRead()}>
                Mark all read
              </button>
            )}
            {notifications.slice(0, 30).map((n) => (
              <button
                key={n.id}
                className="menu-item glass"
                style={{ padding: 10, opacity: n.readAt ? 0.65 : 1 }}
                onClick={() => {
                  if (!n.taskId) return;
                  openTask(n.taskId);
                  if (variant === 'pip') window.focus();
                }}
              >
                <span className="col" style={{ gap: 0 }}>
                  <span>{n.title}</span>
                  <span className="sub">{relativeTime(n.createdAt)}</span>
                </span>
              </button>
            ))}
          </>
        ) : list.length === 0 ? (
          <div className="faint small" style={{ textAlign: 'center', padding: 20 }}>Nothing here. Enjoy the calm ✨</div>
        ) : (
          (mode === 'compact' ? list.slice(0, 6) : list).map((t) => <TaskCard key={t.id} task={t} meId={me.id} compact perspective={tab === 'my' ? 'assignee' : 'creator'} />)
        )}
        {mode === 'compact' && list.length > 6 && (
          <button className="btn btn-sm btn-ghost" onClick={() => setMode('expanded')}>
            +{list.length - 6} more
          </button>
        )}
      </div>
    </div>
  );
}
