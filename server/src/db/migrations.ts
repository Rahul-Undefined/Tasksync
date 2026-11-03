// Ordered, append-only schema migrations. Never edit a migration that has shipped;
// add a new one instead. Each migration runs inside its own transaction.

export interface Migration {
  id: string;
  sql: string;
}

const TABLES = [
  'users',
  'employee_profiles',
  'admin_approvals',
  'tasks',
  'task_assignments',
  'task_comments',
  'task_activity',
  'notifications',
  'user_preferences',
  'realtime_events',
  'audit_log',
  'system_state',
];

export const migrations: Migration[] = [
  {
    id: '001_core_schema',
    sql: /* sql */ `
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entra_oid     uuid NOT NULL UNIQUE,
  tenant_id     uuid NOT NULL,
  email         text NOT NULL UNIQUE CHECK (email = lower(email) AND position('@' IN email) > 1),
  display_name  text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  role          text NOT NULL DEFAULT 'employee' CHECK (role IN ('admin', 'employee')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'deactivated')),
  approved_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at   timestamptz,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_status_idx ON users (status);
CREATE INDEX users_name_idx ON users (lower(display_name));

CREATE TABLE employee_profiles (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  job_title       text CHECK (char_length(job_title) <= 120),
  department      text CHECK (char_length(department) <= 120),
  office_location text CHECK (char_length(office_location) <= 120),
  phone           text CHECK (char_length(phone) <= 40),
  about           text CHECK (char_length(about) <= 500),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decided_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL CHECK (action IN ('requested', 'approved', 'rejected', 'deactivated', 'reactivated', 'role_changed', 'bootstrap_admin')),
  from_status text,
  to_status   text,
  from_role   text,
  to_role     text,
  reason      text CHECK (char_length(reason) <= 500),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_approvals_user_idx ON admin_approvals (user_id, created_at DESC);

CREATE TABLE tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title             text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  description       text NOT NULL DEFAULT '' CHECK (char_length(description) <= 5000),
  priority          text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled', 'declined', 'reassigned')),
  due_at            timestamptz,
  created_by        uuid NOT NULL REFERENCES users(id),
  completed_at      timestamptz,
  completed_by      uuid REFERENCES users(id),
  cancelled_at      timestamptz,
  cancelled_by      uuid REFERENCES users(id),
  client_request_id uuid,
  version           integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tasks_completed_consistency
    CHECK ((status = 'completed') = (completed_at IS NOT NULL AND completed_by IS NOT NULL)),
  CONSTRAINT tasks_cancelled_consistency
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL))
);
CREATE UNIQUE INDEX tasks_client_request_uidx ON tasks (created_by, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX tasks_created_by_idx ON tasks (created_by, status);
CREATE INDEX tasks_status_due_idx ON tasks (status, due_at);

-- One row per (task, assignee) assignment period. Shared task status lives on tasks;
-- acknowledged_at / progress allow per-assignee tracking later without a redesign.
CREATE TABLE task_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  assignee_id     uuid NOT NULL REFERENCES users(id),
  assigned_by     uuid NOT NULL REFERENCES users(id),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'declined', 'removed', 'reassigned')),
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  ended_by        uuid REFERENCES users(id),
  note            text CHECK (char_length(note) <= 500),
  acknowledged_at timestamptz,
  progress        smallint CHECK (progress BETWEEN 0 AND 100),
  CONSTRAINT task_assignments_ended_consistency CHECK ((status = 'active') = (ended_at IS NULL))
);
CREATE UNIQUE INDEX task_assignments_active_uidx ON task_assignments (task_id, assignee_id) WHERE status = 'active';
CREATE INDEX task_assignments_assignee_idx ON task_assignments (assignee_id, status);
CREATE INDEX task_assignments_task_idx ON task_assignments (task_id);

CREATE TABLE task_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id),
  body       text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at  timestamptz,
  deleted_at timestamptz
);
CREATE INDEX task_comments_task_idx ON task_comments (task_id, created_at);

CREATE TABLE task_activity (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  type       text NOT NULL CHECK (type IN ('created', 'self_assigned', 'assigned', 'unassigned', 'declined', 'reassigned',
                                           'status_changed', 'completed', 'cancelled', 'reopened', 'updated', 'commented')),
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_activity_task_idx ON task_activity (task_id, id);
CREATE INDEX task_activity_created_idx ON task_activity (created_at DESC);

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id    uuid REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  type       text NOT NULL CHECK (type IN ('assigned', 'mentioned', 'status_changed', 'completed', 'cancelled', 'declined',
                                           'reassigned', 'unassigned', 'commented', 'account')),
  title      text NOT NULL CHECK (char_length(title) <= 300),
  body       text NOT NULL DEFAULT '' CHECK (char_length(body) <= 1000),
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE user_preferences (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notify_assigned boolean NOT NULL DEFAULT true,
  notify_status   boolean NOT NULL DEFAULT true,
  notify_comments boolean NOT NULL DEFAULT true,
  desktop_toasts  boolean NOT NULL DEFAULT true,
  widget_compact  boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Per-recipient event log that backs realtime delivery and replay after reconnects.
CREATE TABLE realtime_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  task_id    uuid,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX realtime_events_user_idx ON realtime_events (user_id, id);
CREATE INDEX realtime_events_created_idx ON realtime_events (created_at);

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  ip          text,
  user_agent  text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, created_at DESC);

CREATE TABLE system_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    id: '002_lock_down_data_api',
    // The API connects as the table owner, which bypasses RLS. Enabling RLS with no
    // policies (and revoking grants) means Supabase's auto-generated REST/GraphQL APIs,
    // which use the public anon/authenticated roles, can never read or write these tables.
    sql: /* sql */ `
DO $$
DECLARE
  t text;
  r text;
BEGIN
  FOREACH t IN ARRAY ARRAY[${TABLES.map((t) => `'${t}'`).join(', ')}] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY[${TABLES.map((t) => `'${t}'`).join(', ')}] LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END LOOP;
    END IF;
  END LOOP;
END
$$;
`,
  },
];
