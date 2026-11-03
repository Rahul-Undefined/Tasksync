# TaskSync test report

**Run date:** 2026-11-03 · **Machine:** Windows 11 Pro (office PC, 125% display scaling) · Node 24.19 · .NET SDK 8.0.427 ·
Microsoft Edge + WebView2 runtime (installed) · PostgreSQL 18 (embedded-postgres) and PGlite 0.5

Everything below was **actually run** on that date. Nothing has been run against the live Render URL with real
Microsoft accounts yet, because the Entra app registration and Supabase project don't exist yet (see Blocked).

## Suites

| Suite | Command | Result |
|---|---|---|
| API integration: auth (incl. no-admin ID-token sign-in), onboarding, task workflow, permissions, realtime, hardening (in-memory PostgreSQL / PGlite) | `npm test -w server` | **64 passed / 0 failed** |
| Same 64 tests against a **real PostgreSQL 18 server** (concurrent connections, row locks) | `npm run test:pg` | **64 passed / 0 failed** |
| Web unit: realtime client (dedupe, backoff, 4401/4403, resync, HTTP fallback), ID-token refresh timing, list rules, mentions, Teams links | `npm test -w web` | **20 passed / 0 failed** |
| Desktop unit: settings, off-screen recovery, auto-start (throwaway registry key), URL allowlists, bridge validation, real clipboard | `npm run test:desktop` | **42 passed / 0 failed** |
| Web E2E in **Microsoft Edge**, two separate user profiles (incl. installable-app manifest and pop-out widget) | `npm run test:e2e` | **7 passed / 0 failed** |
| Desktop E2E: real WinForms + WebView2 app, driven over CDP, Windows effects checked | `npm run test:e2e:desktop` | **9 passed / 0 failed** |
| Dependency audit | `npm audit` | **0 vulnerabilities** |

Sign-in in the automated tests uses tokens shaped exactly like Entra ID v2 access tokens, signed by a test key, that go
through the **same verification code** as production (signature, issuer, tenant, audience, scope, claims). Real
Microsoft sign-in can only be tested once the app registration exists.

Two manual browser sessions (Dev Admin and Alex Morgan in separate tabs of the in-app browser) confirmed the main flow
visually: access request → live admin notification → approval → @mention assignment → live arrival with toast →
completion → task leaves both active lists live and appears in both Completed tabs with "completed by" and history.
That session also found two UI bugs, both fixed (stale mention directory; context menu hidden behind the task drawer).

## Required test matrix

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Login with an approved company account | **Passed** (simulated Entra tokens, both ID-token and access-token modes) · real Entra: **Blocked** | `auth.test` T1 + no-admin ID-token suite; Edge E2E sign-in |
| 2 | Reject personal Microsoft account | **Passed** (simulated) · real: **Blocked** | `auth.test` T2: consumer tenant id and MSA guest (`idp=live.com`) |
| 3 | Reject external tenant | **Passed** (simulated) · real: **Blocked** | `auth.test` T3: other tid, forged issuer/tid mix, guests (`acct=1`, `#EXT#`); ID tokens for other apps, v1 issuer and app-only tokens rejected |
| 4 | Reject unapproved employee | **Passed** | `auth.test` T4 (all data routes 403); Edge E2E "waits for approval"; WebSocket refuses pending users |
| 5 | Employee approval workflow | **Passed** | `auth.test` T5 (approve/reject/deactivate/reactivate, history, audit, last-admin guard); Edge E2E live approval |
| 6 | Self-assignment | **Passed** | `tasks.test` T6: creator = assignee, My Tasks, `self_assigned` history |
| 7 | Assignment to another employee | **Passed** | `tasks.test` T7 (one DB row, notification); Edge E2E via `@mention` |
| 8 | Multiple assignees | **Passed** | `tasks.test` T8: shared status, completion closes it for all |
| 9 | Task completion synchronisation | **Passed** | `tasks.test` T9 (who/when stored, idempotent, reopen); Edge E2E two browsers live |
| 10 | Reassignment | **Passed** | `tasks.test` T10: history kept, hand-over rules, notifications, `reassigned` → `in_progress` |
| 11 | Cancellation | **Passed** | `tasks.test` T11: creator-only, closes for all, can't complete afterwards, restore |
| 12 | Decline / remove | **Passed** | `tasks.test` T12: sole vs partial decline, remove, last-assignee guard, re-add |
| 13 | Activity history | **Passed** | `tasks.test` T13: ordered timeline with actors; activity feed |
| 14 | Notifications | **Passed** | `tasks.test` T14 (types, read state, preferences, mentions don't leak); desktop E2E Windows toast via host log |
| 15 | Real-time updates across sessions | **Passed** | `realtime.test` T15 (4 sockets, 3 users); Edge E2E; desktop E2E; WebSocket-blocked proxy → HTTP fallback E2E |
| 16 | Concurrent updates | **Passed** | `tasks.test` T16 on **real PostgreSQL**: version conflict 409, complete-vs-cancel race, 5 simultaneous completions → 1 record |
| 17 | Offline and reconnect | **Passed** | `realtime.test` T17 (exact replay, no duplicates, resync after prune, HTTP replay); Edge E2E offline outbox (created exactly once); desktop offline page + automatic recovery |
| 18 | Permission boundaries | **Passed** | `tasks.test` T18 (404 for non-participants on 7 routes, creator-only edits, shared-only employee view, directory hides pending); `auth.test` admin-only routes, spoofed role claims; Edge E2E live revocation |
| 19 | Desktop widget behaviour | **Passed** (automated parts) · **Not tested**: see below | No-install path: Edge E2E opens the pop-out widget in real Edge and sees a colleague's new task arrive in it live; manifest/icons served. Native app: desktop E2E ×9 + unit ×42: load/sign-in, always-on-top (real `TopMost`), compact/expanded resize, live tasks, toast, minimise to tray, restart keeps size/mode/pin/sign-in, offline retry page, **hidden from screen capture** (affinity `0x11` + capture comparison), **minimise guard** (external `SW_MINIMIZE` / `SC_MINIMIZE`), auto-start registry |
| 20 | Teams link and clipboard workflow | **Passed** (automated parts) · **Not tested**: paste into real Teams | Edge E2E: PNG on clipboard (signature checked, >20 KB) + correct `teams.microsoft.com/l/chat/0/0?users=…&message=…`; desktop E2E: Windows clipboard has image (PNG + bitmap) + `msteams:/l/chat/…` launch request; unit: link encoding, injection rejected |

### Not tested (and why)

| Item | Why | How to check (≈1 min) |
|---|---|---|
| Real **Win+D** keypress and **Aero Peek** hover | Would minimise every window on the office PC while it was in use. The underlying minimise paths are tested. | Start the widget, press Win+D (widget should stay), press Win+D again; hover the far-right end of the taskbar (widget should stay solid). |
| Tray icon right-click menu clicks | Needs manual mouse interaction with the notification area | Right-click the tray icon and try each item |
| Toast *visual* appearance in Action Center | The test checks the host raised it, not how Windows draws it | Have someone assign you a task while the widget is hidden |
| Start with Windows on an actual sign-in | Tests use a throwaway registry key; the real Run key was never touched | Enable it in Settings, sign out/in to Windows |
| Pasting the copied image into Teams and sending | Would message a real person | Use *Message in Teams* on yourself or a colleague, then Ctrl+V |
| Screen share in Teams/Zoom (visual) | Capture exclusion was verified with Windows' capture API, not in a live meeting | Share your screen in a test meeting; the widget shouldn't appear |
| Running unsigned `TaskSync.exe` directly | Microsoft Defender ASR rule *Block executable files unless they meet a prevalence, age, or trusted list criterion* (block mode, company-managed) refuses it: Defender event 1121 for `TaskSync.exe`. The desktop E2E falls back to starting the same build through the signed `dotnet` host on this developer PC. That's a test harness only, not a distribution route. | Only if IT trusts or signs it (DEPLOYMENT_GUIDE §6). The default desktop experience is the Edge app |

### Blocked (external configuration needed)

| Item | Needs |
|---|---|
| Real Microsoft sign-in (approved account, personal account, external tenant) | Entra app registration (DEPLOYMENT_GUIDE §2) |
| Persistence on Supabase | Supabase project + `DATABASE_URL` (§1) |
| Live deployment at `tasksync-vgam.onrender.com` | Render build/start commands and env vars (§4) |

## Bugs found by testing and fixed

1. Mention autocomplete couldn't find colleagues approved after page load → server now broadcasts directory changes, and the input falls back to a live server search.
2. Employee context menu rendered behind the task drawer → z-index stacking fixed.
3. Blank environment variables (common in hosting dashboards) failed config validation → treated as unset.
4. Offline writes waited up to 2 minutes (cold-start retry) instead of going to the offline outbox → fail fast when the browser is offline.
5. WebSocket rejections for wrong tenant/domain used the "retry" close code → now 4403 (don't retry).
6. PGlite data directory wasn't created automatically → created on startup.
7. Settings page unreachable on phones → settings button in the mobile top bar.

## How to rerun everything

```bash
npm ci
npm run build && npm run build:desktop
npm test && npm run test:pg && npm run test:desktop
npm run test:e2e && npm run test:e2e:desktop
```
