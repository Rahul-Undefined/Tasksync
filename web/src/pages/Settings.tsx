import { useEffect, useState } from 'react';
import type { Preferences } from '@tasksync/shared';
import { Bell, LogOut, Monitor, Save, UserRound } from 'lucide-react';
import { Avatar, Switch } from '../components/ui';
import { desktop, isDesktop, type HostState } from '../lib/desktop';
import { savePreferences, saveProfile, toast, toastError, useStore } from '../lib/store';

export function SettingsPage({ onSignOut, version }: { onSignOut: () => void; version: string }) {
  const me = useStore((s) => s.me)!;
  const prefs = useStore((s) => s.preferences);
  const [profile, setProfile] = useState({
    jobTitle: me.jobTitle ?? '',
    department: me.department ?? '',
    officeLocation: me.officeLocation ?? '',
    phone: me.phone ?? '',
    about: me.about ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [host, setHost] = useState<HostState | null>(null);
  const [browserNotif, setBrowserNotif] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');

  useEffect(() => {
    if (!isDesktop) return;
    const off = desktop.onMessage((m) => m.type === 'hostState' && setHost(m.state));
    desktop.requestState();
    return off;
  }, []);

  const setPref = async (key: keyof Preferences, value: boolean) => {
    try {
      await savePreferences({ [key]: value });
    } catch (err) {
      toastError(err, 'Could not save preference');
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveProfile(Object.fromEntries(Object.entries(profile).map(([k, v]) => [k, v.trim() || null])));
      toast({ kind: 'success', title: 'Profile saved' }, 2500);
    } catch (err) {
      toastError(err, 'Could not save profile');
    } finally {
      setSaving(false);
    }
  };

  const field = (key: keyof typeof profile, label: string, max: number) => (
    <div className="field">
      <label className="label" htmlFor={`p-${key}`}>{label}</label>
      <input id={`p-${key}`} className="input" value={profile[key]} maxLength={max} onChange={(e) => setProfile({ ...profile, [key]: e.target.value })} />
    </div>
  );

  return (
    <div className="content-inner" style={{ maxWidth: 760 }}>
      <section className="glass" style={{ padding: 20 }}>
        <div className="row" style={{ gap: 14, marginBottom: 16 }}>
          <Avatar id={me.id} name={me.displayName} size="lg" />
          <div className="col" style={{ gap: 0 }}>
            <strong style={{ fontSize: 17 }}>{me.displayName}</strong>
            <span className="muted small">{me.email} · {me.role === 'admin' ? 'Administrator' : 'Employee'}</span>
          </div>
          <span className="spacer" />
          <button className="btn btn-danger" onClick={onSignOut}>
            <LogOut size={15} /> Sign out
          </button>
        </div>
        <div className="block-title row" style={{ gap: 6 }}>
          <UserRound size={14} /> Profile
        </div>
        <p className="faint small" style={{ marginTop: 0 }}>Your name and email come from your Microsoft account. Colleagues see these details in your profile.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          {field('jobTitle', 'Job title', 120)}
          {field('department', 'Department', 120)}
          {field('officeLocation', 'Office location', 120)}
          {field('phone', 'Phone', 40)}
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label className="label" htmlFor="p-about">About</label>
          <textarea id="p-about" className="textarea" rows={2} maxLength={500} value={profile.about} onChange={(e) => setProfile({ ...profile, about: e.target.value })} />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            <Save size={15} /> Save profile
          </button>
        </div>
      </section>

      <section className="glass" style={{ padding: 20 }}>
        <div className="block-title row" style={{ gap: 6 }}>
          <Bell size={14} /> Notifications
        </div>
        {prefs && (
          <div className="col" style={{ gap: 14 }}>
            {(
              [
                ['notifyAssigned', 'Assignments', 'When someone assigns, reassigns or removes you'],
                ['notifyStatus', 'Status changes', 'When tasks you are on are started, completed, declined or cancelled'],
                ['notifyComments', 'Comments & mentions', 'When someone comments on or @mentions you in a task'],
                ['desktopToasts', 'Pop-up alerts', 'Show Windows notifications (desktop app) or browser notifications'],
              ] as const
            ).map(([key, title, desc]) => (
              <div className="row" key={key} style={{ gap: 14 }}>
                <div className="col" style={{ gap: 0, flex: 1 }}>
                  <strong>{title}</strong>
                  <span className="small faint">{desc}</span>
                </div>
                <Switch label={title} on={prefs[key]} onChange={(v) => setPref(key, v)} />
              </div>
            ))}
            {!isDesktop && typeof Notification !== 'undefined' && browserNotif !== 'granted' && (
              <div className="banner glass">
                Browser notifications are {browserNotif === 'denied' ? 'blocked in your browser settings' : 'not enabled'}.
                <span className="spacer" />
                {browserNotif === 'default' && (
                  <button className="btn btn-sm" onClick={async () => setBrowserNotif(await Notification.requestPermission())}>
                    Enable
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="glass" style={{ padding: 20 }}>
        <div className="block-title row" style={{ gap: 6 }}>
          <Monitor size={14} /> Windows desktop app
        </div>
        {!isDesktop ? (
          <p className="muted small" style={{ margin: 0 }}>
            Install the TaskSync desktop companion for a floating widget, tray icon and Windows notifications. These settings appear here when you open
            Settings from the desktop app.
          </p>
        ) : !host ? (
          <p className="muted small">Connecting to the desktop app…</p>
        ) : (
          <div className="col" style={{ gap: 14 }}>
            <div className="row" style={{ gap: 14 }}>
              <div className="col" style={{ gap: 0, flex: 1 }}>
                <strong>Start with Windows</strong>
                <span className="small faint">Open the TaskSync widget automatically when you sign in to Windows</span>
              </div>
              <Switch
                label="Start with Windows"
                on={host.autoStart}
                onChange={(v) => {
                  desktop.setAutoStart(v);
                  setHost({ ...host, autoStart: v });
                }}
              />
            </div>
            <div className="row" style={{ gap: 14 }}>
              <div className="col" style={{ gap: 0, flex: 1 }}>
                <strong>Keep widget on top</strong>
                <span className="small faint">Float the widget above other windows</span>
              </div>
              <Switch
                label="Always on top"
                on={host.alwaysOnTop}
                onChange={(v) => {
                  desktop.setAlwaysOnTop(v);
                  setHost({ ...host, alwaysOnTop: v });
                }}
              />
            </div>
            <div className="row" style={{ gap: 14 }}>
              <div className="col" style={{ gap: 0, flex: 1 }}>
                <strong>Hide from screen sharing</strong>
                <span className="small faint">
                  The widget stays visible to you but does not appear in Teams/Zoom screen shares, recordings or screenshots
                </span>
              </div>
              <Switch
                label="Hide from screen sharing"
                on={host.hideFromCapture}
                onChange={(v) => {
                  desktop.setHideFromCapture(v);
                  setHost({ ...host, hideFromCapture: v });
                }}
              />
            </div>
            <div className="row" style={{ gap: 14 }}>
              <div className="col" style={{ gap: 0, flex: 1 }}>
                <strong>Stay visible on Show desktop</strong>
                <span className="small faint">Keep the widget on screen when you press Win+D or Win+M, or peek at the desktop</span>
              </div>
              <Switch
                label="Stay visible on Show desktop"
                on={host.stayOnDesktop}
                onChange={(v) => {
                  desktop.setStayOnDesktop(v);
                  setHost({ ...host, stayOnDesktop: v });
                }}
              />
            </div>
            <span className="tiny faint">Desktop app version {host.version}</span>
          </div>
        )}
      </section>
      <p className="faint tiny" style={{ textAlign: 'center' }}>TaskSync {version} · Omnifi internal use only</p>
    </div>
  );
}
