import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Preferences } from '@tasksync/shared';
import {
  Bell,
  Check,
  CircleHelp,
  Maximize2,
  Minimize2,
  Minus,
  PictureInPicture2,
  RefreshCw,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react';
import { TaskCard } from '../components/TaskCard';
import { TaskComposer } from '../components/TaskComposer';
import { Switch } from '../components/ui';
import { desktop, isDesktop, type HostState } from '../lib/desktop';
import { navigate } from '../lib/router';
import { appOpensAsWidget, isInstalledApp, setAppOpensAsWidget, shapeAppWindow } from '../lib/pwa';
import { floatingWidgetSupported, openFloatingWidget } from '../lib/pip';
import { relativeTime } from '../lib/format';
import { markNotificationsRead, openTask, savePreferences, toastError, useStore } from '../lib/store';
import { dueBucket, selectAssigned, selectMy } from '../lib/views';
import type { ConnectionStatus } from '../lib/realtime';

type Variant = 'host' | 'browser' | 'pip';
type Sheet = 'settings' | 'help' | null;

const PREF_KEY = 'tasksync.widget';

function loadPrefs(): { expanded: boolean; dueSoon: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as Partial<{ expanded: boolean; dueSoon: boolean }>;
    return { expanded: v.expanded === true, dueSoon: v.dueSoon === true };
  } catch {
    return { expanded: false, dueSoon: false };
  }
}

function savePrefs(p: { expanded: boolean; dueSoon: boolean }) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {
    // storage unavailable: the choice lasts for this window only
  }
}

/**
 * The TaskSync widget: a compact desktop panel in the style of a small utility window —
 * a slim title bar, one big panel (quick add + tasks) and a bottom bar of toggles.
 * Used in three places:
 *  - "host": the native Windows app (WebView2) — tray, drag, pin and capture settings come from the host;
 *  - "browser": the /widget route, e.g. the installed Edge app (its title bar sits in the window's caption area);
 *  - "pip": the pop-out always-on-top window (Document Picture-in-Picture), no install needed.
 */
export function WidgetPage({
  onReconnect,
  variant = isDesktop ? 'host' : 'browser',
  onClose,
}: {
  onReconnect?: () => void;
  variant?: Variant;
  onClose?: () => void;
}) {
  const me = useStore((s) => s.me)!;
  const tasks = useStore((s) => s.tasks);
  const connection = useStore((s) => s.connection);
  const queued = useStore((s) => s.queued);
  const notifications = useStore((s) => s.notifications);
  const unread = useStore((s) => s.unreadCount);
  const [host, setHost] = useState<HostState | null>(null);
  const [prefs, setPrefsState] = useState(() => ({ ...loadPrefs(), ...(variant === 'pip' ? { expanded: true } : {}) }));
  const [tab, setTab] = useState<'my' | 'assigned' | 'alerts'>('my');
  const [sheet, setSheet] = useState<Sheet>(null);
  const isHost = variant === 'host';
  const expanded = isHost ? host?.mode === 'expanded' : prefs.expanded;

  useEffect(() => {
    const off = desktop.onMessage((m) => {
      if (m.type === 'hostState') setHost(m.state);
      if (m.type === 'openSheet') setSheet(m.sheet === 'help' ? 'help' : 'settings');
    });
    desktop.requestState();
    return off;
  }, []);

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSheet(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet]);

  const my = useMemo(() => selectMy(tasks.values(), me.id), [tasks, me.id]);
  const assigned = useMemo(() => selectAssigned(tasks.values(), me.id), [tasks, me.id]);
  const overdue = my.filter((t) => dueBucket(t) === 'overdue').length;
  const today = my.filter((t) => dueBucket(t) === 'today').length;

  useEffect(() => desktop.setBadge(my.length), [my.length]);

  const setPrefs = (patch: Partial<typeof prefs>) =>
    setPrefsState((p) => {
      const next = { ...p, ...patch };
      if (variant !== 'pip') savePrefs(next);
      return next;
    });

  const setExpanded = (v: boolean) => {
    if (!isHost) return setPrefs({ expanded: v });
    desktop.setMode(v ? 'expanded' : 'compact');
    setHost((h) => (h ? { ...h, mode: v ? 'expanded' : 'compact' } : h));
  };
  const setHostFlag = (key: 'alwaysOnTop' | 'autoStart' | 'hideFromCapture' | 'stayOnDesktop', value: boolean) => {
    if (key === 'alwaysOnTop') desktop.setAlwaysOnTop(value);
    if (key === 'autoStart') desktop.setAutoStart(value);
    if (key === 'hideFromCapture') desktop.setHideFromCapture(value);
    if (key === 'stayOnDesktop') desktop.setStayOnDesktop(value);
    setHost((h) => (h ? { ...h, [key]: value } : h));
  };
  const openDashboard = (path = '/') => {
    if (isHost) desktop.openDashboard(path);
    else if (variant === 'pip') {
      navigate(path);
      window.focus(); // the dashboard is the window that opened this one
    } else {
      shapeAppWindow('dashboard');
      navigate(path);
    }
  };

  const isDueSoon = (b: ReturnType<typeof dueBucket>) => b === 'overdue' || b === 'today';
  const source = tab === 'my' ? my : assigned;
  const list = prefs.dueSoon ? source.filter((t) => isDueSoon(dueBucket(t))) : source;
  const limit = expanded ? list.length : 6;

  return (
    <div className={`widget wg-${variant}`}>
      <header
        className="wg-title"
        onMouseDown={(e) => {
          if (!isHost || (e.target as HTMLElement).closest('button') || e.button !== 0) return;
          desktop.startDrag();
        }}
        onDoubleClick={(e) => !(e.target as HTMLElement).closest('button') && setExpanded(!expanded)}
      >
        <span className="wg-logo" aria-hidden>
          <Check size={12} strokeWidth={3.6} />
        </span>
        <span className="wg-name">TASKSYNC</span>
        <ConnectionDot status={connection} queued={queued} onRetry={onReconnect} />
        <span className="spacer" />
        {variant === 'browser' && floatingWidgetSupported() && (
          <button className="wg-win" title="Pop out (always on top)" aria-label="Pop out" onClick={() => void openFloatingWidget()}>
            <PictureInPicture2 size={14} />
          </button>
        )}
        {isHost && (
          <button className="wg-win" title="Minimise to tray" aria-label="Minimise" onClick={() => desktop.minimizeToTray()}>
            <Minus size={15} />
          </button>
        )}
        <button className="wg-win" title={expanded ? 'Compact' : 'Expand'} aria-label={expanded ? 'Compact' : 'Expand'} onClick={() => setExpanded(!expanded)}>
          {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        {isHost && (
          <button className="wg-win close" title="Close to tray (TaskSync keeps running)" aria-label="Close" onClick={() => desktop.minimizeToTray()}>
            <X size={15} />
          </button>
        )}
        {variant === 'pip' && onClose && (
          <button className="wg-win close" title="Close floating widget" aria-label="Close floating widget" onClick={onClose}>
            <X size={15} />
          </button>
        )}
      </header>

      <main className="wg-panel">
        <TaskComposer compact />

        <div className="wg-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'my'} className={tab === 'my' ? 'on' : ''} onClick={() => setTab('my')}>
            My tasks <b>{my.length}</b>
          </button>
          <button role="tab" aria-selected={tab === 'assigned'} className={tab === 'assigned' ? 'on' : ''} onClick={() => setTab('assigned')}>
            Assigned <b>{assigned.length}</b>
          </button>
          <button role="tab" aria-selected={tab === 'alerts'} aria-label="Alerts" className={tab === 'alerts' ? 'on' : ''} onClick={() => setTab('alerts')}>
            <Bell size={12} /> {unread > 0 && <b className="hot">{unread}</b>}
          </button>
          <span className="spacer" />
          {tab === 'my' && (overdue > 0 || today > 0) && (
            <span className="wg-due">
              {overdue > 0 && <span className="late">{overdue} overdue</span>}
              {overdue > 0 && today > 0 && ' · '}
              {today > 0 && <span>{today} today</span>}
            </span>
          )}
        </div>

        <div className="wg-list">
          {tab === 'alerts' ? (
            <>
              {unread > 0 && (
                <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-end' }} onClick={() => markNotificationsRead()}>
                  Mark all read
                </button>
              )}
              {notifications.length === 0 && <div className="wg-empty">No alerts yet.</div>}
              {notifications.slice(0, 30).map((n) => (
                <button
                  key={n.id}
                  className={`wg-alert ${n.readAt ? 'read' : ''}`}
                  onClick={() => {
                    if (!n.taskId) return;
                    openTask(n.taskId);
                    if (variant === 'pip') window.focus();
                  }}
                >
                  <span>{n.title}</span>
                  <span className="sub">{relativeTime(n.createdAt)}</span>
                </button>
              ))}
            </>
          ) : list.length === 0 ? (
            <div className="wg-empty">
              {prefs.dueSoon ? 'Nothing due today or overdue.' : tab === 'my' ? 'All clear. Type above to add a task ✨' : 'You have not assigned anything open.'}
            </div>
          ) : (
            list.slice(0, limit).map((t) => <TaskCard key={t.id} task={t} meId={me.id} compact perspective={tab === 'my' ? 'assignee' : 'creator'} />)
          )}
          {tab !== 'alerts' && list.length > limit && (
            <button className="btn btn-sm btn-ghost" onClick={() => setExpanded(true)}>
              +{list.length - limit} more
            </button>
          )}
        </div>

        {sheet && (
          <div className="wg-sheet" role="dialog" aria-label={sheet === 'settings' ? 'Widget settings' : 'Help'}>
            <div className="wg-sheet-head">
              <strong>{sheet === 'settings' ? 'Settings' : 'How it works'}</strong>
              <span className="spacer" />
              <button className="wg-win" aria-label="Close" onClick={() => setSheet(null)}>
                <X size={14} />
              </button>
            </div>
            {sheet === 'settings' ? (
              <SettingsSheet variant={variant} host={host} setHostFlag={setHostFlag} openDashboard={openDashboard} />
            ) : (
              <HelpSheet />
            )}
          </div>
        )}
      </main>

      <footer className="wg-foot">
        <Pill on={prefs.dueSoon} onClick={() => setPrefs({ dueSoon: !prefs.dueSoon })} title="Show only tasks that are overdue or due today">
          Due soon
        </Pill>
        {isHost && host && (
          <Pill on={host.alwaysOnTop} onClick={() => setHostFlag('alwaysOnTop', !host.alwaysOnTop)} title="Keep the widget above other windows">
            On top
          </Pill>
        )}
        {isHost && host && (
          <Pill on={host.hideFromCapture} onClick={() => setHostFlag('hideFromCapture', !host.hideFromCapture)} title="Hide the widget from screen sharing and recordings">
            Private
          </Pill>
        )}
        <span className="spacer" />
        {host?.updateReady && (
          <button className="wg-tool update" title={`TaskSync ${host.updateReady} is ready — restart to use it`} aria-label="Restart to update" onClick={() => desktop.restartToUpdate()}>
            <RefreshCw size={14} />
          </button>
        )}
        <button className="wg-tool spark" title="Open the full TaskSync dashboard" aria-label="Open full dashboard" onClick={() => openDashboard('/')}>
          <Sparkles size={15} />
        </button>
        <button className={`wg-tool ${sheet === 'help' ? 'on' : ''}`} title="Help" aria-label="Help" onClick={() => setSheet(sheet === 'help' ? null : 'help')}>
          <CircleHelp size={15} />
        </button>
        <button className={`wg-tool ${sheet === 'settings' ? 'on' : ''}`} title="Settings" aria-label="Settings" onClick={() => setSheet(sheet === 'settings' ? null : 'settings')}>
          <Settings2 size={15} />
        </button>
      </footer>
    </div>
  );
}

function Pill({ on, onClick, title, children }: { on: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button type="button" className={`wg-pill ${on ? 'on' : ''}`} aria-pressed={on} title={title} onClick={onClick}>
      <span className="knob" aria-hidden />
      {children}
    </button>
  );
}

function ConnectionDot({ status, queued, onRetry }: { status: ConnectionStatus; queued: number; onRetry?: () => void }) {
  const label =
    status === 'live'
      ? 'Live — changes sync instantly'
      : status === 'polling'
        ? 'Connected (checking for updates every few seconds)'
        : status === 'offline'
          ? `Offline${queued ? ` — ${queued} change${queued === 1 ? '' : 's'} waiting to sync` : ''}. Click to retry.`
          : 'Reconnecting…';
  return (
    <button className={`wg-dot ${status}`} title={label} aria-label={label} onClick={() => status !== 'live' && onRetry?.()}>
      {queued > 0 && <span>{queued}</span>}
    </button>
  );
}

function Row({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="wg-row">
      <div className="col" style={{ gap: 0, flex: 1, minWidth: 0 }}>
        <strong>{title}</strong>
        {desc && <span className="tiny faint">{desc}</span>}
      </div>
      {children}
    </div>
  );
}

function SettingsSheet({
  variant,
  host,
  setHostFlag,
  openDashboard,
}: {
  variant: Variant;
  host: HostState | null;
  setHostFlag: (key: 'alwaysOnTop' | 'autoStart' | 'hideFromCapture' | 'stayOnDesktop', value: boolean) => void;
  openDashboard: (path?: string) => void;
}) {
  const prefs = useStore((s) => s.preferences);
  const [asWidget, setAsWidget] = useState(appOpensAsWidget());
  const setPref = async (key: keyof Preferences, value: boolean) => {
    try {
      await savePreferences({ [key]: value });
    } catch (err) {
      toastError(err, 'Could not save');
    }
  };
  return (
    <div className="wg-sheet-body">
      {variant === 'host' && host && (
        <>
          {host.updateReady && (
            <Row title={`Version ${host.updateReady} is ready`} desc="Downloaded in the background. It also starts by itself next time.">
              <button className="btn btn-sm btn-primary" onClick={() => desktop.restartToUpdate()}>
                Restart
              </button>
            </Row>
          )}
          <Row title="Start with Windows" desc="Open the widget when you sign in">
            <Switch label="Start with Windows" on={host.autoStart} onChange={(v) => setHostFlag('autoStart', v)} />
          </Row>
          <Row title="Keep on top" desc="Float above other windows">
            <Switch label="Keep on top" on={host.alwaysOnTop} onChange={(v) => setHostFlag('alwaysOnTop', v)} />
          </Row>
          <Row title="Hide from screen sharing" desc="Invisible in Teams/Zoom shares and recordings">
            <Switch label="Hide from screen sharing" on={host.hideFromCapture} onChange={(v) => setHostFlag('hideFromCapture', v)} />
          </Row>
          <Row title="Stay on Show desktop" desc="Remains visible on Win+D and desktop peek">
            <Switch label="Stay on Show desktop" on={host.stayOnDesktop} onChange={(v) => setHostFlag('stayOnDesktop', v)} />
          </Row>
        </>
      )}
      {variant === 'browser' && isInstalledApp() && (
        <Row title="Open the app as this widget" desc="Off: the app opens the full dashboard">
          <Switch
            label="Open the app as this widget"
            on={asWidget}
            onChange={(v) => {
              setAppOpensAsWidget(v);
              setAsWidget(v);
            }}
          />
        </Row>
      )}
      {prefs && (
        <Row title="Pop-up alerts" desc="Windows notifications for new assignments and comments">
          <Switch label="Pop-up alerts" on={prefs.desktopToasts} onChange={(v) => void setPref('desktopToasts', v)} />
        </Row>
      )}
      <div className="row" style={{ gap: 8, marginTop: 4 }}>
        <button className="btn btn-sm" onClick={() => openDashboard('/settings')}>
          All settings
        </button>
        <span className="spacer" />
        <span className="tiny faint">{host ? `Windows app ${host.version}` : variant === 'pip' ? 'Floating widget' : isInstalledApp() ? 'Edge app' : 'Browser'}</span>
      </div>
    </div>
  );
}

function HelpSheet() {
  const tips: [string, string][] = [
    ['Add a task', 'Type in the box at the top and press Enter. It is assigned to you.'],
    ['Assign a colleague', 'Type @ and part of their name, then pick them. Click “Me” to add or remove yourself.'],
    ['Finish or change a task', 'Tick the circle to complete it; click a task to open it for comments and status.'],
    ['Due soon', 'The toggle below shows only tasks that are overdue or due today.'],
    ['Bigger view', 'Double-click the title bar, or use ⤢, to show every task. ✦ opens the full dashboard.'],
  ];
  return (
    <div className="wg-sheet-body">
      {tips.map(([t, d]) => (
        <div key={t} className="col" style={{ gap: 0 }}>
          <strong>{t}</strong>
          <span className="small faint">{d}</span>
        </div>
      ))}
    </div>
  );
}
