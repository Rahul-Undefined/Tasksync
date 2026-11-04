# TaskSync architecture

## Overview

```
 Employee PC (Windows)                         Render Free web service              Supabase Free
┌──────────────────────────────┐             ┌──────────────────────────────┐     ┌────────────────┐
│ TaskSync.exe (WinForms)      │             │ Node.js 22 · Fastify (TS)     │     │ PostgreSQL     │
│  ├ tray icon, toasts,        │  HTTPS +    │  ├ /api/* REST (zod-validated)│ TLS │  tasks,        │
│  │ clipboard, Teams launch   │  WebSocket  │  ├ /api/realtime WebSocket    │────▶│  assignments,  │
│  └ WebView2 → /widget ───────┼────────────▶│  ├ Entra token verification   │     │  activity,     │
│ Browser → / (dashboard)      │             │  ├ serves web/dist (SPA)      │     │  events, …     │
└──────────────────────────────┘             │  └ migrations on startup      │     │ RLS on, no     │
              │                              └──────────────────────────────┘     │ public grants  │
              │ MSAL (PKCE, SPA)                                                   └────────────────┘
              ▼
   Microsoft Entra ID (Omnifi tenant, single-tenant app "TaskSync", openid/profile/email; no admin consent)
```

One Render service hosts both the API and the built React app, so the dashboard and API share an origin (no CORS
surface, one URL: `https://tasksync-vgam.onrender.com`). The desktop app is a thin native shell around the same web
UI (`/widget` route), so features ship to both at once.

## Data storage without a database service

Render Free has no persistent disk and its free PostgreSQL expires after 30 days, and the project only uses
GitHub and Render. So, unless `DATABASE_URL` is set, TaskSync runs **Node's built-in SQLite in memory**
(`server/src/db/sqlite.ts`, ~110 MB peak for the whole server; an embedded PostgreSQL (PGlite) was tried first but
briefly needs ~1 GB at start-up and was killed by Render's 512 MB limit) and makes it durable with
**encrypted snapshots in a private GitHub repository** (`server/src/storage/`). The SQLite schema is derived from the
PostgreSQL migrations, and the adapter translates the few PostgreSQL-only forms the queries use (`$1`, casts,
`= ANY(array)`, `FOR UPDATE`); the full API test suite runs on SQLite, PGlite and PostgreSQL.

- `snapshot.ts`: logical JSON export/import of all tables (parents before children, identity sequences and the
  realtime event cursor carried over, new columns get defaults, all in one transaction).
- `crypto.ts`: gzip, then AES-256-GCM with a scrypt-derived key from `DATA_ENCRYPTION_KEY` (random salt and IV per file).
- `github.ts`: Git Data API. Each save is one parentless commit (latest + 7 daily backups) force-moved onto the
  branch, so history doesn't grow. An empty repository is initialised automatically.
- `persistence.ts`: loads before serving (503 `storage_loading` until then, and never saves before a successful
  load); saves 3 s after the last change (max 15 s), retries failures, saves on SIGTERM; during the first minutes
  it reloads if the previous instance saved newer data while shutting down (Render deploy overlap).

Trade-offs: changes in the last seconds before a hard crash can be lost; one instance only; every start restores
the snapshot (fast at team scale). With `DATABASE_URL`, the same code runs on a regular PostgreSQL server instead.

## Key decisions and trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| **Backend WebSockets + persisted event log** instead of Supabase Realtime | Sign-in is Entra ID, not Supabase Auth. Supabase Realtime's RLS would need us to mint Supabase JWTs with the project's JWT secret and give clients Supabase keys. With our own channel, identity is checked once, the server decides who receives what, and clients replay missed events by id. | Fan-out runs in the API process (fine for one free instance). To scale out, add Postgres `LISTEN/NOTIFY` between instances. |
| **API serves the SPA** (single Render web service) | Same-origin, simpler auth/CSP, uses the existing service URL | The UI is unavailable while the free instance cold-starts (≈1 min); the UI explains this and retries |
| **Node.js/TypeScript** backend | Shares types with the React UI (`shared/`) | — |
| **WinForms + WebView2** desktop | WebView2 ships with Windows 11 (≈1 MB app vs ≈100 MB Electron), native tray, DWM and clipboard APIs | Windows only (as required) |
| **PGlite** for local dev/tests, **real PostgreSQL 18** for concurrency tests | Same SQL and migrations everywhere, no database install needed to develop | PGlite is single-connection, so the concurrency suite also runs on real Postgres (`npm run test:pg`) |
| Status model: shared task status + per-assignee assignment rows | Completing a task completes it for everyone (requirement), while assignment rows keep history (declined/removed/reassigned) and already have `acknowledged_at` / `progress` columns for future per-assignee tracking | — |

## Data model (PostgreSQL)

| Table | Purpose |
|---|---|
| `users` | One row per Entra user (`entra_oid` unique, tenant, email, role `admin/employee`, status `pending/approved/rejected/deactivated`) |
| `employee_profiles` | Job title, department, location, phone, about |
| `admin_approvals` | Every access decision: requested, approved, rejected, deactivated, reactivated, role changes, with who and why |
| `tasks` | **The single authoritative task record**: title, description, priority, status, due date, creator, `completed_at/by`, `cancelled_at/by`, `version` (optimistic concurrency), `client_request_id` (idempotent creates) |
| `task_assignments` | One row per assignment period: `active`, `declined`, `removed`, `reassigned`; who assigned, when it ended, note; future `acknowledged_at`, `progress` |
| `task_comments` | Comments with inline `@[Name](user-id)` mention tokens |
| `task_activity` | Append-only history (created, assigned, self_assigned, declined, reassigned, status_changed, completed, cancelled, reopened, updated, commented) |
| `notifications` | Per-user notifications with read state |
| `user_preferences` | Notification categories, desktop toasts, widget mode |
| `realtime_events` | Per-recipient event log (bigint id = cursor) for push and replay; pruned after 72 h |
| `audit_log` | Security-relevant actions: registrations, admin actions, denied sign-ins |
| `system_state` | Small key/value store (event prune horizon) |

Constraints enforce the invariants in the database itself, e.g. *status = completed ⇔ completed_at and completed_by
set*, *one active assignment per person per task* (partial unique index), length limits, enum checks.
Migration `002` and a re-run on every start enable **row level security on all tables** and revoke all grants from
Supabase's `anon`/`authenticated` roles, so Supabase's auto-generated public APIs can't touch TaskSync data. The API
connects as the table owner.

## Task lifecycle

```
             start            complete
 pending ──────────▶ in_progress ──────────▶ completed ──reopen──▶ pending
    │  ▲   pause ◀──────┘                        (for everyone)
    │  │
    │  └── reassign ── reassigned ──start/complete──▶ …
    │
    ├── all assignees decline ──▶ declined ──reassign / add people──▶ reassigned/pending
    └── creator cancels ──▶ cancelled ──restore (creator)──▶ pending
```

- **Completed**: work finished (any active assignee, the creator or an admin). Idempotent.
- **Declined**: the assignee won't take it. With several assignees, only that person's assignment is declined.
- **Cancelled**: the creator (or an admin) calls it off.
- **Reassigned**: ownership moved to someone else (creator/admin, or an assignee handing over their own part).

Every transition is a single conditional `UPDATE … WHERE status = ANY(allowed)` inside a transaction that first locks
the row (`SELECT … FOR UPDATE`). Two people racing (complete vs cancel) get exactly one winner. The loser gets
`409` with the current task. Detail edits use `version` (optimistic concurrency → `409 version_conflict`).

## Permissions (enforced in the API, never trusted from the client)

| Action | Who |
|---|---|
| See a task | creator, anyone who has ever been assigned to it, admins |
| Edit title/description/priority/due date | creator, admins |
| Start / complete / pause | active assignees, creator, admins |
| Decline | the active assignee themself |
| Add/remove assignees, reassign anyone, cancel/restore | creator, admins |
| Hand over own assignment | active assignee |
| Comment / @mention | participants and admins (mentions only notify people already on the task) |
| "Tasks from this employee" | tasks shared between the two people (admins: all of that employee's tasks) |
| Approve/reject/deactivate users, change roles | admins (the last admin cannot be removed or demoted) |

Unknown and forbidden task ids both return `404` so ids can't be probed.

## Authentication flow

1. The web app loads `/api/config` (tenant id, client id, scope; none of these are secret).
2. MSAL (`@azure/msal-browser`, auth code + PKCE, redirect flow) signs the user in against
   `https://login.microsoftonline.com/<tenant-id>`. **Default (`ENTRA_TOKEN_MODE=id`):** it asks only for
   `openid profile email` and sends the **ID token** (audience = the TaskSync client ID), which employees can consent
   to themselves, so no Entra admin is involved. The client refreshes it a few minutes before expiry. The server only
   accepts it if it is a v2 ID token for *this* app (exact audience, v2 issuer, no `azp`/`appid`, not app-only).
   **Optional (`ENTRA_TOKEN_MODE=access`):** with an admin-exposed API it uses access tokens for
   `api://<client-id>/access_as_user` instead. The trade-off: Microsoft recommends access tokens for separate APIs;
   here the API and the SPA are one app registration and one origin, so the ID token's audience already pins it to
   TaskSync.
   The token cache is in `localStorage` (inside the WebView2 profile for the desktop app), so people stay signed in
   until they sign out or the session expires.
3. Every API call sends `Authorization: Bearer <token>`. The server verifies the RS256 signature against the
   tenant's JWKS, the issuer, audience, expiry, `tid`, guest/external flags (`acct`, `idp`, `#EXT#`), the token
   kind (ID token for this app, or access token with the TaskSync scope), an optional app role, and the email domain. It then loads the user by `oid` and requires `status = approved`.
4. Unknown employees are registered as `pending`, and admins get a live notification to approve them.

## Real-time protocol

`wss://…/api/realtime`:

```
client → {type:"auth", token, since}            first message (token never in the URL)
server → {type:"event", event} …                replay of events with id > since (max 500)
server → {type:"resync"}                        if the client is too far behind → full reload
server → {type:"ready", lastEventId}
server → {type:"event", event}                  live, for every committed change the user may see
client ↔ ping/pong every 25 s                    dead connections detected within ~65 s
client → {type:"auth", token}                    in-band token refresh
close 4401 token expired → reconnect with fresh token · 4403 access revoked → stop
```

Events are written to `realtime_events` **in the same transaction** as the change and pushed only after commit.
Clients:
- keep the highest applied id and drop duplicates;
- prefer the higher task `version` (stale-data guard);
- reconnect with exponential backoff and jitter, immediately on `online`, on tab focus, and when the PC wakes;
- after 3 failed WebSocket attempts on a working network, **poll `GET /api/events?since=` every 15 s**, and switch
  back when a WebSocket succeeds (corporate proxies);
- queue creates and status changes made while offline (idempotency keys make retries safe) and send them on reconnect.

## Desktop companion (desktop/TaskSync.Desktop)

| File | Role |
|---|---|
| `Program.cs` | Single instance (named mutex + event to surface the running widget), `--url`, `--minimized` |
| `HostController.cs` | Tray icon and menu, Windows toasts (balloon tips → Action Center), bridge dispatcher, sleep/resume |
| `WebWindow.cs` | WebView2 hosting: shared profile, navigation allowlist, offline/retry page, bridge origin check |
| `WidgetForm.cs` | Captionless resizable widget, compact/expanded sizes, remembers bounds per mode, drag, always-on-top, **screen-capture exclusion** (`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`), **stay on desktop** (tool window, minimise guard, `DWMWA_EXCLUDED_FROM_PEEK`, foreground hook for Win+D) |
| `UrlPolicy.cs` | What may load inside the app (TaskSync origin + Microsoft sign-in hosts) and which links may launch (Teams deep links only) |
| `Bridge.cs` | Allowlisted message types from the page, typed accessors, host-state messages |
| `HostServices.cs` | Clipboard (PNG-signature checked), Teams launch with web fallback, test log |
| `AutoStart.cs` | Per-user Run key (no admin) |
| `AppSettings.cs` | `%LOCALAPPDATA%\TaskSync\settings.json`, off-screen recovery |

## Desktop without an installer (Edge app + pop-out widget)

Omnifi PCs block unsigned executables (Defender ASR "prevalence, age, or trusted list" rule), so the default desktop
experience needs no `.exe`:
- **Installable web app:** `web/public/manifest.webmanifest` + icons. Edge installs TaskSync as an app (own window,
  Start menu, taskbar badge via `navigator.setAppBadge`, Windows notifications through Edge, start on login via
  `edge://apps`).
- **Pop-out widget:** `web/src/lib/pip.tsx` opens an always-on-top window with the Document Picture-in-Picture API
  (Edge 116+) and renders the same `WidgetPage` into it with a second React root. Both roots share one store,
  realtime connection and sign-in. Task details open in the main window.
- Screen-capture exclusion and Win+D handling need native Win32 calls, so they exist only in the native app.

## Teams integration

Teams deep links (`https://teams.microsoft.com/l/chat/0/0?users=<upn>&message=<text>`, or `msteams:` in the
desktop app) open the right one-to-one chat with prefilled text. **They cannot attach images or send messages.** So
TaskSync renders a PNG task card (Canvas 2D, no external services), puts it on the clipboard, opens the chat, and
tells the user to paste (Ctrl+V) and send. Sending automatically would need Microsoft Graph
`ChatMessage.Send`/`Chat.ReadWrite` delegated permissions and admin consent. That's possible within Microsoft 365
licences but left out of the MVP on purpose (see DEVELOPMENT_STATUS.md).
