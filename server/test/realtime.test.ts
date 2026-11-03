import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage, Task } from '@tasksync/shared';
import { createTestEnv, DOMAIN, type TestEnv } from './helpers.js';
import { pruneEvents } from '../src/realtime/replay.js';

type U = Awaited<ReturnType<TestEnv['user']>>;
let env: TestEnv;
let base: string;
let rahul: U, stella: U, outsider: U;

interface Conn {
  ws: WebSocket;
  messages: ServerMessage[];
  closed: Promise<{ code: number; reason: string }>;
  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  eventsFor(taskId: string): ServerMessage[];
}

function connect(token: string | null, since = 0, origin?: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/realtime`, origin ? { origin } : {});
    const messages: ServerMessage[] = [];
    const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
    const closed = new Promise<{ code: number; reason: string }>((res) =>
      ws.on('close', (code, reason) => res({ code, reason: reason.toString() })),
    );
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      messages.push(msg);
      for (const w of [...waiters]) {
        if (w.pred(msg)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
    ws.on('error', reject);
    ws.on('open', () => {
      if (token) ws.send(JSON.stringify({ type: 'auth', token, since }));
      resolve({
        ws,
        messages,
        closed,
        waitFor(pred, timeoutMs = 5000) {
          const existing = messages.find(pred);
          if (existing) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('timed out waiting for message')), timeoutMs);
            waiters.push({
              pred,
              resolve: (m) => {
                clearTimeout(timer);
                res(m);
              },
            });
          });
        },
        eventsFor(taskId) {
          return messages.filter((m) => m.type === 'event' && m.event.taskId === taskId);
        },
      });
    });
  });
}

const isReady = (m: ServerMessage) => m.type === 'ready';
const taskEvent = (taskId: string, status?: string) => (m: ServerMessage) =>
  m.type === 'event' &&
  m.event.type === 'task.upsert' &&
  m.event.taskId === taskId &&
  (!status || (m.event.data as Task).status === status);

beforeAll(async () => {
  env = await createTestEnv();
  base = await env.app.listen({ port: 0, host: '127.0.0.1' });
  rahul = await env.user('Rahul Live');
  stella = await env.user('Stella Live');
  outsider = await env.user('Olive Outsider');
});
afterAll(async () => env.close());

describe('Realtime synchronisation', () => {
  it('[T15] changes reach every session of every participant immediately, and nobody else', async () => {
    const rahulWeb = await connect(rahul.token);
    const stellaWidget = await connect(stella.token);
    const stellaWeb = await connect(stella.token);
    const other = await connect(outsider.token);
    await Promise.all([rahulWeb, stellaWidget, stellaWeb, other].map((c) => c.waitFor(isReady)));

    const created = await env.req('POST', '/api/tasks', rahul.token, { title: 'Live sync', assigneeIds: [stella.id] });
    const id = created.body.task.id as string;
    for (const c of [rahulWeb, stellaWidget, stellaWeb]) await c.waitFor(taskEvent(id, 'pending'));
    await stellaWidget.waitFor((m) => m.type === 'event' && m.event.type === 'notification' && m.event.taskId === id);

    await env.req('POST', `/api/tasks/${id}/status`, stella.token, { status: 'completed' });
    const seen = (await rahulWeb.waitFor(taskEvent(id, 'completed'))) as Extract<ServerMessage, { type: 'event' }>;
    expect((seen.event.data as Task).completedBy?.id).toBe(stella.id);
    await stellaWeb.waitFor(taskEvent(id, 'completed'));
    await rahulWeb.waitFor((m) => m.type === 'event' && m.event.type === 'notification' && m.event.taskId === id);

    await env.req('POST', `/api/tasks/${id}/comments`, stella.token, { body: 'Done and filed' });
    await rahulWeb.waitFor((m) => m.type === 'event' && m.event.type === 'task.comment' && m.event.taskId === id);

    await new Promise((r) => setTimeout(r, 200));
    expect(other.eventsFor(id)).toHaveLength(0);
    // event ids are strictly increasing on each connection (clients use them as a cursor)
    const evIds = stellaWeb.messages.flatMap((m) => (m.type === 'event' ? [m.event.id] : []));
    expect([...evIds].sort((a, b) => a - b)).toEqual(evIds);
    for (const c of [rahulWeb, stellaWidget, stellaWeb, other]) c.ws.close();
  });

  it('[T17] a client that was offline replays exactly the events it missed after reconnecting', async () => {
    const first = await connect(stella.token);
    const ready = (await first.waitFor(isReady)) as Extract<ServerMessage, { type: 'ready' }>;
    first.ws.close();
    await first.closed;

    // while Stella is offline
    const a = (await env.req('POST', '/api/tasks', rahul.token, { title: 'Missed one', assigneeIds: [stella.id] })).body.task;
    const b = (await env.req('POST', '/api/tasks', rahul.token, { title: 'Missed two', assigneeIds: [stella.id] })).body.task;
    await env.req('POST', `/api/tasks/${a.id}/status`, rahul.token, { status: 'cancelled' });

    const again = await connect(stella.token, ready.lastEventId);
    const ready2 = (await again.waitFor(isReady)) as Extract<ServerMessage, { type: 'ready' }>;
    expect(ready2.replayed).toBeGreaterThanOrEqual(5); // 3 task upserts + 2 notifications (+ cancel notice)
    expect(again.eventsFor(a.id).some((m) => m.type === 'event' && (m.event.data as Task).status === 'cancelled')).toBe(true);
    expect(again.eventsFor(b.id).length).toBeGreaterThan(0);
    // nothing at or before the cursor is replayed (no duplicates)
    for (const m of again.messages) if (m.type === 'event') expect(m.event.id).toBeGreaterThan(ready.lastEventId);
    expect(ready2.lastEventId).toBeGreaterThan(ready.lastEventId);

    // HTTP fallback returns the same missed events
    const http = await env.req('GET', `/api/events?since=${ready.lastEventId}`, stella.token);
    expect(http.body.events.map((e: { id: number }) => e.id)).toEqual(
      again.messages.flatMap((m) => (m.type === 'event' ? [m.event.id] : [])),
    );

    // reconnecting with the latest cursor replays nothing
    again.ws.close();
    const third = await connect(stella.token, ready2.lastEventId);
    const ready3 = (await third.waitFor(isReady)) as Extract<ServerMessage, { type: 'ready' }>;
    expect(ready3.replayed).toBe(0);
    third.ws.close();
  });

  it('[T17] asks the client to resync when its cursor is older than retained history', async () => {
    const c = await connect(stella.token);
    const ready = (await c.waitFor(isReady)) as Extract<ServerMessage, { type: 'ready' }>;
    c.ws.close();
    await env.req('POST', '/api/tasks', rahul.token, { title: 'Before prune', assigneeIds: [stella.id] });
    await env.db.query(`UPDATE realtime_events SET created_at = now() - interval '10 days'`);
    await pruneEvents(env.db, 72);
    const again = await connect(stella.token, ready.lastEventId);
    await again.waitFor((m) => m.type === 'resync');
    await again.waitFor(isReady);
    again.ws.close();
  });

  it('rejects unauthenticated, invalid, pending and cross-origin connections', async () => {
    const bad = await connect('not-a-token');
    expect((await bad.closed).code).toBe(4401);

    const pending = await env.user('Pending Live', { approve: false });
    const p = await connect(pending.token);
    const pc = await p.closed;
    expect(pc.code).toBe(4403);
    expect(p.messages.some((m) => m.type === 'error' && m.code === 'account_pending')).toBe(true);

    const evil = await connect(rahul.token, 0, 'https://evil.example.net');
    expect((await evil.closed).code).toBe(4403);

    const external = await connect(await env.mint(`x@other-${DOMAIN}`));
    expect((await external.closed).code).toBe(4403);
  });

  it('tells connected colleagues to refresh the directory when someone is approved', async () => {
    const watcher = await connect(rahul.token);
    await watcher.waitFor(isReady);
    const newbie = await env.user('Nadia Newbie', { approve: false });
    const admin = await env.admin();
    await env.req('POST', `/api/admin/users/${newbie.id}/approve`, admin.token, {});
    await watcher.waitFor(
      (m) => m.type === 'event' && m.event.type === 'user.updated' && (m.event.data as { userId: string }).userId === newbie.id,
    );
    watcher.ws.close();
  });

  it('closes live sessions as soon as an admin deactivates the employee', async () => {
    const leaver = await env.user('Leo Leaver');
    const c = await connect(leaver.token);
    await c.waitFor(isReady);
    const admin = await env.admin();
    await env.req('POST', `/api/admin/users/${leaver.id}/deactivate`, admin.token, {});
    const closed = await c.closed;
    expect(closed.code).toBe(4403);
    // and cannot reconnect
    const retry = await connect(leaver.token);
    expect((await retry.closed).code).toBe(4403);
  });

  it('closes the socket when the access token expires, and accepts in-band token refresh', async () => {
    const short = await env.mint(stella.email, { name: stella.name }, { exp: '2s' });
    const c = await connect(short);
    await c.waitFor(isReady);
    const closed = await c.closed;
    expect(closed.code).toBe(4401);
    expect(closed.reason).toBe('token_expired');

    const short2 = await env.mint(stella.email, { name: stella.name }, { exp: '2s' });
    const d = await connect(short2);
    await d.waitFor(isReady);
    d.ws.send(JSON.stringify({ type: 'auth', token: await env.mint(stella.email, { name: stella.name }, { exp: '1h' }) }));
    const outcome = await Promise.race([d.closed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('open'), 3500))]);
    expect(outcome).toBe('open');
    d.ws.send(JSON.stringify({ type: 'ping', t: 1 }));
    await d.waitFor((m) => m.type === 'pong');
    d.ws.close();
  });
});
