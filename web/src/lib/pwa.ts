import { useSyncExternalStore } from 'react';

// "Install as an app" support for Microsoft Edge / Chrome. Installing needs no admin rights and
// no .exe: Edge (already approved software) hosts TaskSync in its own window with a taskbar icon,
// Windows notifications and an optional start-on-login setting.

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we show our own button in Settings
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    emit();
  });
}

export function isInstalledApp(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches === true;
}

export function useCanInstall(): boolean {
  return useSyncExternalStore(
    (s) => {
      subs.add(s);
      return () => subs.delete(s);
    },
    () => deferred !== null,
  );
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  emit();
  return outcome === 'accepted';
}

/** Count on the taskbar icon of the installed app (no-op in a normal tab or unsupported browsers). */
export function setTaskbarBadge(count: number) {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    if (count > 0) void nav.setAppBadge?.(count).catch(() => undefined);
    else void nav.clearAppBadge?.().catch(() => undefined);
  } catch {
    // not supported
  }
}

// ---------------------------------------------------------------------------
// Installed-app window as the widget
// ---------------------------------------------------------------------------

const WIDGET_PREF = 'tasksync.appOpensAsWidget';

/** Whether the installed app should open as the small widget (default) instead of the full dashboard. */
export function appOpensAsWidget(): boolean {
  try {
    return localStorage.getItem(WIDGET_PREF) !== 'false';
  } catch {
    return true;
  }
}

export function setAppOpensAsWidget(value: boolean) {
  try {
    localStorage.setItem(WIDGET_PREF, String(value));
  } catch {
    // storage unavailable: keep the default
  }
}

/**
 * Best-effort resize of the installed app window (Edge allows this for app windows; in a
 * normal tab it's ignored). Edge also remembers the size you leave the app window at.
 */
export function shapeAppWindow(kind: 'widget' | 'dashboard') {
  if (!isInstalledApp()) return;
  try {
    if (kind === 'widget') {
      const w = 400;
      const h = Math.min(680, screen.availHeight - 40);
      window.resizeTo(w, h);
      window.moveTo(screen.availWidth - w - 16, screen.availHeight - h - 16);
    } else {
      const w = Math.min(1280, screen.availWidth - 80);
      const h = Math.min(860, screen.availHeight - 60);
      window.resizeTo(w, h);
      window.moveTo(Math.round((screen.availWidth - w) / 2), Math.round((screen.availHeight - h) / 2));
    }
  } catch {
    // not allowed here
  }
}
