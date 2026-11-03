import type { RealtimeEvent, RealtimeEventType, ServerMessage } from '@tasksync/shared';
import type { Queryable } from '../db/database.js';

export interface StoredEvent extends RealtimeEvent {
  userId: string;
}

export interface RealtimeClient {
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

/**
 * In-process fan-out of committed events to connected WebSocket clients.
 * Events are persisted (realtime_events) inside the same transaction as the change,
 * so a client that was offline can replay everything it missed.
 */
export class RealtimeHub {
  private readonly clients = new Map<string, Set<RealtimeClient>>();

  add(userId: string, client: RealtimeClient): void {
    let set = this.clients.get(userId);
    if (!set) this.clients.set(userId, (set = new Set()));
    set.add(client);
  }

  remove(userId: string, client: RealtimeClient): void {
    const set = this.clients.get(userId);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) this.clients.delete(userId);
  }

  publish(events: StoredEvent[]): void {
    for (const e of events) {
      const set = this.clients.get(e.userId);
      if (!set) continue;
      const { userId: _omit, ...event } = e;
      for (const client of set) {
        try {
          client.send({ type: 'event', event });
        } catch {
          // A broken socket is cleaned up by its close handler.
        }
      }
    }
  }

  disconnectUser(userId: string, code: number, reason: string): void {
    const set = this.clients.get(userId);
    if (!set) return;
    for (const client of [...set]) client.close(code, reason);
    this.clients.delete(userId);
  }

  connectionCount(): number {
    let n = 0;
    for (const set of this.clients.values()) n += set.size;
    return n;
  }

  connectedUserIds(): string[] {
    return [...this.clients.keys()];
  }

  isOnline(userId: string): boolean {
    return (this.clients.get(userId)?.size ?? 0) > 0;
  }
}

/** Collects events written inside a transaction; publish them only after commit. */
export class Outbox {
  readonly events: StoredEvent[] = [];
  constructor(private readonly q: Queryable) {}

  async emit(userIds: Iterable<string>, type: RealtimeEventType, taskId: string | null, data: unknown): Promise<void> {
    for (const userId of new Set(userIds)) {
      const { rows } = await this.q.query<{ id: string | number; created_at: Date | string }>(
        `INSERT INTO realtime_events (user_id, type, task_id, payload) VALUES ($1, $2, $3, $4)
         RETURNING id, created_at`,
        [userId, type, taskId, JSON.stringify(data)],
      );
      const row = rows[0]!;
      this.events.push({
        id: Number(row.id),
        userId,
        type,
        taskId,
        data,
        createdAt: new Date(row.created_at).toISOString(),
      });
    }
  }
}
