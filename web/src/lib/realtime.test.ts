import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeEvent, ServerMessage } from '@tasksync/shared';
import { FALLBACK_AFTER_FAILURES, RealtimeClient, type ConnectionStatus, type PollResult, type SocketLike } from './realtime';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const ev = (id: number, type: RealtimeEvent['type'] = 'task.upsert'): RealtimeEvent => ({
  id,
  type,
  taskId: 't',
  data: { id },
  createdAt: new Date().toISOString(),
});

function setup(extra: { poll?: (since: number) => Promise<PollResult> } = {}) {
  const sockets: FakeSocket[] = [];
  const events: number[] = [];
  const statuses: ConnectionStatus[] = [];
  const resyncs: number[] = [];
  const denied: string[] = [];
  const tokens: boolean[] = [];
  const client = new RealtimeClient({
    url: 'ws://test/api/realtime',
    getToken: async (o) => {
      tokens.push(Boolean(o?.forceRefresh));
      return 'token';
    },
    onEvent: (e) => events.push(e.id),
    onResync: () => resyncs.push(1),
    onStatus: (s) => statuses.push(s),
    onDenied: (r) => denied.push(r),
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    random: () => 0.5,
    pollIntervalMs: 1000,
    ...extra,
  });
  return { client, sockets, events, statuses, resyncs, denied, tokens };
}

async function openAndReady(s: FakeSocket, lastEventId = 0) {
  s.open();
  await vi.waitFor(() => expect(s.sent.length).toBeGreaterThan(0));
  s.receive({ type: 'ready', userId: 'u', lastEventId, replayed: 0 });
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe('RealtimeClient', () => {
  it('authenticates in-band with the cursor and goes live', async () => {
    const t = setup();
    t.client.start();
    await openAndReady(t.sockets[0]!, 41);
    expect(t.sockets[0]!.sent[0]).toEqual({ type: 'auth', token: 'token', since: 0 });
    expect(t.client.state).toBe('live');
    expect(t.client.cursor).toBe(41);
    t.client.stop();
  });

  it('drops duplicate and out-of-date events (ids at or below the cursor)', async () => {
    const t = setup();
    t.client.start();
    await openAndReady(t.sockets[0]!, 10);
    for (const id of [11, 12, 12, 9, 13, 11]) t.sockets[0]!.receive({ type: 'event', event: ev(id) });
    expect(t.events).toEqual([11, 12, 13]);
    t.client.stop();
  });

  it('reconnects with backoff and resumes from the last applied event', async () => {
    const t = setup();
    t.client.start();
    await openAndReady(t.sockets[0]!, 5);
    t.sockets[0]!.receive({ type: 'event', event: ev(6) });
    t.sockets[0]!.close(1006, 'network');
    expect(t.client.state).toBe('reconnecting');
    expect(t.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1100);
    expect(t.sockets).toHaveLength(2);
    t.sockets[1]!.open();
    await vi.waitFor(() => expect(t.sockets[1]!.sent.length).toBe(1));
    expect(t.sockets[1]!.sent[0]).toMatchObject({ since: 6 });
    t.client.stop();
  });

  it('refreshes the token after an auth close (4401) and stops for good on revocation (4403)', async () => {
    const t = setup();
    t.client.start();
    await openAndReady(t.sockets[0]!);
    t.sockets[0]!.close(4401, 'token_expired');
    await vi.advanceTimersByTimeAsync(10);
    t.sockets[1]!.open();
    await vi.waitFor(() => expect(t.tokens.at(-1)).toBe(true));
    t.sockets[1]!.receive({ type: 'ready', userId: 'u', lastEventId: 0, replayed: 0 });
    t.sockets[1]!.close(4403, 'access_revoked');
    expect(t.client.state).toBe('denied');
    expect(t.denied).toEqual(['access_revoked']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.sockets).toHaveLength(2); // no reconnect attempts after revocation
    t.client.stop();
  });

  it('asks the app to reload state when the server says the client missed too much', async () => {
    const t = setup();
    t.client.start();
    t.sockets[0]!.open();
    await vi.waitFor(() => expect(t.sockets[0]!.sent.length).toBe(1));
    t.sockets[0]!.receive({ type: 'resync', reason: 'missed_events', lastEventId: 900 });
    expect(t.resyncs).toHaveLength(1);
    expect(t.client.cursor).toBe(900);
    t.client.stop();
  });

  it('backoff grows exponentially with jitter and is capped at 30s', () => {
    const t = setup();
    const delays = [1, 2, 3, 4, 5, 6, 10].map((a) => t.client.backoffDelay(a));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    const jittered = new RealtimeClient({ url: 'x', getToken: async () => '', onEvent: () => {}, onResync: () => {}, random: () => 0 });
    expect(jittered.backoffDelay(1)).toBe(700);
  });

  it(`falls back to HTTP polling after ${FALLBACK_AFTER_FAILURES} failed WebSocket attempts, and back to WebSockets when they work`, async () => {
    const polls: number[] = [];
    let next: PollResult = { events: [], lastEventId: 50, resync: false };
    const t = setup({
      poll: async (since) => {
        polls.push(since);
        return next;
      },
    });
    t.client.start();
    for (let i = 0; i < FALLBACK_AFTER_FAILURES; i++) {
      const s = t.sockets.at(-1)!;
      s.close(1006, 'blocked by proxy');
      await vi.advanceTimersByTimeAsync(40_000);
    }
    expect(t.client.isPolling).toBe(true);
    expect(t.client.state).toBe('polling');
    await vi.waitFor(() => expect(polls.length).toBeGreaterThan(0));
    expect(t.client.cursor).toBe(50);

    next = { events: [ev(51), ev(52)], lastEventId: 52, resync: false };
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.events).toEqual([51, 52]);
    next = { events: [ev(52), ev(53)], lastEventId: 53, resync: false };
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.events).toEqual([51, 52, 53]); // no duplicate 52

    // a later WebSocket probe succeeds → polling stops
    await vi.advanceTimersByTimeAsync(120_000);
    const s = t.sockets.at(-1)!;
    await openAndReady(s, 53);
    expect(t.client.isPolling).toBe(false);
    expect(t.client.state).toBe('live');
    const count = polls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(polls.length).toBe(count);
    t.client.stop();
  });
});
