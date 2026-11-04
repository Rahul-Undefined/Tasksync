# TaskSync deployment guide

This guide walks through every manual step needed to run TaskSync for Omnifi, in order.
Everything here uses **free tiers only**. None of the steps asks for a credit card. If a screen ever asks for
payment details, stop: you are on a paid path.

| Piece | Service | Cost |
|---|---|---|
| Web dashboard + API | Render **Free** web service (existing `tasksync-vgam`, Docker) | ₹0 |
| Data storage | A **private GitHub repository**: encrypted snapshots written by TaskSync | ₹0 |
| Sign-in | Your company Microsoft login (an Entra app registration you create yourself, no admin) | ₹0 |
| Source code | GitHub `Rahul-Undefined/Tasksync` | ₹0 |
| Desktop | TaskSync installed as a Microsoft Edge app + pop-out widget (no installer) | ₹0 |

**Only GitHub and Render accounts are needed.** No database service. TaskSync keeps its database in the server's
memory, saves an encrypted snapshot to your private `tasksync-data` repository a few seconds after every change
(and when Render puts the server to sleep), keeps 7 daily backups there, and restores the latest snapshot on every
start. If the server crashes outright (not a normal sleep or restart), the last few seconds of changes can be lost.

> **No IT admin is needed** for any step below, assuming Omnifi's tenant keeps Microsoft's default settings
> (users may register apps and consent to basic sign-in). If a step shows an error saying an administrator is
> required, stop and send the exact message.

## ⚡ Quick setup: about 15 minutes

**A. GitHub: a private data repository** (2 min)
1. <https://github.com/new> → Repository name `tasksync-data` → **Private** → **Create repository**.

**B. GitHub: a token that can only touch that repository** (3 min)
1. <https://github.com/settings/personal-access-tokens/new> (Settings → Developer settings → Personal access
   tokens → **Fine-grained tokens** → Generate new token).
2. Token name `TaskSync data`. Expiration: the longest offered (e.g. 1 year). Put a reminder in your calendar.
3. **Repository access → Only select repositories → `tasksync-data`**.
4. **Permissions → Repository permissions → Contents → Read and write**. Leave everything else as is.
5. **Generate token** and copy it (starts with `github_pat_`). GitHub shows it only once.

**C. An encryption passphrase** (1 min)
Make up a long secret sentence (at least 16 characters) and save it in your password manager.
**Without it the saved data can't be read, not even by you.**

**D. Microsoft sign-in** (3 min)
<https://entra.microsoft.com> → App registrations → **New registration**: name `TaskSync`, *single tenant*,
platform **Single-page application**, redirect `https://tasksync-vgam.onrender.com/` → **Register** → copy the
**Application (client) ID**.

**E. Render** → your service → **Environment** → add these 4 → **Save, rebuild, and deploy**:

| Key | Value |
|---|---|
| `GITHUB_DATA_TOKEN` | the token from B |
| `DATA_ENCRYPTION_KEY` | the passphrase from C |
| `ENTRA_CLIENT_ID` | the client ID from D |
| `BOOTSTRAP_ADMIN_EMAILS` | your work email, e.g. `rahul@myomnifi.com` |

The data repository is found automatically (`<your GitHub name>/tasksync-data`); set `GITHUB_DATA_REPO` only if
you named it differently. After about 5 minutes open the site → **Sign in with Microsoft** → you're the admin.

The sections below explain each step in detail, plus optional hardening.

> **Company data:** because IT hasn't reviewed these services, keep task text to internal coordination ("send
> the March MIS to the client"). Don't paste client confidential data such as account numbers, statements or
> passwords into tasks or comments. Add a trusted colleague as a second owner of the Entra app and the GitHub
> repositories, so TaskSync doesn't depend on one person.

---

## 0. Make the GitHub repository private (recommended, 2 minutes)

The repository was publicly readable when this project started. TaskSync contains no secrets, but it is internal
company software.

1. Open <https://github.com/Rahul-Undefined/Tasksync> → **Settings** → **General** → scroll to **Danger Zone**.
2. **Change repository visibility** → **Make private**. Private repositories are free on GitHub.
3. Render keeps deploying a private repo as long as its GitHub connection has access. If a deploy later says
   "repository not found", open Render → **Account settings → GitHub** and grant access to `Tasksync`.

---

## 1. Data storage: a private GitHub repository (about 5 minutes)

Steps A–C of the quick setup. Details:
- **Why a private repo?** Render's free plan has no permanent disk (files vanish on restart) and its free
  database is deleted after 30 days, so TaskSync stores its data in GitHub instead. Each save is one small
  commit that replaces the previous one (no growing history), with `tasksync-snapshot.bin` (latest) and
  `backups/YYYY-MM-DD.bin` (last 7 days).
- **Encryption:** snapshots are AES-256-GCM encrypted with a key derived from `DATA_ENCRYPTION_KEY` before they
  leave the server. The repository only ever contains ciphertext. Keep the passphrase safe; changing it later
  needs an export/import.
- **Safety:** on start TaskSync loads the latest snapshot **before** serving anyone. If GitHub can't be read
  (wrong token, outage), it serves nothing, keeps retrying, and never overwrites the stored data with an empty
  database. `/api/health` shows `"storage"` with the last save time and any error.
- **Token:** fine-grained, limited to the `tasksync-data` repository, *Contents: Read and write* only. It can't
  touch your code repository. When it expires, saving fails (shown in `/api/health`; data stays in memory until
  restart), so create a new token and update `GITHUB_DATA_TOKEN` before that date.
- **Limits:** built for one Render instance (the free plan runs one). GitHub's API allows 5,000 requests an hour;
  TaskSync uses about 6 per save and batches changes, which is far below that for a team.

### Alternative: a PostgreSQL database (optional)
If you ever get a PostgreSQL database (e.g. Supabase Free or a paid host), set `DATABASE_URL` instead of the
GitHub variables. TaskSync then uses that database directly. For Supabase, copy the **Session pooler**
connection string from the project's **Connect** button; Supabase's certificate is built in.
If you created a Supabase project earlier and don't need it, you can delete it (Project Settings → General).

---

## 2. Register TaskSync in Microsoft Entra ID yourself (about 10 minutes, no admin)

TaskSync signs people in with **only** `openid`, `profile` and `email`, the same basic permissions as "Sign in
with Microsoft" on any site. In a default Microsoft 365 tenant, any employee can register such an app and every
employee can accept it for themselves. **No "Expose an API", no "Grant admin consent", no Enterprise-app changes.**

### 2.1 Create the registration
1. Open <https://entra.microsoft.com> and sign in with your work account (or use <https://portal.azure.com> →
   search **App registrations**).
2. **App registrations → New registration**.
   - If you see *"You do not have access"* or the **New registration** button is greyed out, your tenant blocks
     self-service registration. Stop and tell me (see 2.5).
3. Name: `TaskSync`.
4. Supported account types: **Accounts in this organizational directory only (Omnifi only – Single tenant)**.
5. Redirect URI: choose platform **Single-page application (SPA)** and enter
   `https://tasksync-vgam.onrender.com/` (with the trailing slash).
6. **Register**.
7. On **Overview**, copy the **Application (client) ID** → **`ENTRA_CLIENT_ID`**. It isn't a secret.
   The tenant ID is looked up automatically from `myomnifi.com` when the server starts (Microsoft publishes it).
   Set `ENTRA_TENANT_ID` only if that lookup fails (the Render log says so).

You are now the **owner** of this registration. Under **Owners → Add owners**, add one trusted colleague so the
app isn't tied to a single account.

### 2.2 Recommended extras (owner-only, still no admin)
- **Flag guest accounts:** **Token configuration → Add optional claim → ID → `acct` → Add**. TaskSync then
  rejects guests even before the email-domain check. If a pop-up offers to add Microsoft Graph permissions, untick
  it; TaskSync doesn't need them.
- **Local development:** **Authentication → Single-page application → Add URI** →
  `http://localhost:5173/` and `http://localhost:3000/`.

Leave **API permissions** as they are (*Microsoft Graph → User.Read*, which needs no admin). Don't add anything.

### 2.3 What employees see on first sign-in
A Microsoft screen *"Permissions requested: TaskSync, unverified. This app would like to: sign you in and read
your profile"* → **Accept**. That's normal for an app registered inside your own organisation.

### 2.4 What TaskSync checks on every request (server-side)
The token's signature (Microsoft's keys for **your tenant**), issuer, audience (exactly your client ID), the exact
tenant ID, expiry, no personal/guest/external identity, an `@myomnifi.com` address, and finally an
**approved, active TaskSync account** (step 5). Access control doesn't depend on Entra admin settings:
anyone in Omnifi can sign in, but only people **you** approve inside TaskSync get any data.

### 2.5 If Microsoft says an administrator is needed
- **Can't register apps** (2.1 step 2), or employees see **"Need admin approval"** at sign-in: the tenant has
  locked these down. There's no safe way around that inside Microsoft sign-in. Tell me and I'll switch TaskSync to
  **email one-time codes** sent to `@myomnifi.com` addresses (free email service, no Microsoft admin involved).
- **AADSTS50011 (redirect URI mismatch):** fix the URI in 2.1 step 5 exactly, including the trailing slash.

### 2.6 Optional: API access tokens (only if IT ever helps)
With an admin you can also **Expose an API** (`api://<client-id>/access_as_user`), grant admin consent and set
`ENTRA_TOKEN_MODE=access` in Render. The app then sends access tokens instead of ID tokens. This isn't needed.

---

## 3. Decide the first administrator

Pick the work email(s) that should be TaskSync administrators from day one, e.g. `rahul@myomnifi.com`.
They go into **`BOOTSTRAP_ADMIN_EMAILS`**. Everyone else who signs in lands on "Waiting for approval" until an
admin approves them under **Admin → Access requests**.

---

## 4. Configure the existing Render service (about 10 minutes)

Open <https://dashboard.render.com> → the service behind `tasksync-vgam.onrender.com`.

### 4.1 Check the repository connection
The existing `tasksync-vgam` service uses Render's **Docker** runtime. It builds the `Dockerfile` at the root of
the repo, so there are **no build or start commands to enter**.

**Settings → Build & Deploy**:
- Repository: `Rahul-Undefined/Tasksync`, Branch: `main`. If it points anywhere else, stop and check before changing it.
- Root Directory: *(empty)*
- Dockerfile Path: `./Dockerfile` (the default). Docker Build Context Directory: `.` (the default).
- Docker Command: *(empty)*. The Dockerfile already starts the server.
- **Auto-Deploy:** On commit (optional)
- Instance type must stay **Free**. Do not pick a paid instance.

(If you ever create a new **Node** service instead, use build command `npm ci --include=dev && npm run build` and
start command `npm start`. A new service gets a different `onrender.com` URL.)

### 4.2 Health check
**Settings → Health Check Path:** `/api/health`

### 4.3 Environment variables
**Environment → Add environment variable** (use **Add from .env** to paste several at once):

| Key | Value |
|---|---|
**Required:**

| Key | Value |
|---|---|
| `GITHUB_DATA_TOKEN` | Fine-grained token for the `tasksync-data` repository (step 1) |
| `DATA_ENCRYPTION_KEY` | Your passphrase, at least 16 characters (step 1) |
| `ENTRA_CLIENT_ID` | Application (client) ID from step 2.1 |
| `BOOTSTRAP_ADMIN_EMAILS` | e.g. `rahul@myomnifi.com` |

(Or `DATABASE_URL` instead of the two GitHub variables if you use a PostgreSQL database.)

**Optional** (defaults are fine): `GITHUB_DATA_REPO` (default `<owner>/tasksync-data`), `ALLOWED_EMAIL_DOMAINS` (default `myomnifi.com`), `ENTRA_TENANT_ID`
(auto-discovered), `PUBLIC_BASE_URL` (defaults to Render's URL), `DATABASE_CA_CERT` (Supabase's CA is built in),
`ENTRA_TOKEN_MODE` (default `id`, the no-admin mode; see 2.6), `RATE_LIMIT_PER_MINUTE` (default 300).
**Settings → Health Check Path** `/api/health` is recommended but optional.

`NODE_ENV=production` and `PORT` are already handled by the Dockerfile and Render; don't add them.
**Never** set `DEV_AUTH` on Render. The server refuses to start in production if you do.

### 4.4 Deploy and verify
1. **Manual Deploy → Deploy latest commit** (or push to `main`).
2. Watch **Logs**. The first Docker build takes about 3–6 minutes. With GitHub storage you should see
   `[storage] using encrypted snapshots in github:…/tasksync-data` and then either `no snapshot … yet` (first run)
   or `loaded snapshot …`. Before the variables are set, it shows `[startup] … not set` warnings and still starts.
3. Open <https://tasksync-vgam.onrender.com/api/health>. Expected:
   `{"status":"ok","database":"ok","auth":"entra",...}`.
   - `"database":"not_configured"` → the storage variables are missing; `"storage"` says which.
   - `"database":"loading"` → it's restoring the snapshot; give it a few seconds.
   - `"database":"error"` → GitHub couldn't be read (token, repo name, expiry). `"storage"."lastError"` says why.
   - `"auth":"not_configured"` → `ENTRA_CLIENT_ID` is missing, or the tenant lookup failed (see the log line
     `[startup] Microsoft Entra tenant for …`).
4. Open <https://tasksync-vgam.onrender.com>, click **Sign in with Microsoft**, and use your bootstrap admin
   account. You should land on **My Tasks**.

**Free-tier behaviour:** Render free services sleep after 15 minutes without traffic. The first visit after that
takes about a minute while it wakes. TaskSync shows "Waking up the TaskSync server…" and retries by itself. Normal
office-hours use (page loads, heartbeats from open dashboards and widgets) tends to keep it awake, but I haven't
verified how Render counts long-lived WebSocket traffic, so expect an occasional cold start. The free tier
includes 750 instance hours a month, enough for one service running all the time.

---

## 5. Onboard employees

**By default there is no approval step:** anyone signing in with a verified Omnifi Microsoft account
(your tenant, `@myomnifi.com`, not a guest or personal account) gets in immediately, and admins get a
"joined TaskSync" notification. To require approval again, set `AUTO_APPROVE_EMPLOYEES=false` in Render.
Admins can always **deactivate** someone (Admin → All users), which blocks them at once.

The steps below apply when approval is switched on:

1. Share the link `https://tasksync-vgam.onrender.com`.
2. Each person signs in with their Omnifi Microsoft account and sees **Waiting for approval**.
3. An admin opens **Admin → Access requests → Approve**. The person's screen switches to TaskSync on its own.
4. To remove someone: **Admin → All users → Deactivate**. Their open sessions close immediately and they can't
   get back in, even though their Microsoft account still exists. When someone leaves Omnifi, IT disabling their
   Microsoft account also blocks sign-in, but deactivating them in TaskSync is enough on its own.

---

## 6. TaskSync on the Windows desktop (no installer, no admin)

### Recommended: install it as an Edge app (1 minute per person)
1. Open <https://tasksync-vgam.onrender.com> in **Microsoft Edge** and sign in.
2. Either **Settings → Windows desktop app → Install**, or Edge menu **(…) → Apps → Install this site as an app**
   → **Install**.
3. TaskSync now has its own window, Start-menu entry and taskbar icon showing your open-task count. Windows
   notifications come from the app (turn them on in **Settings → Notifications** if your browser asks).
4. **Start with Windows:** open `edge://apps`, right-click **TaskSync** → tick **Start automatically when you sign in**
   (wording varies slightly between Edge versions).
5. **Floating widget:** click **Pop out widget** in the top bar. A small always-on-top TaskSync window opens. It
   updates live and stays open while the main TaskSync window is open (it can be minimised).

| Feature | Edge app + pop-out (no admin) | Native `TaskSync.exe` (needs IT) |
|---|---|---|
| Own window, taskbar icon, start menu, task-count badge | ✅ | ✅ (tray icon) |
| Windows notifications | ✅ via Edge | ✅ |
| Start with Windows | ✅ (Edge setting) | ✅ |
| Floating always-on-top widget | ✅ pop-out (needs the main window open) | ✅ |
| Hidden from screen sharing | ❌ not possible from a web page | ✅ |
| Stays visible on Win+D / peek | ❓ not verified for the pop-out | ✅ |
| Teams + clipboard image | ✅ | ✅ |

### The native app and Omnifi's Defender policy
`desktop/` also contains a native Windows companion (C#/.NET + WebView2), the only way to get screen-share hiding.
On Omnifi PCs, **Microsoft Defender's attack-surface-reduction rule** *"Block executable files from running unless
they meet a prevalence, age, or trusted list criterion"* is in block mode, so a freshly built, unsigned
`TaskSync.exe` is refused ("Access is denied", Defender event 1121). That rule is a company security control.
Don't try to get around it: the native app can only be used if IT adds it to their trusted list or it's signed
with a certificate Omnifi trusts. Until then, use the Edge app above.

### Native app updates
Installed copies update themselves; nobody has to download a new version by hand:

1. Release a version: `git tag desktop-v0.2.1` then `git push origin desktop-v0.2.1`. The **Desktop release**
   GitHub Action (free on a public repo) tests, builds and publishes `TaskSync-win-x64.zip` as a GitHub release.
2. The TaskSync server reads the newest `desktop-v*` release (`GET /api/desktop/latest`, cached 10 min).
   It uses the code repository Render deploys from; set `DESKTOP_RELEASES_REPO=owner/name` to use another.
3. Each running app checks 45 seconds after start and every 6 hours, downloads the zip, checks its SHA-256 against
   the one GitHub published, and unpacks it to `%LOCALAPPDATA%\TaskSync\versions\<version>` (no admin rights).
   The next start uses it, or **tray icon → Restart to update** / the ⟳ button in the widget. "Start with Windows"
   follows it to the new folder, and old versions are removed.

The Defender rule above applies to every new build as well: on Omnifi PCs updates work only once IT trusts the app.
Developers can still build and test it (`npm run publish:desktop`, `npm run test:e2e:desktop`). The test harness
starts the build through the signed `dotnet` host on the developer's own machine. That's for testing, not a way
to distribute the app.

## 7. Local development

```bash
npm ci
npm run dev
```
Then open <http://localhost:5173>. Without Entra variables, the local server offers **development sign-in** with
fictional users (Dev Admin, Alex Morgan, …) and stores data in `.data/pglite` (embedded PostgreSQL). To test
against Supabase or Entra locally, copy `.env.example` to `.env` and fill it in. `.env` is git-ignored.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| "TaskSync is almost ready" page | Health check shows which variable is missing (step 4.3). |
| Microsoft says *AADSTS50011 redirect URI mismatch* | Add the exact URL (with trailing `/`) under Authentication → SPA (step 2.1). |
| Microsoft says *Need admin approval* or *AADSTS65001* | Your tenant blocks user consent. See 2.5 (email-code fallback). |
| Signed in but "This account does not belong to the Omnifi organisation" | You used a personal/other-tenant account; sign out and pick the work account. |
| "Your access request is waiting…" forever | An admin must approve you; check `BOOTSTRAP_ADMIN_EMAILS` for the first admin. |
| Status pill shows **Live (HTTP fallback)** | Your network blocks WebSockets. Updates still arrive every 15 seconds. Ask IT to allow WebSockets to `tasksync-vgam.onrender.com` for instant updates. |
| `self-signed certificate in certificate chain` in Render logs | Only for non-Supabase databases: set `DATABASE_CA_CERT`. |
| `/api/health` storage error mentions `GITHUB_DATA_TOKEN` | Token expired or lacks *Contents: Read and write* on `tasksync-data`; create a new one and update Render. |
| `Snapshot could not be decrypted` | `DATA_ENCRYPTION_KEY` in Render isn't the one used to save the data. Put the original back. |
