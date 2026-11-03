# TaskSync development status

_Last updated: 2026-11-03_

## Summary

The MVP is **built and tested locally end to end**: API, database schema, web dashboard, Windows desktop
companion and Teams workflow. It is **not live yet**. Going live needs three configuration steps only you or Omnifi
IT can do (Supabase project, Entra app registration, Render settings). All three are free and described in
[DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md).

## Completed

**Platform**
- Monorepo: `shared/` types, `server/` API (Fastify + TypeScript), `web/` (React + Vite), `desktop/` (.NET 8 + WebView2), `e2e/`
- PostgreSQL schema with migrations run on startup: users, employee profiles, admin approvals, tasks, assignments,
  comments, activity, notifications, preferences, realtime events, audit log; constraints and indexes; RLS on every
  table plus Supabase public-role lock-down
- Render-ready: `render.yaml`, `/api/health` (liveness, and `?strict=1` readiness), boots safely without config
  and reports what's missing, cold-start handling in the UI
- Configuration validated at startup; blank variables ignored; production refuses development shortcuts

**Security**
- Entra ID single-tenant token validation (signature, issuer, tenant, audience, scope, guest/personal/external, optional app role, domain)
- Admin approval workflow, roles (Admin/Employee), deactivation with instant session revocation, last-admin protection
- Server-side authorisation on every route, IDOR protection, input validation, rate limits, CSP and security headers, audit log

**Tasks**
- Create with @mention assignment, self-assignment, multiple assignees, descriptions, due dates, priorities
- Statuses Pending / In Progress / Completed / Cancelled / Declined / Reassigned with distinct rules
- Shared completion (one record, completed for everyone, who and when stored), reopen, cancel/restore
- Decline, remove assignee, add people, reassign, hand over own assignment; full assignment history
- Comments with @mentions (participants only), activity timeline and feed, notifications with read state and preferences
- Optimistic concurrency, race-safe transitions, idempotent creates

**Real-time**
- WebSocket push with in-band auth, persisted event log, replay after reconnect, resync, duplicate/stale guards,
  heartbeats, token refresh, backoff with jitter, HTTP polling fallback for proxies, offline outbox

**Web dashboard (Dark Liquid Glass)**
- My Tasks (stats, due-date groups), Assigned by Me (declined first), Completed (completed/cancelled), Activity,
  Team, Settings, Admin (requests, users, audit log); task drawer with actions, edit, comments, history
- Employee context menu: Message in Teams, View Profile, View Tasks from this Employee
- Responsive down to phone width; reduced-motion support

**Windows companion**
- Floating, draggable, resizable widget; compact/expanded; always-on-top; tray icon and menu; Windows toasts;
  start with Windows; remembers size/position/mode; opens the full dashboard; offline retry page with automatic
  recovery; reconnect after sleep; persistent sign-in; single instance
- **Hidden from screen sharing / screenshots** (default on, toggle in tray and Settings)
- **Stays visible on Show desktop (Win+D), Win+M and desktop peek** (default on, toggle in tray and Settings)

**Teams**
- PNG task card (or summary of shared open tasks) → clipboard → one-to-one Teams chat deep link with prefilled message

**Tests and docs**: see [TEST_REPORT.md](TEST_REPORT.md) (142 automated tests across 6 suites, all passing), README,
ARCHITECTURE, SECURITY, DEPLOYMENT_GUIDE, `.env.example`.

## In progress

- Nothing is half-built in the code. The remaining work is configuration and the manual checks below.

## Pending (not started, proposed next)

| Item | Notes |
|---|---|
| Live deployment verification | After Render env vars are set (Blocked) |
| Real Entra sign-in tests (approved / personal / other tenant) | After app registration (Blocked) |
| Manual desktop checks | Win+D, peek, tray menu, toast look, Teams paste, live screen share (TEST_REPORT "Not tested") |
| Native desktop app rollout | Only if IT agrees to trust/sign it; until then the Edge app is the desktop experience |
| Email one-time-code sign-in | Fallback if the tenant blocks app registration or user consent (not needed if §2 works) |
| Directory sync from Microsoft Graph | Job title/department from Entra (`User.Read.All`, admin consent). Today profiles are self-edited |
| Automatic Teams message sending | Needs Graph `ChatMessage.Send` + admin consent. Deliberately out of the MVP |
| Pagination beyond 200 tasks per list / 100 activity items | Lists are capped; "load older" exists for activity only |
| Per-assignee acknowledgement / progress | Columns exist (`acknowledged_at`, `progress`); no UI yet |
| Attachments on tasks | Would need object storage (Supabase Storage free tier: 1 GB); not started |
| Email notifications | Not in scope; Teams/desktop/in-app only |

## Known issues and limitations

- **Render free cold start:** the first request after ~15 minutes idle takes about a minute. The UI says so and retries.
- **Supabase free pause:** projects pause after 7 days without activity. Restore from the dashboard.
- **Native desktop executable** is blocked by Omnifi's Defender ASR rule (prevalence/age/trusted list). The
  default desktop experience is therefore the **Edge app + pop-out widget** (no installer). Screen-share hiding and
  Win+D behaviour exist only in the native app, which needs IT to trust or sign it.
- **Pop-out widget** closes when the main TaskSync window is closed (browser rule). Its behaviour on Win+D isn't verified.
- **No-admin sign-in** depends on the tenant allowing users to register apps and to consent to basic sign-in
  (Microsoft defaults). If Omnifi has turned those off, TaskSync needs the email-code fallback (not built yet).
- Development sign-in sessions reset whenever the local server restarts (dev-only key, by design).
- Screen-capture exclusion needs Windows 10 2004 or later. Older builds show a black box in captures instead.
- Single API instance assumed (in-memory rate limits and realtime fan-out). Fine on Render Free.

## Blockers

1. **Supabase project**: needs your Supabase sign-up (no card). DEPLOYMENT_GUIDE §1.
2. **Entra ID app registration**: you can create it yourself (no admin consent needed). DEPLOYMENT_GUIDE §2.
3. **Render service settings**: needs access to the Render dashboard. DEPLOYMENT_GUIDE §4.

## Required actions from you

1. Make the GitHub repository private (DEPLOYMENT_GUIDE §0).
2. Create the Supabase project and copy the session-pooler URL and CA certificate (§1).
3. Register the TaskSync app in Entra yourself (§2) and put the tenant ID and client ID into Render.
4. In Render, set the build/start commands, health check and environment variables (§4), then deploy.
5. Sign in at <https://tasksync-vgam.onrender.com> as the bootstrap admin and approve colleagues.
6. Install TaskSync as an Edge app and try **Pop out widget** (§6). Ask colleagues to do the same.
7. Do the ~1-minute manual desktop checks in TEST_REPORT.md.
