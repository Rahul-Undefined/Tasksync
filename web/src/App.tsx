import { useCallback, useEffect, useRef, useState } from 'react';
import type { Preferences, UserProfile } from '@tasksync/shared';
import { ApiError, errorMessage, get, onServerWaking, setTokenProvider } from './lib/api';
import { createDevAuth, createEntraAuth, type AuthClient, type ClientConfig } from './lib/auth';
import { desktop } from './lib/desktop';
import { RealtimeClient, realtimeUrl, type PollResult } from './lib/realtime';
import { navigate, usePath } from './lib/router';
import { appOpensAsWidget, isInstalledApp, shapeAppWindow } from './lib/pwa';
import {
  applyEvent,
  flushOutbox,
  getState,
  loadAll,
  openTask,
  refreshDirectory,
  resetStore,
  setConnection,
  setMe,
  setServerWaking,
  setUserUpdatedHandler,
  toast,
  useStore,
} from './lib/store';
import { AccessScreen, ErrorScreen, LoadingScreen, SetupScreen, SignInScreen } from './pages/Gates';
import { WidgetPage } from './pages/Widget';
import { Shell, Toasts } from './Shell';
import { PersonMenuHost } from './components/PersonMenu';
import { TaskDrawer } from './components/TaskDrawer';

type Phase =
  | { kind: 'booting' }
  | { kind: 'error'; message: string }
  | { kind: 'setup'; config: ClientConfig | null }
  | { kind: 'signed-out'; config: ClientConfig; auth: AuthClient; error?: string }
  | { kind: 'gated'; config: ClientConfig; auth: AuthClient; me: UserProfile }
  | { kind: 'ready'; config: ClientConfig; auth: AuthClient };

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'booting' });
  const waking = useStore((s) => s.serverWaking);
  const realtime = useRef<RealtimeClient | null>(null);
  const path = usePath();
  const isWidget = path === '/widget';

  useEffect(() => onServerWaking(setServerWaking), []);

  const loadMe = useCallback(async (config: ClientConfig, auth: AuthClient) => {
    try {
      const res = await get<{ user: UserProfile; preferences: Preferences | null }>('/api/me');
      setMe(res.user, res.preferences);
      if (res.user.status !== 'approved') {
        realtime.current?.stop();
        setPhase({ kind: 'gated', config, auth, me: res.user });
        return;
      }
      setPhase({ kind: 'ready', config, auth });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        // e.g. personal account, other tenant, guest — show why on the sign-in screen
        await auth.signOut().catch(() => undefined);
        setPhase({ kind: 'signed-out', config, auth, error: err.message });
        return;
      }
      if (err instanceof ApiError && err.status === 503) {
        setPhase({ kind: 'setup', config });
        return;
      }
      setPhase({ kind: 'error', message: errorMessage(err) });
    }
  }, []);

  const boot = useCallback(async () => {
    setPhase({ kind: 'booting' });
    try {
      const config = await get<ClientConfig>('/api/config');
      if (config.authMode === 'not_configured' || !config.databaseConfigured) {
        setPhase({ kind: 'setup', config });
        return;
      }
      const auth = config.authMode === 'entra' && config.entra ? await createEntraAuth(config.entra, config.allowedDomains) : createDevAuth();
      setTokenProvider((o) => auth.getToken(o));
      if (!auth.account) {
        setPhase({ kind: 'signed-out', config, auth });
        return;
      }
      await loadMe(config, auth);
    } catch (err) {
      setPhase({ kind: 'error', message: errorMessage(err) });
    }
  }, [loadMe]);

  useEffect(() => {
    void boot();
  }, [boot]);

  // Start data + realtime once approved.
  useEffect(() => {
    if (phase.kind !== 'ready') return;
    const { auth, config } = phase;
    loadAll().catch((err) => toast({ kind: 'error', title: 'Could not load tasks', body: errorMessage(err) }));
    let lastSync = Date.now();
    const client = new RealtimeClient({
      url: realtimeUrl(),
      getToken: (o) => auth.getToken(o),
      onEvent: applyEvent,
      onResync: () => void loadAll().catch(() => undefined),
      onStatus: setConnection,
      onReady: (reconnected) => {
        lastSync = Date.now();
        void flushOutbox();
        // After a reconnect the replayed events cover the gap, but a full refresh also
        // repairs anything stale (e.g. tasks we lost access to while offline).
        if (reconnected) void loadAll().catch(() => undefined);
      },
      onDenied: () => void loadMe(config, auth),
      poll: (since) => get<PollResult>(`/api/events?since=${since}`),
    });
    realtime.current = client;
    client.start();

    // Morning / wake-up refresh: after the window has been hidden or the PC asleep for a while,
    // reload everything so the widget shows the latest tasks (realtime replay covers short gaps).
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 2 * 60_000) {
        void loadAll().catch(() => undefined);
        client.reconnectNow();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    const staleTimer = setInterval(() => {
      // Timers pause while the PC sleeps, so a big gap between ticks means it just woke up.
      if (Date.now() - lastSync > 10 * 60_000) {
        lastSync = Date.now();
        void loadAll().catch(() => undefined);
      }
    }, 60_000);
    setUserUpdatedHandler((d) => {
      if (d.userId === getState().me?.id) void loadMe(config, auth);
      else void refreshDirectory().catch(() => undefined);
      window.dispatchEvent(new CustomEvent('tasksync:users-changed'));
    });
    return () => {
      client.stop();
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(staleTimer);
    };
  }, [phase.kind === 'ready' ? phase.auth : null]); // eslint-disable-line react-hooks/exhaustive-deps

  // The installed Windows app opens as the small widget (one window, no separate dashboard).
  useEffect(() => {
    if (phase.kind !== 'ready' || !isInstalledApp() || !appOpensAsWidget()) return;
    if (sessionStorage.getItem('tasksync.launched')) return; // only on app start, not every navigation
    sessionStorage.setItem('tasksync.launched', '1');
    if (window.location.pathname === '/') {
      navigate('/widget', true);
      shapeAppWindow('widget');
    }
  }, [phase.kind]);

  // While waiting for approval, poll so the screen updates as soon as an admin approves.
  useEffect(() => {
    if (phase.kind !== 'gated' || phase.me.status !== 'pending') return;
    const t = setInterval(() => void loadMe(phase.config, phase.auth), 15_000);
    return () => clearInterval(t);
  }, [phase, loadMe]);

  // Desktop host and browser notifications can ask us to open a task.
  useEffect(() => {
    const offHost = desktop.onMessage((m) => {
      if (m.type === 'openTask') openTask(m.taskId);
      if (m.type === 'navigate' && m.path.startsWith('/')) navigate(m.path);
      if (m.type === 'resume') realtime.current?.reconnectNow(); // PC woke from sleep
    });
    const onOpen = (e: Event) => openTask((e as CustomEvent<string>).detail);
    window.addEventListener('tasksync:open-task', onOpen);
    const params = new URLSearchParams(window.location.search);
    const task = params.get('task');
    if (task && /^[0-9a-f-]{36}$/i.test(task)) openTask(task);
    return () => {
      offHost();
      window.removeEventListener('tasksync:open-task', onOpen);
    };
  }, []);

  const signOut = async () => {
    if (phase.kind !== 'ready' && phase.kind !== 'gated') return;
    realtime.current?.stop();
    resetStore();
    await phase.auth.signOut();
    if (phase.auth.mode === 'dev') void boot();
  };

  switch (phase.kind) {
    case 'booting':
      return <LoadingScreen waking={waking} />;
    case 'error':
      return <ErrorScreen message={phase.message} onRetry={boot} />;
    case 'setup':
      return <SetupScreen config={phase.config} />;
    case 'signed-out':
      return <SignInScreen auth={phase.auth} config={phase.config} error={phase.error} />;
    case 'gated':
      return <AccessScreen me={phase.me} onRefresh={() => loadMe(phase.config, phase.auth)} onSignOut={signOut} />;
    case 'ready':
      return isWidget ? (
        <>
          <WidgetPage onReconnect={() => realtime.current?.reconnectNow()} />
          <TaskDrawer />
          <PersonMenuHost />
          <Toasts />
        </>
      ) : (
        <Shell onSignOut={signOut} onReconnect={() => realtime.current?.reconnectNow()} version={phase.config.version} />
      );
  }
}
