import type { AppConfig } from '../config.js';
import type { Database, Tx } from '../db/database.js';
import type { Auth } from '../http/auth.js';
import type { Outbox, RealtimeHub } from '../realtime/hub.js';
import type { DevAuth } from '../auth/dev.js';

export interface RouteContext {
  config: AppConfig;
  auth: Auth;
  hub: RealtimeHub;
  devAuth: DevAuth | null;
  /** The database, or a 503 error when it is not configured. */
  db: () => Database;
  /** Runs `fn` in a transaction, then publishes the events it queued. */
  mutate: <T>(fn: (q: Tx, outbox: Outbox) => Promise<T>) => Promise<T>;
}
