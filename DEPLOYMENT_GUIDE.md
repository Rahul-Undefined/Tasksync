# TaskSync deployment guide

This guide walks through every manual step needed to run TaskSync for Omnifi, in order.
Everything here uses **free tiers only**. None of the steps asks for a credit card. If a screen ever asks for
payment details, stop: you are on a paid path.

| Piece | Service | Cost |
|---|---|---|
| Web dashboard + API | Render **Free** web service (existing `tasksync-vgam`) | ₹0 |
| Database | Supabase **Free** PostgreSQL | ₹0 |
| Sign-in | Microsoft Entra ID app registration (part of your Microsoft 365 tenant) | ₹0 |
| Source code | GitHub `Rahul-Undefined/Tasksync` | ₹0 |
| Desktop app | Built from this repo with the free .NET SDK | ₹0 |

> **Order matters.** Do steps 1–3 first. Render (step 4) needs the values they produce.

---

## 0. Make the GitHub repository private (recommended, 2 minutes)

The repository was publicly readable when this project started. TaskSync contains no secrets, but it is internal
company software.

1. Open <https://github.com/Rahul-Undefined/Tasksync> → **Settings** → **General** → scroll to **Danger Zone**.
2. **Change repository visibility** → **Make private**. Private repositories are free on GitHub.
3. Render keeps deploying a private repo as long as its GitHub connection has access. If a deploy later says
   "repository not found", open Render → **Account settings → GitHub** and grant access to `Tasksync`.

---

## 1. Create the database (Supabase Free, about 10 minutes)

1. Go to <https://supabase.com> → **Start your project** → sign in (GitHub sign-in is fine).
2. **New project**
   - Organisation: create one on the **Free** plan.
   - Name: `tasksync`
   - Database password: click **Generate a password** and store it in your password manager.
   - Region: **South Asia (Mumbai)**, the closest to Omnifi users.
3. Wait until the project shows **Healthy** (1–2 minutes).
4. Click **Connect** (top of the project page) → **Connection string** → choose **Session pooler**.
   Copy the URI. It looks like
   `postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`.
   Replace `[YOUR-PASSWORD]` with the password from step 2. This is your **`DATABASE_URL`**.
   - Use the *Session pooler*, not *Direct connection*. The direct address is IPv6-only and Render can't reach it.
5. **Database certificate**: Project **Settings → Database → SSL Configuration → Download certificate**.
   Open the `.crt` file in Notepad. You'll paste it into Render as **`DATABASE_CA_CERT`** in step 4.
6. Optional, recommended: **Settings → Data API**: turn **off** "Enable Data API". TaskSync never uses Supabase's
   public REST API. The tables are already locked (row level security on, no public grants), and this closes the door completely.

You do **not** need to create tables. TaskSync creates and upgrades its own schema on startup (migrations).

Free-tier limits to know about:
- 500 MB of database storage, which is plenty for years of tasks.
- **A free project pauses after 7 days with no activity.** Normal daily use keeps it awake. If it pauses, open the
  Supabase dashboard and click **Restore project**.

---

## 2. Register TaskSync in Microsoft Entra ID (about 15 minutes; may need IT)

Creating app registrations and granting admin consent usually needs the **Application Administrator** or
**Cloud Application Administrator** role. On Omnifi's tenant this is probably IT. Send them this section.

### 2.1 Create the registration
1. <https://entra.microsoft.com> → **Identity → Applications → App registrations → New registration**.
2. Name: `TaskSync`.
3. Supported account types: **Accounts in this organizational directory only (Omnifi only – Single tenant)**.
4. Redirect URI: platform **Single-page application (SPA)**, URI `https://tasksync-vgam.onrender.com/`
   (include the trailing slash).
5. **Register**.
6. On **Overview**, copy:
   - **Application (client) ID** → this is **`ENTRA_CLIENT_ID`**
   - **Directory (tenant) ID** → this is **`ENTRA_TENANT_ID`**

### 2.2 Add development redirect URIs (optional)
**Authentication → Single-page application → Add URI**: `http://localhost:5173/` and `http://localhost:3000/`.

### 2.3 Expose the TaskSync API
1. **Expose an API → Application ID URI → Add** and accept the default `api://<client-id>` → **Save**.
2. **Add a scope**
   - Scope name: `access_as_user`
   - Who can consent: **Admins and users**
   - Admin consent display name: `Access TaskSync`
   - Admin consent description: `Allows TaskSync to identify you and act on your tasks.`
   - State: **Enabled** → **Add scope**.

### 2.4 Grant consent
1. **API permissions → Add a permission → APIs my organization uses** (or **My APIs**) → **TaskSync** →
   **Delegated** → tick `access_as_user` → **Add permissions**.
2. Click **Grant admin consent for Omnifi** → **Yes**. Keep the default *Microsoft Graph → User.Read*.

### 2.5 Use v2 access tokens (recommended)
**Manifest** → set `"requestedAccessTokenVersion": 2` (in the new manifest editor it is under `"api"`) → **Save**.
TaskSync accepts both v1 and v2 tokens from your tenant, but v2 is the modern format.

### 2.6 Flag guest accounts in tokens (recommended)
**Token configuration → Add optional claim → Access token → `acct`** → **Add**. TaskSync rejects guests
(`acct = 1`) even before the email-domain check.

### 2.7 Limit who can sign in at all (strongly recommended)
**Enterprise applications → TaskSync → Properties → Assignment required? → Yes → Save**, then
**Users and groups → Add user/group** and add the employees who should use TaskSync.
- On **Entra ID Free** you can assign individual **users**. Assigning a **group** needs Entra ID P1/P2. If Omnifi
  already has Microsoft 365 Business Premium or E3/E5, P1 is included at no extra cost.
- If you skip this, any account in the Omnifi tenant can *request* access. TaskSync's own admin approval then
  decides who gets in.

What TaskSync checks on **every** request, server-side: token signature (Microsoft's keys for *your* tenant),
issuer, audience, the exact tenant ID, the `access_as_user` scope, no personal/guest/external identity, an
`@myomnifi.com` address, and finally an approved, active TaskSync account.

---

## 3. Decide the first administrator

Pick the work email(s) that should be TaskSync administrators from day one, e.g. `rahul@myomnifi.com`.
They go into **`BOOTSTRAP_ADMIN_EMAILS`**. Everyone else who signs in lands on "Waiting for approval" until an
admin approves them under **Admin → Access requests**.

---

## 4. Configure the existing Render service (about 10 minutes)

Open <https://dashboard.render.com> → the service behind `tasksync-vgam.onrender.com`.

### 4.1 Check the repository connection
**Settings → Build & Deploy**:
- Repository: `Rahul-Undefined/Tasksync`, Branch: `main`. If it points anywhere else, stop and check before changing it.
- Root Directory: *(empty)*
- Runtime: **Node**
- **Build Command:** `npm ci --include=dev && npm run build`
- **Start Command:** `npm start`
- **Auto-Deploy:** On commit (optional)
- Instance type must stay **Free**. Do not pick a paid instance.

### 4.2 Health check
**Settings → Health Check Path:** `/api/health`

### 4.3 Environment variables
**Environment → Add environment variable** (use **Add from .env** to paste several at once):

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `22` |
| `DATABASE_URL` | Session-pooler URI from step 1.4 |
| `DATABASE_CA_CERT` | Contents of the certificate from step 1.5 (see note) |
| `ENTRA_TENANT_ID` | Directory (tenant) ID from step 2.1 |
| `ENTRA_CLIENT_ID` | Application (client) ID from step 2.1 |
| `ALLOWED_EMAIL_DOMAINS` | `myomnifi.com` |
| `BOOTSTRAP_ADMIN_EMAILS` | e.g. `rahul@myomnifi.com` |
| `PUBLIC_BASE_URL` | `https://tasksync-vgam.onrender.com` |

Optional: `ENTRA_REQUIRED_ROLE` (if you create an app role and assign it), `RATE_LIMIT_PER_MINUTE` (default 300).

**`DATABASE_CA_CERT` note:** paste the whole certificate including the `-----BEGIN/END CERTIFICATE-----` lines.
If the field only takes one line, replace each line break with the two characters `\n`; TaskSync converts them
back. If you can't get the certificate, you can temporarily set `DATABASE_SSL=no-verify`. The connection stays
encrypted, but the server's identity isn't verified, so fix this properly later.

**Never** set `DEV_AUTH` on Render. The server refuses to start in production if you do.

### 4.4 Deploy and verify
1. **Manual Deploy → Deploy latest commit** (or push to `main`).
2. Watch **Logs**. You should see `[migrate] applied 001_core_schema, 002_lock_down_data_api` on the first boot,
   then `Server listening`.
3. Open <https://tasksync-vgam.onrender.com/api/health>. Expected:
   `{"status":"ok","database":"ok","auth":"entra",...}`.
   - `"database":"not_configured"` → `DATABASE_URL` is missing.
   - `"database":"error"` → wrong password, wrong pooler URL or certificate problem. Check the Render logs.
   - `"auth":"not_configured"` → the Entra variables are missing.
4. Open <https://tasksync-vgam.onrender.com>, click **Sign in with Microsoft**, and use your bootstrap admin
   account. You should land on **My Tasks**.

**Free-tier behaviour:** Render free services sleep after 15 minutes without traffic. The first visit after that
takes about a minute while it wakes. TaskSync shows "Waking up the TaskSync server…" and retries by itself. Normal
office-hours use (page loads, heartbeats from open dashboards and widgets) tends to keep it awake, but I haven't
verified how Render counts long-lived WebSocket traffic, so expect an occasional cold start. The free tier
includes 750 instance hours a month, enough for one service running all the time.

---

## 5. Onboard employees

1. Share the link `https://tasksync-vgam.onrender.com`.
2. Each person signs in with their Omnifi Microsoft account and sees **Waiting for approval**.
3. An admin opens **Admin → Access requests → Approve**. The person's screen switches to TaskSync on its own.
4. To remove someone: **Admin → All users → Deactivate**. Their open sessions close immediately. In Entra, also
   remove them from the TaskSync enterprise app (or disable their account) when they leave Omnifi.

---

## 6. Windows desktop companion

### Build (developer machine)
```bash
npm run publish:desktop
```
This produces `desktop\publish\TaskSync\TaskSync.exe` (about 1 MB) plus `WebView2Loader.dll`. It needs:
- **.NET 8 Desktop Runtime** (free, from Microsoft). Omnifi PCs may already have it.
- **Microsoft Edge WebView2 Runtime**, which is built into Windows 11.

### Distribute on company PCs (needs IT)
Omnifi's PCs run an application-control policy: an unsigned `TaskSync.exe` built locally was blocked
("Access is denied") during development. **Don't work around this.** Ask IT for one of:
- **Allowlisting** `TaskSync.exe` by file hash or publisher in the existing AppLocker/WDAC/Intune policy and
  deploying it with Intune (Win32 app). This is free.
- **Code signing** the executable with a certificate Omnifi already owns. Buying a new code-signing certificate
  costs money and isn't part of the ₹0 plan.

### First run
- `TaskSync.exe` opens the floating widget and signs in with Microsoft. The sign-in persists in
  `%LOCALAPPDATA%\TaskSync\WebView2`.
- Tray icon menu: show widget, open dashboard, expanded mode, keep on top, **hide from screen sharing**,
  **stay visible on Show desktop (Win+D)**, start with Windows, settings, exit.
- To point it at a different server: `TaskSync.exe --url https://your-host` (HTTPS only).
- Settings are stored in `%LOCALAPPDATA%\TaskSync\settings.json`. Start-with-Windows uses the per-user Run key,
  so it needs no admin rights.

---

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
| Microsoft says *AADSTS65001 consent required* | Grant admin consent (step 2.4). |
| Signed in but "This account does not belong to the Omnifi organisation" | You used a personal/other-tenant account; sign out and pick the work account. |
| "Your access request is waiting…" forever | An admin must approve you; check `BOOTSTRAP_ADMIN_EMAILS` for the first admin. |
| Status pill shows **Live (HTTP fallback)** | Your network blocks WebSockets. Updates still arrive every 15 seconds. Ask IT to allow WebSockets to `tasksync-vgam.onrender.com` for instant updates. |
| `self-signed certificate in certificate chain` in Render logs | Set `DATABASE_CA_CERT` (step 1.5 / 4.3). |
| Supabase project paused | Supabase dashboard → Restore project. |
