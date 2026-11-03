import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, CLIENT, createTestEnv, DOMAIN, MSA_TENANT, OTHER_TENANT, TENANT, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

describe('Microsoft sign-in validation', () => {
  it('[T1] accepts an approved company account and returns its profile', async () => {
    const admin = await env.admin();
    const res = await env.req('GET', '/api/me', admin.token);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: ADMIN_EMAIL, role: 'admin', status: 'approved' });
    const tasks = await env.req('GET', '/api/tasks?view=my', admin.token);
    expect(tasks.status).toBe(200);
  });

  it('[T2] rejects a personal Microsoft account (consumer tenant)', async () => {
    const token = await env.mint('someone@outlook.com', { tid: MSA_TENANT });
    const res = await env.req('GET', '/api/me', token);
    expect(res.status).toBe(403);
    expect(['wrong_tenant', 'personal_account']).toContain(res.body.error.code);
  });

  it('[T2] rejects a personal account signed in as a guest of our tenant', async () => {
    const token = await env.mint(`guest@${DOMAIN}`, { idp: 'live.com' });
    const res = await env.req('GET', '/api/me', token);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('external_account');
  });

  it('[T3] rejects a token from an external tenant', async () => {
    const token = await env.mint(`spy@${DOMAIN}`, { tid: OTHER_TENANT });
    const res = await env.req('GET', '/api/me', token);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('wrong_tenant');
  });

  it('[T3] rejects a token whose issuer is our tenant but tid claim is not', async () => {
    const token = await env.mint(`spy@${DOMAIN}`, { tid: OTHER_TENANT }, { iss: `https://login.microsoftonline.com/${TENANT}/v2.0` });
    const res = await env.req('GET', '/api/me', token);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('wrong_tenant');
  });

  it('[T3] rejects guest accounts (acct=1 and #EXT# UPNs)', async () => {
    const a = await env.req('GET', '/api/me', await env.mint(`g1@${DOMAIN}`, { acct: 1 }));
    expect(a.body.error.code).toBe('guest_account');
    const b = await env.req(
      'GET',
      '/api/me',
      await env.mint(`g2@${DOMAIN}`, { preferred_username: `g2_gmail.com#EXT#@${DOMAIN}` }),
    );
    expect(b.status).toBe(403);
  });

  it('rejects other email domains, including look-alike domains', async () => {
    for (const email of ['x@gmail.com', `x@evil${DOMAIN}`, `x@${DOMAIN}.evil.com`, `x@sub.${DOMAIN}`]) {
      const res = await env.req('GET', '/api/me', await env.mint(email));
      expect(res.status, email).toBe(403);
      expect(res.body.error.code).toBe('domain_not_allowed');
    }
  });

  it('rejects forged, expired, wrong-audience and scope-less tokens', async () => {
    const forged = await env.mint(`f@${DOMAIN}`, {}, { key: 'rogue' });
    expect((await env.req('GET', '/api/me', forged)).status).toBe(401);

    const expired = await env.mint(`e@${DOMAIN}`, {}, { exp: '-10m' });
    const exp = await env.req('GET', '/api/me', expired);
    expect(exp.status).toBe(401);
    expect(exp.body.error.code).toBe('token_expired');

    const otherApi = await env.mint(`a@${DOMAIN}`, {}, { aud: 'https://graph.microsoft.com' });
    expect((await env.req('GET', '/api/me', otherApi)).status).toBe(401);

    // App-only access token: no scp, carries azp (the calling app) and roles.
    const noScope = await env.mint(`s@${DOMAIN}`, { scp: undefined, roles: ['Something'], azp: '99999999-9999-4999-8999-999999999999' });
    const ns = await env.req('GET', '/api/me', noScope);
    expect(ns.status).toBe(403);
    expect(ns.body.error.code).toBe('insufficient_scope');

    const unsigned =
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') +
      '.' +
      Buffer.from(JSON.stringify({ tid: TENANT, oid: '1', preferred_username: `n@${DOMAIN}` })).toString('base64url') +
      '.';
    expect((await env.req('GET', '/api/me', unsigned)).status).toBe(401);
  });

  it('rejects requests without a token, and never serves task data anonymously', async () => {
    expect((await env.req('GET', '/api/me')).status).toBe(401);
    expect((await env.req('GET', '/api/tasks')).status).toBe(401);
    expect((await env.req('POST', '/api/tasks', undefined, { title: 'x' })).status).toBe(401);
    expect((await env.req('GET', '/api/users')).status).toBe(401);
  });
});

describe('Employee onboarding and admin approval', () => {
  it('[T4] registers an unknown employee as pending and blocks all task access', async () => {
    const pending = await env.user('Pat Pending', { approve: false });
    const me = await env.req('GET', '/api/me', pending.token);
    expect(me.status).toBe(200);
    expect(me.body.user.status).toBe('pending');
    for (const [method, url] of [
      ['GET', '/api/tasks'],
      ['GET', '/api/users'],
      ['GET', '/api/activity'],
      ['GET', '/api/notifications'],
    ] as const) {
      const res = await env.req(method, url, pending.token);
      expect(res.status, url).toBe(403);
      expect(res.body.error.code).toBe('account_pending');
    }
    const create = await env.req('POST', '/api/tasks', pending.token, { title: 'Sneaky', assignToSelf: true });
    expect(create.status).toBe(403);
  });

  it('[T5] admin sees pending users, approves one, and access works immediately', async () => {
    const admin = await env.admin();
    const p = await env.user('Quinn Newcomer', { approve: false });
    const list = await env.req('GET', '/api/admin/users?status=pending', admin.token);
    expect(list.status).toBe(200);
    expect(list.body.users.map((u: { id: string }) => u.id)).toContain(p.id);

    // admin was notified of the request
    const notes = await env.req('GET', '/api/notifications', admin.token);
    expect(notes.body.notifications.some((n: { title: string }) => n.title.includes('Quinn Newcomer'))).toBe(true);

    const ok = await env.req('POST', `/api/admin/users/${p.id}/approve`, admin.token, {});
    expect(ok.status).toBe(200);
    expect(ok.body.user.status).toBe('approved');
    expect((await env.req('GET', '/api/tasks', p.token)).status).toBe(200);

    const history = await env.req('GET', `/api/admin/users/${p.id}/history`, admin.token);
    expect(history.body.history.map((h: { action: string }) => h.action)).toEqual(['approved', 'requested']);
  });

  it('[T5] admin can reject, deactivate and reactivate; access is revoked at once', async () => {
    const admin = await env.admin();
    const r = await env.user('Riley Rejected', { approve: false });
    const rej = await env.req('POST', `/api/admin/users/${r.id}/reject`, admin.token, { reason: 'Contractor' });
    expect(rej.body.user.status).toBe('rejected');
    expect((await env.req('GET', '/api/tasks', r.token)).body.error.code).toBe('account_rejected');

    const d = await env.user('Dana Leaver');
    expect((await env.req('GET', '/api/tasks', d.token)).status).toBe(200);
    await env.req('POST', `/api/admin/users/${d.id}/deactivate`, admin.token, { reason: 'Left the company' });
    const blocked = await env.req('GET', '/api/tasks', d.token);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('account_deactivated');
    await env.req('POST', `/api/admin/users/${d.id}/reactivate`, admin.token, {});
    expect((await env.req('GET', '/api/tasks', d.token)).status).toBe(200);
  });

  it('only admins can use admin endpoints; roles cannot be self-assigned', async () => {
    const emp = await env.user('Eli Employee');
    expect((await env.req('GET', '/api/admin/users', emp.token)).status).toBe(403);
    const self = await env.req('POST', `/api/admin/users/${emp.id}/role`, emp.token, { role: 'admin' });
    expect(self.status).toBe(403);
    expect((await env.req('POST', `/api/admin/users/${emp.id}/approve`, emp.token, {})).status).toBe(403);
    // a role claim in the token or body does not grant admin
    const sneaky = await env.mint(emp.email, { name: emp.name, roles: ['admin'], role: 'admin' });
    expect((await env.req('GET', '/api/admin/users', sneaky)).status).toBe(403);
  });

  it('admin can promote/demote but the last admin cannot be removed', async () => {
    const admin = await env.admin();
    const demoteSelf = await env.req('POST', `/api/admin/users/${admin.id}/role`, admin.token, { role: 'employee' });
    expect(demoteSelf.status).toBe(409);
    expect(demoteSelf.body.error.code).toBe('last_admin');
    expect((await env.req('POST', `/api/admin/users/${admin.id}/deactivate`, admin.token, {})).status).toBe(403);

    const promoted = await env.user('Mo Promoted');
    const res = await env.req('POST', `/api/admin/users/${promoted.id}/role`, admin.token, { role: 'admin' });
    expect(res.body.user.role).toBe('admin');
    expect((await env.req('GET', '/api/admin/users', promoted.token)).status).toBe(200);
    await env.req('POST', `/api/admin/users/${promoted.id}/role`, admin.token, { role: 'employee' });
    expect((await env.req('GET', '/api/admin/users', promoted.token)).status).toBe(403);
  });

  it('records admin actions and denied sign-ins in the audit log', async () => {
    const admin = await env.admin();
    const audit = await env.req('GET', '/api/admin/audit', admin.token);
    const actions = audit.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['admin.user.approve', 'admin.user.reject', 'admin.user.deactivate', 'auth.denied']));
  });
});

describe('Sign-in without admin consent (Entra ID tokens)', () => {
  // An ID token as Entra issues it to the TaskSync SPA: aud = client id, v2 issuer, no scp/azp.
  const idToken = (email: string, claims: Record<string, unknown> = {}, opts = {}) =>
    env.mint(email, { scp: undefined, nonce: 'n-123', ...claims }, opts);

  it('accepts a v2 ID token issued to this app and applies the same tenant/domain/approval rules', async () => {
    const ok = await env.req('GET', '/api/me', await idToken(`id.user@${DOMAIN}`, { name: 'Ida Token' }));
    expect(ok.status).toBe(200);
    expect(ok.body.user.status).toBe('pending');
    // still blocked from data until approved
    expect((await env.req('GET', '/api/tasks', await idToken(`id.user@${DOMAIN}`))).status).toBe(403);
    // wrong domain, other tenant and guests are still rejected
    expect((await env.req('GET', '/api/me', await idToken('x@gmail.com'))).status).toBe(403);
    expect((await env.req('GET', '/api/me', await idToken(`y@${DOMAIN}`, { tid: OTHER_TENANT }))).status).toBe(403);
    expect((await env.req('GET', '/api/me', await idToken(`z@${DOMAIN}`, { acct: 1 }))).status).toBe(403);
  });

  it('rejects ID tokens for other apps, v1 issuers, app-only tokens and api:// audiences without a scope', async () => {
    expect((await env.req('GET', '/api/me', await idToken(`a@${DOMAIN}`, {}, { aud: '12345678-1234-4234-8234-123456789012' }))).status).toBe(401);
    const v1 = await idToken(`b@${DOMAIN}`, {}, { iss: `https://sts.windows.net/${TENANT}/` });
    expect((await env.req('GET', '/api/me', v1)).status).toBe(403);
    expect((await env.req('GET', '/api/me', await idToken(`c@${DOMAIN}`, { appid: '99999999-9999-4999-8999-999999999999' }))).status).toBe(403);
    expect((await env.req('GET', '/api/me', await idToken(`d@${DOMAIN}`, { idtyp: 'app' }))).status).toBe(403);
    expect((await env.req('GET', '/api/me', await idToken(`e@${DOMAIN}`, {}, { aud: `api://${CLIENT}` }))).status).toBe(403);
  });

  it('can be switched off (ENTRA_TOKEN_MODE=access) so only API access tokens work', async () => {
    const strict = await createTestEnv({ ENTRA_TOKEN_MODE: 'access' });
    try {
      const id = await strict.mint(`f@${DOMAIN}`, { scp: undefined });
      expect((await strict.req('GET', '/api/me', id)).status).toBe(403);
      expect((await strict.req('GET', '/api/me', await strict.mint(`g@${DOMAIN}`))).status).toBe(200);
      const cfg = (await strict.req('GET', '/api/config')).body;
      expect(cfg.entra.scopes).toEqual([`api://${CLIENT}/access_as_user`]);
    } finally {
      await strict.close();
    }
  });

  it('tells the web app to sign in with basic scopes only by default', async () => {
    const cfg = (await env.req('GET', '/api/config')).body;
    expect(cfg.entra).toMatchObject({ tokenType: 'id', scopes: ['openid', 'profile', 'email'], clientId: CLIENT, tenantId: TENANT });
  });
});

describe('Optional Entra app-role requirement', () => {
  it('rejects users without the required app role', async () => {
    const strict = await createTestEnv({ ENTRA_REQUIRED_ROLE: 'TaskSync.User' });
    try {
      const without = await strict.req('GET', '/api/me', await strict.mint(`norole@${DOMAIN}`));
      expect(without.status).toBe(403);
      expect(without.body.error.code).toBe('not_assigned');
      const withRole = await strict.req('GET', '/api/me', await strict.mint(`role@${DOMAIN}`, { roles: ['TaskSync.User'] }));
      expect(withRole.status).toBe(200);
    } finally {
      await strict.close();
    }
  });
});
