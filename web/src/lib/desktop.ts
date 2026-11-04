// Bridge to the TaskSync Windows companion (C#/.NET + WebView2).
// In a normal browser every call is a no-op or falls back to a web API.

export interface HostState {
  version: string;
  alwaysOnTop: boolean;
  autoStart: boolean;
  mode: 'compact' | 'expanded';
  /** Widget is invisible to screen sharing, recordings and screenshots. */
  hideFromCapture: boolean;
  /** Widget stays visible on Show Desktop (Win+D), Win+M and desktop peek. */
  stayOnDesktop: boolean;
  /** A newer Windows app version has been downloaded and starts on restart. */
  updateReady?: string | null;
}

type HostMessage =
  | { type: 'hostState'; state: HostState }
  | { type: 'openTask'; taskId: string }
  | { type: 'navigate'; path: string }
  | { type: 'resume' }
  | { type: 'openSheet'; sheet: string };

interface WebViewBridge {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
}

const bridge: WebViewBridge | undefined = (globalThis as { chrome?: { webview?: WebViewBridge } }).chrome?.webview;

export const isDesktop = Boolean(bridge);

function send(type: string, payload: Record<string, unknown> = {}) {
  bridge?.postMessage({ type, ...payload });
}

export const desktop = {
  isDesktop,
  /** Windows toast notification from the tray app; browsers use the Notification API when allowed. */
  notify(title: string, body = '', taskId?: string | null) {
    if (bridge) {
      send('notify', { title, body, taskId: taskId ?? null });
      return;
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState === 'hidden') {
      try {
        const n = new Notification(title, { body, icon: '/favicon.svg', tag: taskId ?? undefined });
        n.onclick = () => {
          window.focus();
          if (taskId) window.dispatchEvent(new CustomEvent('tasksync:open-task', { detail: taskId }));
        };
      } catch {
        // some browsers only allow notifications from a service worker
      }
    }
  },
  copyImage(base64Png: string) {
    send('copyImage', { data: base64Png });
  },
  openExternal(url: string) {
    send('openExternal', { url });
  },
  openDashboard(path = '/') {
    send('openDashboard', { path });
  },
  setMode(mode: 'compact' | 'expanded') {
    send('setMode', { mode });
  },
  setAlwaysOnTop(value: boolean) {
    send('setAlwaysOnTop', { value });
  },
  setAutoStart(value: boolean) {
    send('setAutoStart', { value });
  },
  setHideFromCapture(value: boolean) {
    send('setHideFromCapture', { value });
  },
  setStayOnDesktop(value: boolean) {
    send('setStayOnDesktop', { value });
  },
  startDrag() {
    send('startDrag');
  },
  minimizeToTray() {
    send('minimizeToTray');
  },
  restartToUpdate() {
    send('restartToUpdate');
  },
  requestState() {
    send('getState');
  },
  setBadge(count: number) {
    send('setBadge', { count });
  },
  onMessage(fn: (msg: HostMessage) => void): () => void {
    if (!bridge) return () => undefined;
    const listener = (e: { data: unknown }) => {
      const data = typeof e.data === 'string' ? safeParse(e.data) : e.data;
      if (data && typeof data === 'object' && 'type' in data) fn(data as HostMessage);
    };
    bridge.addEventListener('message', listener);
    return () => bridge.removeEventListener('message', listener);
  },
};

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
