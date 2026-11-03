# TaskSync

**Create once. Assign once. Synchronise everywhere.**

TaskSync is Omnifi's internal task manager. Employees sign in with their company Microsoft account, create tasks,
assign them to colleagues with `@mentions`, and see every change instantly on the web dashboard and the floating
Windows widget, across everyone's computers.

- **One authoritative record per task.** When Stella completes a task Rahul gave her, it's completed for both of
  them at once, with who and when recorded.
- **Statuses:** Pending, In Progress, Completed, Cancelled, Declined and Reassigned, with full assignment history
  and an activity log.
- **Real-time:** WebSocket push, replay of anything missed while offline, an offline outbox, and an automatic
  HTTP fallback when a corporate proxy blocks WebSockets.
- **Access:** Microsoft Entra ID (single tenant), validated on the server, `@myomnifi.com` only, plus admin approval
  for every new employee.
- **Windows companion:** a floating, resizable widget (C#/.NET 8 + WebView2) with tray icon, Windows notifications,
  always-on-top, start with Windows, **hidden from screen sharing**, and **stays put on Win+D / desktop peek**.
- **Teams:** click any employee's name, choose *Message in Teams*, and TaskSync copies a PNG task card to your
  clipboard and opens your one-to-one chat with them. You paste and send.
- **Dark Liquid Glass UI:** translucent layered panels, blue-violet accents, Windows 11 typography, responsive down
  to phone width.

## Repository layout

```
shared/    Domain types, statuses, mention + Teams link helpers (TypeScript, used by API and UI)
server/    API: Fastify + TypeScript, PostgreSQL (Supabase), Entra token validation, WebSockets
web/       Dashboard and widget UI: React + TypeScript + Vite, MSAL sign-in
desktop/   Windows companion: C#/.NET 8 WinForms + WebView2 (+ xUnit tests)
e2e/       End-to-end tests: Microsoft Edge (two users) and the real desktop app
scripts/   Dev runner, build guard, icon generator
```

## Run it locally (no cloud accounts needed)

Requirements: Node.js 22+, and for the desktop app the .NET 8 SDK.

```bash
npm ci
npm run dev
```

Open <http://localhost:5173> and pick a fictional development user (Dev Admin, Alex Morgan, …). The API uses an
embedded PostgreSQL (PGlite) in `.data/pglite`. Open a second browser window with another user to watch tasks sync
between them.

Desktop widget against the local server:

```bash
npm run build:desktop
desktop\TaskSync.Desktop\bin\Release\net8.0-windows\TaskSync.exe --url http://localhost:3000
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API (dev sign-in, local DB) + Vite dev server |
| `npm run build` | Build shared, API and web for production |
| `npm start` | Start the production server (serves API and dashboard) |
| `npm test` | API integration tests (PGlite) + web unit tests |
| `npm run test:pg` | API tests against a real PostgreSQL server (concurrency) |
| `npm run test:e2e` | Two-user browser tests in Microsoft Edge |
| `npm run build:desktop` / `npm run test:desktop` | Build / unit-test the Windows app |
| `npm run test:e2e:desktop` | Drive the real Windows widget end to end |
| `npm run publish:desktop` | Produce `desktop/publish/TaskSync/TaskSync.exe` |

## Documentation

- [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md): step-by-step Supabase, Entra ID, Render and desktop setup
- [ARCHITECTURE.md](ARCHITECTURE.md): how the pieces fit, data model, real-time protocol
- [SECURITY.md](SECURITY.md): threat model and controls
- [TEST_REPORT.md](TEST_REPORT.md): what was tested and the results
- [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md): done, pending, known issues, actions needed
- [.env.example](.env.example): every configuration variable

Internal Omnifi software. Not for public distribution.
