import type { RealtimeEvent, ServerMessage } from '@tasksync/shared';

export type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'polling' | 'reconnecting' | 'offline' | 'denied';

export interface PollResult {
  events: RealtimeEvent[];
  lastEventId: number;
  resync: boolean;
}

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface RealtimeOptions {
  url: string;
  getToken: (opts?: { forceRefresh?: boolean }) => Promise<string>;
  onEvent: (event: RealtimeEvent) => void;
  /** Called when the client missed too much and must reload state over REST. */
  onResync: () => void;
  onStatus?: (status: ConnectionStatus) => void;
  /** Called after any successful (re)connection, with whether it was a reconnect. */
  onReady?: (reconnected: boolean) => void;
  /** The server refused the session (account deactivated / not approved). */
  onDenied?: (reason: string) => void;
  createSocket?: (url: string) => SocketLike;
  random?: () => number;
  /**
   * HTTP fallback (GET /api/events?since=). Used when WebSockets keep failing while the
   * network is up, e.g. behind a corporate proxy that blocks WebSocket upgrades.
   */
  poll?: (since: number) => Promise<PollResult>;
  pollIntervalMs?: number;
}

/** Consecutive WebSocket attempts that never became ready before switching to HTTP polling. */
export const FALLBACK_AFTER_FAILURES = 3;

const OPEN = 1;
const PING_EVERY = 25_000;
const STALE_AFTER = 65_000;
const TOKEN_REFRESH_EVERY = 40 * 60_000;

/**
 * Resilient realtime connection:
 *  - authenticates in-band (tokens never appear in URLs or logs),
 *  - resumes from the last applied event id so nothing is missed while offline,
 *  - drops duplicates (ids at or below the cursor),
 *  - reconnects with exponential backoff + jitter, immediately when the network returns,
 *  - detects silent dead connections with heartbeats.
 */
export class RealtimeClient {
  private socket: SocketLike | null = null;
  private status: ConnectionStatus = 'idle';
  private lastEventId = 0;
  private attempts = 0;
  private everReady = false;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private lastMessageAt = 0;
  private lastAuthAt = 0;
  private forceRefresh = false;
  private resynced = false;
  private failedAttempts = 0;
  private socketReady = false;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly random: () => number;

  constructor(private readonly opts: RealtimeOptions) {
    this.createSocket = opts.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.random = opts.random ?? Math.random;
  }

  get cursor() {
    return this.lastEventId;
  }

  get state() {
    return this.status;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('offline', this.handleOffline);
      document.addEventListener('visibilitychange', this.handleVisible);
    }
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.stopPolling();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline);
      window.removeEventListener('offline', this.handleOffline);
      document.removeEventListener('visibilitychange', this.handleVisible);
    }
    const s = this.socket;
    this.socket = null;
    s?.close(1000, 'client_stop');
    this.setStatus('idle');
  }

  /** Reconnect now (e.g. user clicked "retry"). */
  reconnectNow() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.attempts = 0;
    this.socket?.close(1000, 'manual_reconnect');
    this.socket = null;
    this.connect();
  }

  private setStatus(s: ConnectionStatus) {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }

  private connect() {
    if (this.stopped) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.setStatus('offline');
      return;
    }
    if (!this.polling) this.setStatus(this.everReady ? 'reconnecting' : 'connecting');
    this.socketReady = false;
    let socket: SocketLike;
    try {
      socket = this.createSocket(this.opts.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.onopen = async () => {
      try {
        const token = await this.opts.getToken({ forceRefresh: this.forceRefresh });
        this.forceRefresh = false;
        if (this.socket !== socket || socket.readyState !== OPEN) return;
        this.lastAuthAt = Date.now();
        socket.send(JSON.stringify({ type: 'auth', token, since: this.lastEventId }));
      } catch {
        socket.close(4000, 'token_unavailable');
      }
    };

    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.lastMessageAt = Date.now();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };

    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      clearInterval(this.pingTimer);
      if (this.stopped) return;
      if (ev.code === 4403) {
        this.setStatus('denied');
        this.opts.onDenied?.(ev.reason);
        return;
      }
      if (ev.code === 4401) this.forceRefresh = true;
      if (!this.socketReady) this.failedAttempts++;
      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      if (online && this.opts.poll && this.failedAttempts >= FALLBACK_AFTER_FAILURES) this.startPolling();
      this.scheduleRetry(ev.code === 4401 && this.attempts === 0);
    };

    socket.onerror = () => {
      // onclose follows and handles the retry
    };
  }

  private applyEvent(event: RealtimeEvent) {
    if (event.id <= this.lastEventId) return; // duplicate or already applied
    this.lastEventId = event.id;
    this.opts.onEvent(event);
  }

  private handleMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'event':
        this.applyEvent(msg.event);
        return;
      case 'resync':
        // Trust the server's cursor: after a restore it can be lower than ours, and keeping
        // ours would make us drop the new events as "duplicates".
        this.lastEventId = msg.lastEventId;
        this.resynced = true;
        this.opts.onResync();
        return;
      case 'ready': {
        const reconnected = this.everReady;
        this.everReady = true;
        this.attempts = 0;
        this.failedAttempts = 0;
        this.socketReady = true;
        this.stopPolling(); // WebSockets work again
        this.lastEventId = this.resynced ? msg.lastEventId : Math.max(this.lastEventId, msg.lastEventId);
        this.resynced = false;
        this.setStatus('live');
        this.startHeartbeat();
        this.opts.onReady?.(reconnected);
        return;
      }
      case 'error':
        return;
      case 'pong':
        return;
    }
  }

  private startHeartbeat() {
    clearInterval(this.pingTimer);
    this.lastMessageAt = Date.now();
    this.pingTimer = setInterval(async () => {
      const s = this.socket;
      if (!s || s.readyState !== OPEN) return;
      if (Date.now() - this.lastMessageAt > STALE_AFTER) {
        s.close(4000, 'stale'); // silent network drop: force a reconnect
        return;
      }
      s.send(JSON.stringify({ type: 'ping', t: Date.now() }));
      if (Date.now() - this.lastAuthAt > TOKEN_REFRESH_EVERY) {
        try {
          const token = await this.opts.getToken();
          this.lastAuthAt = Date.now();
          if (this.socket === s && s.readyState === OPEN) s.send(JSON.stringify({ type: 'auth', token }));
        } catch {
          // the server will close at expiry and we reconnect with a fresh token
        }
      }
    }, PING_EVERY);
  }

  get isPolling() {
    return this.polling;
  }

  private startPolling() {
    if (this.polling || !this.opts.poll) return;
    this.polling = true;
    this.setStatus('polling');
    const tick = async () => {
      if (!this.polling) return;
      try {
        const res = await this.opts.poll!(this.lastEventId);
        if (!this.polling) return;
        if (res.resync) {
          this.lastEventId = res.lastEventId;
          this.opts.onResync();
        } else {
          for (const e of res.events) this.applyEvent(e);
          // A fresh client (cursor 0) adopts the server cursor without replaying history.
          if (this.lastEventId === 0) this.lastEventId = res.lastEventId;
        }
        this.setStatus('polling');
      } catch {
        // keep polling; the API client already waits out cold starts
      }
    };
    void tick();
    this.pollTimer = setInterval(tick, this.opts.pollIntervalMs ?? 15_000);
  }

  private stopPolling() {
    this.polling = false;
    clearInterval(this.pollTimer);
  }

  /** Backoff: 1s, 2s, 4s … capped at 30s, with ±30% jitter so clients don't stampede a cold server. */
  backoffDelay(attempt: number): number {
    const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
    return Math.round(base * (0.7 + this.random() * 0.6));
  }

  private scheduleRetry(immediate = false) {
    clearTimeout(this.retryTimer);
    if (this.stopped) return;
    this.attempts++;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (offline) this.setStatus('offline');
    else if (!this.polling) this.setStatus('reconnecting');
    // While polling works, probe WebSockets only occasionally.
    const delay = immediate ? 0 : this.polling ? 120_000 : this.backoffDelay(this.attempts);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private handleOnline = () => this.reconnectNow();
  private handleOffline = () => {
    this.stopPolling();
    this.setStatus('offline');
    this.socket?.close(4000, 'offline');
  };
  private handleVisible = () => {
    if (document.visibilityState === 'visible' && !['live', 'polling', 'denied'].includes(this.status)) this.reconnectNow();
  };
}

export function realtimeUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/realtime`;
}
