# TaskSync security

TaskSync holds internal Omnifi work information. This document lists what is protected, how, and what is
still open. Report security problems privately to the TaskSync administrators, not in public issues.

## Threat model (what we defend against)

| Threat | Control |
|---|---|
| Someone outside Omnifi signs in | Single-tenant Entra app; server verifies signature, issuer and **exact tenant id** on every request; personal (MSA) tenant rejected |
| Guests / B2B / personal accounts invited into the tenant | Rejected via `acct=1`, `idp` claim and `#EXT#` UPN checks (configurable `ALLOW_GUEST_ACCOUNTS`, default off) |
| Ex-employees or not-yet-approved staff | Admin approval before any access; deactivation is immediate (API checks status per request and live WebSockets are closed with code 4403); recommended Entra "assignment required" |
| Forged or replayed tokens | RS256 only, Microsoft JWKS for the tenant, audience = this app (ID token) or this API with scope `access_as_user` (access token), v2 issuer for ID tokens, no `azp`/`appid`/app-only tokens, expiry with 60 s skew; `alg:none`, wrong key, wrong audience, other apps' ID tokens, v1 ID tokens, app-only tokens and expired tokens are covered by tests |
| Email-domain spoofing | Exact domain match (`evilmyomnifi.com`, `myomnifi.com.evil.com`, subdomains rejected). The domain is never the only check |
| Reading or changing other people's tasks (IDOR) | Every task route loads the task and checks participation/role server-side; unknown and forbidden ids both return 404 |
| Privilege escalation | Roles come only from the database; role/`createdBy`/status fields sent by clients are ignored; only admins change roles; the last admin can't be removed |
| Data at rest on GitHub | Snapshots are AES-256-GCM encrypted (scrypt-derived key, random salt/IV, authenticated) before upload; the private repo holds only ciphertext; the token is fine-grained to that one repository with Contents read/write only, so it can't change the code repo |
| Data loss from a misconfigured start | The server never serves or saves until the stored snapshot loaded successfully; an unreadable store means 503, not an empty database overwriting real data; 7 daily backups kept |
| Supabase public APIs exposing tables (only if `DATABASE_URL` points at Supabase) | RLS enabled on every table and all grants revoked from `anon`/`authenticated`, re-applied on every start; recommended: turn off the Data API |
| Service-role keys leaking | TaskSync doesn't use Supabase keys at all; the database URL lives only in Render's environment |
| Injection | Parameterised SQL everywhere; `zod` validation and length limits on every input; LIKE wildcards escaped |
| XSS | React escaping; strict CSP (`script-src 'self'`, no inline scripts, `frame-ancestors 'none'`); comment and mention text is never rendered as HTML |
| Clickjacking / framing | `frame-ancestors 'none'` + `X-Frame-Options` |
| Cross-site WebSocket hijacking | WebSocket auth is in-band with a bearer token (no cookies); Origin header checked |
| Brute force / abuse | Per-user rate limit (300 req/min default, 90/min on writes, 60/min on admin actions); per-IP throttle on repeated failed sign-ins (30/min); body size limit 256 KB |
| Path traversal on static files | Resolved paths must stay inside the web build folder; covered by tests |
| Error leakage | Unknown errors return a generic message with a request id; details go only to server logs; the `Authorization` header is redacted from logs |
| Desktop app as an attack surface | WebView2 only loads the TaskSync origin and Microsoft sign-in hosts; the JS bridge accepts messages only from the TaskSync origin and only allowlisted types; it can only launch Teams deep links (`https://teams.microsoft.com/l/…`, `msteams:/l/…`); clipboard data must be a real PNG; all browser permission requests (camera, mic, location, notifications, clipboard-read) are denied; `--url` accepts HTTPS (or localhost) only |
| Shoulder-surfing during screen sharing | Widget is excluded from screen capture by default (`WDA_EXCLUDEFROMCAPTURE`) |
| Lost updates from concurrent edits | Row locks + conditional updates + optimistic versioning (`409` on conflict) |
| Dev shortcuts reaching production | Development sign-in (`DEV_AUTH`) and the embedded database are refused when `NODE_ENV=production`; tested |

## Secrets

- No secrets are committed. `.env` files are git-ignored; `.env.example` contains placeholders only.
- Secrets live in Render environment variables: `GITHUB_DATA_TOKEN` and `DATA_ENCRYPTION_KEY` (or `DATABASE_URL`).
  Losing `DATA_ENCRYPTION_KEY` makes the stored data unreadable, so keep a copy in a password manager.
- Entra tenant and client IDs are **not** secrets (they appear in every sign-in URL) but are still kept in env vars.
- The SPA uses the public-client auth code + PKCE flow. There is no client secret anywhere.
- Test fixtures use fictional people and a fictional tenant (`example.com`), not real Omnifi data.

## Audit trail

`audit_log` records registrations, bootstrap-admin grants, every admin approval/rejection/deactivation/role change
(with reason, IP and user agent), and denied sign-ins (throttled to one entry per IP and reason every 10 minutes).
`admin_approvals` keeps the full access history per employee. Task changes are in `task_activity`.
Admins can view the latest entries under **Admin → Audit log**.

## Dependency hygiene

- `npm audit`: **0 known vulnerabilities** (checked 2026-11-03). `@fastify/static` was deliberately not used
  because it pulled in vulnerable `glob`/`minimatch` versions; a small audited static handler replaces it.
- Run `npm run audit:deps` before each release. NuGet: `Microsoft.Web.WebView2` 1.0.4314.35.

## Known gaps and recommendations

1. **Make the GitHub repository private.** It was publicly readable at the start of this project.
2. **Turn on Entra "Assignment required"** for the TaskSync enterprise app. Add Conditional Access (MFA,
   compliant device) if Omnifi has Entra ID P1.
3. **Tokens in `localStorage`** (MSAL cache) are readable by any script on the page. This is mitigated by the strict
   CSP and no third-party scripts. The trade-off was made for persistent sign-in in the desktop widget.
4. **Rate limits are in memory** per instance. That's fine for a single free instance, but needs a shared store if
   TaskSync ever runs more than one.
5. **Supabase TLS verification** needs `DATABASE_CA_CERT`. `DATABASE_SSL=no-verify` is only a temporary fallback.
6. **Desktop binary.** Omnifi's Defender ASR rule blocks the unsigned native app. Use the Edge app (no installer)
   unless IT trusts or signs `TaskSync.exe`; see DEPLOYMENT_GUIDE §6. Never work around the rule.
9. **No-admin sign-in mode** (`ENTRA_TOKEN_MODE=id`) uses ID tokens as API credentials. They're bound to this
   app's client ID and tenant and validated in full, but they're bearer tokens like any other, so a stolen token works
   until it expires (≈1 h). Switch to access-token mode if an admin ever exposes the API.
10. **Shadow IT.** Supabase, Render and the GitHub repo are set up without IT review. Keep task text free of client
    confidential data, use accounts that more than one person can recover, and tell IT when the tool grows.
7. **Data retention.** Realtime events are pruned after 72 h. Tasks, activity, notifications and the audit log are
   kept indefinitely. Agree a retention policy with Omnifi before the database approaches the 500 MB free limit.
8. Screen-capture exclusion stops screen sharing and screenshots on the same PC. It can't stop someone
   photographing the monitor.
