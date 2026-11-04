import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Bell, Check, CheckCheck, CloudOff, Inbox, ListTodo, PictureInPicture2, Send, Settings, ShieldCheck, Users, X } from 'lucide-react';
import { closeFloatingWidget, floatingWidgetSupported, openFloatingWidget, useFloatingWidgetOpen } from './lib/pip';
import { setTaskbarBadge } from './lib/pwa';
import { PersonMenuHost } from './components/PersonMenu';
import { TaskDrawer } from './components/TaskDrawer';
import { Avatar, ConnectionPill } from './components/ui';
import { relativeTime } from './lib/format';
import { navigate, usePath } from './lib/router';
import { dismissToast, markNotificationsRead, openTask, toastError, useStore } from './lib/store';
import { selectAssigned, selectMy } from './lib/views';
import { ActivityPage } from './pages/Activity';
import { AdminPage } from './pages/Admin';
import { SettingsPage } from './pages/Settings';
import { EmployeeTasksPage, TeamPage } from './pages/Team';
import { AssignedByMePage, CompletedPage, MyTasksPage } from './pages/TaskViews';

interface Route {
  path: string;
  label: string;
  icon: React.ReactNode;
  sub: string;
}

const ROUTES: Route[] = [
  { path: '/', label: 'My Tasks', icon: <ListTodo size={18} />, sub: 'Everything assigned to you' },
  { path: '/assigned', label: 'Assigned by Me', icon: <Send size={18} />, sub: 'Work you delegated to colleagues' },
  { path: '/completed', label: 'Completed', icon: <CheckCheck size={18} />, sub: 'Finished and cancelled tasks' },
  { path: '/activity', label: 'Activity', icon: <Activity size={18} />, sub: 'Every change on tasks you are part of' },
  { path: '/team', label: 'Team', icon: <Users size={18} />, sub: 'Approved TaskSync colleagues' },
  { path: '/settings', label: 'Settings', icon: <Settings size={18} />, sub: 'Profile, notifications and desktop app' },
];
const ADMIN_ROUTE: Route = { path: '/admin', label: 'Admin', icon: <ShieldCheck size={18} />, sub: 'Employee access and audit log' };

export function Shell({ onSignOut, onReconnect, version }: { onSignOut: () => void; onReconnect: () => void; version: string }) {
  const path = usePath();
  const me = useStore((s) => s.me)!;
  const tasks = useStore((s) => s.tasks);
  const connection = useStore((s) => s.connection);
  const queued = useStore((s) => s.queued);
  const waking = useStore((s) => s.serverWaking);
  const unread = useStore((s) => s.unreadCount);
  const [bellOpen, setBellOpen] = useState(false);
  const floating = useFloatingWidgetOpen();

  const routes = me.role === 'admin' ? [...ROUTES, ADMIN_ROUTE] : ROUTES;
  const current = routes.find((r) => r.path === path) ?? (path.startsWith('/team/') ? { ...ROUTES[4]!, label: 'Employee tasks' } : ROUTES[0]!);
  const counts = useMemo(
    () => ({ '/': selectMy(tasks.values(), me.id).length, '/assigned': selectAssigned(tasks.values(), me.id).length }) as Record<string, number>,
    [tasks, me.id],
  );

  useEffect(() => {
    document.title = counts['/'] ? `(${counts['/']}) ${current.label} · TaskSync` : `${current.label} · TaskSync`;
  }, [counts, current.label]);
  useEffect(() => setTaskbarBadge(counts['/'] ?? 0), [counts]);

  let page: React.ReactNode;
  if (path === '/assigned') page = <AssignedByMePage />;
  else if (path === '/completed') page = <CompletedPage />;
  else if (path === '/activity') page = <ActivityPage />;
  else if (path === '/team') page = <TeamPage />;
  else if (path.startsWith('/team/')) page = <EmployeeTasksPage userId={path.slice(6)} />;
  else if (path === '/settings') page = <SettingsPage onSignOut={onSignOut} version={version} />;
  else if (path === '/admin' && me.role === 'admin') page = <AdminPage />;
  else page = <MyTasksPage />;

  const nav = (r: Route) => (
    <button key={r.path} className={`nav-item ${current.path === r.path ? 'active' : ''}`} onClick={() => navigate(r.path)} aria-current={current.path === r.path ? 'page' : undefined}>
      {r.icon}
      <span>{r.label}</span>
      {counts[r.path] ? <span className="count">{counts[r.path]}</span> : null}
    </button>
  );

  if (floating) {
    // The widget runs in its own always-on-top window; this window must stay open but can be minimised.
    return (
      <div className="center-screen">
        <div className="hero glass glass-strong">
          <div className="brand-mark" style={{ width: 52, height: 52, borderRadius: 16 }}>
            <PictureInPicture2 size={26} color="#fff" />
          </div>
          <h1 style={{ fontSize: 22 }}>Widget mode is on</h1>
          <p className="tagline">
            TaskSync is running in the floating widget. <strong>Minimise this window</strong> (don't close it: closing it
            also closes the widget).
          </p>
          <button className="btn btn-primary" onClick={closeFloatingWidget}>
            Back to full dashboard
          </button>
        </div>
        <TaskDrawer />
        <PersonMenuHost />
        <Toasts />
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="sidebar glass" aria-label="Main">
        <div className="brand">
          <div className="brand-mark">
            <Check size={20} strokeWidth={3.2} color="#fff" />
          </div>
          <div>
            <div className="brand-name">TaskSync</div>
            <div className="brand-sub">Omnifi</div>
          </div>
        </div>
        {ROUTES.slice(0, 3).map(nav)}
        <div className="nav-section">Workspace</div>
        {routes.slice(3).map(nav)}
        <div className="sidebar-footer">
          <ConnectionPill status={connection} queued={queued} onRetry={onReconnect} />
          <button className="nav-item" onClick={() => navigate('/settings')}>
            <Avatar id={me.id} name={me.displayName} />
            <span className="col truncate" style={{ gap: 0 }}>
              <span className="truncate">{me.displayName}</span>
              <span className="tiny faint truncate">{me.email}</span>
            </span>
          </button>
        </div>
      </nav>

      <main className="main">
        <header className="topbar glass">
          <div className="col" style={{ gap: 0, minWidth: 0 }}>
            <h1 className="page-title">{current.label}</h1>
            <span className="page-sub truncate">{current.sub}</span>
          </div>
          <span className="spacer" />
          <span className="hide-mobile" style={{ display: 'contents' }}>
            {connection !== 'live' && connection !== 'polling' && <ConnectionPill status={connection} queued={queued} onRetry={onReconnect} />}
          </span>
          {floatingWidgetSupported() && (
            <button className="btn btn-sm hide-mobile" onClick={() => void openFloatingWidget()} title="Open a small always-on-top TaskSync window">
              <PictureInPicture2 size={15} /> Pop out widget
            </button>
          )}
          <button className="icon-btn show-mobile" onClick={() => navigate('/settings')} aria-label="Settings">
            <Settings size={18} />
          </button>
          <div style={{ position: 'relative' }}>
            <button className={`icon-btn ${bellOpen ? 'on' : ''}`} onClick={() => setBellOpen((v) => !v)} aria-label={`Notifications (${unread} unread)`}>
              <Bell size={18} />
              {unread > 0 && <span className="dot">{unread > 99 ? '99+' : unread}</span>}
            </button>
            {bellOpen && <NotificationsPanel onClose={() => setBellOpen(false)} />}
          </div>
        </header>
        {waking && (
          <div className="banner glass warn">
            <CloudOff size={16} /> The TaskSync server is waking up after a quiet period. Your changes will go through in a moment.
          </div>
        )}
        <div className="content">{page}</div>
      </main>

      <nav className="mobile-nav glass" aria-label="Main">
        {routes.slice(0, 5).map((r) => (
          <button key={r.path} className={`nav-item ${current.path === r.path ? 'active' : ''}`} onClick={() => navigate(r.path)}>
            {r.icon}
            <span>{r.label.replace(' by Me', '')}</span>
          </button>
        ))}
      </nav>

      <TaskDrawer />
      <PersonMenuHost />
      <Toasts />
    </div>
  );
}

function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const notifications = useStore((s) => s.notifications);
  const unread = useStore((s) => s.unreadCount);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.parentElement?.contains(e.target as Node) && onClose();
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose]);
  return (
    <div ref={ref} className="popover glass glass-strong" style={{ right: 0, top: 'calc(100% + 8px)', width: 'min(380px, calc(100vw - 32px))', maxHeight: 480 }} role="dialog" aria-label="Notifications">
      <div className="row" style={{ padding: '6px 8px 10px' }}>
        <strong>Notifications</strong>
        <span className="spacer" />
        {unread > 0 && (
          <button className="btn btn-sm btn-ghost" onClick={() => markNotificationsRead().catch((e) => toastError(e))}>
            Mark all read
          </button>
        )}
      </div>
      {notifications.length === 0 && (
        <div className="faint small row" style={{ padding: 16, gap: 8 }}>
          <Inbox size={16} /> You're all caught up.
        </div>
      )}
      {notifications.map((n) => (
        <button
          key={n.id}
          className="menu-item"
          style={{ alignItems: 'flex-start', opacity: n.readAt ? 0.6 : 1 }}
          onClick={() => {
            if (!n.readAt) markNotificationsRead([n.id]).catch(() => undefined);
            if (n.taskId) openTask(n.taskId);
            onClose();
          }}
        >
          {n.actor ? <Avatar id={n.actor.id} name={n.actor.displayName} size="sm" /> : <span className="avatar sm" style={{ background: 'var(--accent-grad)' }}>✓</span>}
          <span className="col" style={{ gap: 1, minWidth: 0 }}>
            <span style={{ fontWeight: n.readAt ? 400 : 600 }}>{n.title}</span>
            {n.body && <span className="sub" style={{ whiteSpace: 'normal' }}>{n.body}</span>}
            <span className="sub">{relativeTime(n.createdAt)}</span>
          </span>
          {!n.readAt && <span style={{ marginLeft: 'auto', width: 8, height: 8, borderRadius: 4, background: 'var(--accent)', flex: 'none', marginTop: 6 }} />}
        </button>
      ))}
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast glass glass-strong ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span style={{ marginTop: 2 }}>{t.kind === 'success' ? <CheckCheck size={17} color="#34d399" /> : t.kind === 'error' ? <X size={17} color="#f87171" /> : <Bell size={17} color="#a5b4fc" />}</span>
          <button
            style={{ border: 'none', background: 'none', color: 'inherit', font: 'inherit', textAlign: 'left', padding: 0, cursor: t.taskId ? 'pointer' : 'default' }}
            onClick={() => {
              if (t.taskId) openTask(t.taskId);
              dismissToast(t.id);
            }}
          >
            <div style={{ fontWeight: 600 }}>{t.title}</div>
            {t.body && <div className="small muted">{t.body}</div>}
          </button>
          <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
