# TaskSync deployment guide

This guide walks through every manual step needed to run TaskSync for Omnifi, in order.
Everything here uses **free tiers only**. None of the steps asks for a credit card. If a screen ever asks for
payment details, stop: you are on a paid path.

| Piece | Service | Cost |
|---|---|---|
| Web dashboard + API | Render **Free** web service (existing `tasksync-vgam`) | ₹0 |
| Database | Supabase **Free** PostgreSQL | ₹0 |
| Sign-in | Microsoft Entra ID app registration you create yourself (no admin consent) | ₹0 |
| Source code | GitHub `Rahul-Undefined/Tasksync` | ₹0 |
| Desktop | TaskSync installed as a Microsoft Edge app + pop-out widget (no installer) | ₹0 |

> **No IT admin is needed** for any step below, assuming Omnifi's tenant keeps Microsoft's default settings
> (users may register apps and consent to basic sign-in). If a step shows an error saying an administrator is
> required, stop and send the exact message. There are fallbacks, but they should be chosen deliberately.

> **Order matters.** Do steps 1–3 first. Render (step 4) needs the values they produce.

> **Company data:** because IT hasn't reviewed these services, keep task text to internal coordination ("send
> the March MIS to the client"). Don't paste client confidential data such as account numbers, statements or
> passwords into tasks or comments. Sign up for Supabase and Render with an email you'll keep, and add a
> trusted colleague as a second owner, so TaskSync doesn't depend on one person.

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
7. On **Overview**, copy two values. Neither is a secret:
   - **Application (client) ID** → **`ENTRA_CLIENT_ID`**
   - **Directory (tenant) ID** → **`ENTRA_TENANT_ID`**

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

Optional: `ENTRA_TOKEN_MODE` (default `id`, the no-admin mode; see 2.6), `RATE_LIMIT_PER_MINUTE` (default 300).

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
| `self-signed certificate in certificate chain` in Render logs | Set `DATABASE_CA_CERT` (step 1.5 / 4.3). |
| Supabase project paused | Supabase dashboard → Restore project. |
