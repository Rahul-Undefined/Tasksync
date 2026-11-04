// Shared helpers for the end-to-end suites: start an isolated TaskSync server
// (development sign-in, in-memory PostgreSQL via PGlite) on a free port.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DOMAIN = 'myomnifi.com';
export const ADMIN = { email: `dev.admin@${DOMAIN}`, name: 'Dev Admin' };

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startServer({ port: fixedPort } = {}) {
  const port = fixedPort ?? (await freePort());
  const child = spawn(process.execPath, ['server/dist/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DEV_AUTH: 'true',
      AUTO_APPROVE_EMPLOYEES: 'false', // the suite exercises the approval flow
      PGLITE_DATA_DIR: 'memory',
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      BOOTSTRAP_ADMIN_EMAILS: ADMIN.email,
      DATABASE_URL: '',
      ENTRA_TENANT_ID: '',
      ENTRA_CLIENT_ID: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (child.exitCode !== null) throw new Error(`server exited:\n${output}`);
    await sleep(200);
  }
  return {
    base,
    port,
    output: () => output,
    async stop() {
      child.kill();
      await sleep(300);
    },
  };
}

/** Small API client for setting up state quickly (sign-in uses the dev token endpoint). */
export function apiClient(base) {
  const tokens = new Map();
  async function token(person) {
    if (!tokens.has(person.email)) {
      const res = await fetch(`${base}/api/dev/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(person),
      });
      tokens.set(person.email, (await res.json()).accessToken);
    }
    return tokens.get(person.email);
  }
  async function call(person, method, url, body) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { authorization: `Bearer ${await token(person)}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(json)}`);
    return json;
  }
  return {
    token,
    call,
    async me(person) {
      return (await call(person, 'GET', '/api/me')).user;
    },
    /** Registers the person (first sign-in) and approves them as the bootstrap admin. */
    async onboard(person) {
      const me = await call(person, 'GET', '/api/me');
      if (me.user.status !== 'approved') await call(ADMIN, 'POST', `/api/admin/users/${me.user.id}/approve`, {});
      return me.user;
    },
  };
}

/** Signs a browser page in through the real UI by choosing a dev persona. */
export async function signInViaUi(page, base, name) {
  await page.goto(`${base}/`);
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await page.waitForSelector('.app, .widget', { timeout: 15000 });
}
