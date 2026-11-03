import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
} from '@azure/msal-browser';
import { api } from './api';
import { isDesktop } from './desktop';

export interface ClientConfig {
  authMode: 'entra' | 'dev' | 'not_configured';
  entra: { tenantId: string; clientId: string; authority: string; scopes: string[] } | null;
  allowedDomains: string[];
  databaseConfigured: boolean;
  version: string;
}

export interface AuthClient {
  mode: 'entra' | 'dev';
  /** Display info for the signed-in account (null when signed out). */
  account: { name: string; email: string } | null;
  signIn(opts?: { email?: string; name?: string }): Promise<void>;
  signOut(): Promise<void>;
  getToken(opts?: { forceRefresh?: boolean }): Promise<string>;
}

// ---------------------------------------------------------------------------
// Microsoft Entra ID (production)
// ---------------------------------------------------------------------------

export async function createEntraAuth(cfg: NonNullable<ClientConfig['entra']>, allowedDomains: string[]): Promise<AuthClient> {
  const pca = new PublicClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: cfg.authority, // single tenant: only this organisation's accounts can sign in
      redirectUri: `${window.location.origin}/`,
      postLogoutRedirectUri: `${window.location.origin}/`,
    },
    // localStorage keeps employees signed in across restarts (desktop widget and browser)
    // until they sign out or the refresh session expires. A strict CSP mitigates XSS risk.
    cache: { cacheLocation: 'localStorage' },
  });
  await pca.initialize();
  const result = await pca.handleRedirectPromise().catch((err) => {
    console.warn('Sign-in redirect failed', err);
    return null;
  });
  let account: AccountInfo | null = result?.account ?? pca.getActiveAccount() ?? pca.getAllAccounts()[0] ?? null;
  if (account) pca.setActiveAccount(account);
  if (result?.state && result.state.startsWith('/') && !result.state.startsWith('//')) {
    window.history.replaceState(null, '', result.state);
  }

  const request = () => ({ scopes: cfg.scopes, account: account ?? undefined });

  return {
    mode: 'entra',
    get account() {
      return account ? { name: account.name ?? account.username, email: account.username } : null;
    },
    async signIn() {
      await pca.loginRedirect({
        scopes: cfg.scopes,
        prompt: 'select_account',
        domainHint: allowedDomains[0],
        state: window.location.pathname + window.location.search,
      });
    },
    async signOut() {
      const a = account;
      account = null;
      await pca.logoutRedirect({ account: a ?? undefined });
    },
    async getToken(opts) {
      if (!account) throw new Error('Not signed in');
      try {
        const res = await pca.acquireTokenSilent({ ...request(), forceRefresh: opts?.forceRefresh ?? false });
        return res.accessToken;
      } catch (err) {
        if (err instanceof InteractionRequiredAuthError) {
          await pca.acquireTokenRedirect({ ...request(), state: window.location.pathname });
          return new Promise<string>(() => undefined); // page is navigating away
        }
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Local development sign-in (only offered when the API runs with DEV_AUTH=true)
// ---------------------------------------------------------------------------

// Per-tab (sessionStorage) in browsers so several test identities can be open side by side;
// persistent in the desktop app, mirroring how MSAL keeps employees signed in there.
const DEV_KEY = 'tasksync.devSession';
const devStore = (): Storage => (isDesktop ? localStorage : sessionStorage);

export function createDevAuth(): AuthClient {
  type Session = { token: string; name: string; email: string; exp: number };
  const load = (): Session | null => {
    try {
      const s = JSON.parse(devStore().getItem(DEV_KEY) ?? 'null') as Session | null;
      return s && s.exp > Date.now() ? s : null;
    } catch {
      return null;
    }
  };
  let session = load();
  return {
    mode: 'dev',
    get account() {
      return session ? { name: session.name, email: session.email } : null;
    },
    async signIn(opts) {
      if (!opts?.email || !opts.name) throw new Error('Choose a test identity');
      const res = await api<{ accessToken: string; expiresInSeconds: number }>('/api/dev/token', {
        method: 'POST',
        body: { email: opts.email, name: opts.name },
        auth: false,
      });
      session = { token: res.accessToken, name: opts.name, email: opts.email, exp: Date.now() + res.expiresInSeconds * 1000 - 60_000 };
      try {
        devStore().setItem(DEV_KEY, JSON.stringify(session));
      } catch {
        // storage unavailable: session lasts for this tab only
      }
    },
    async signOut() {
      session = null;
      try {
        devStore().removeItem(DEV_KEY);
      } catch {
        // ignore
      }
    },
    async getToken() {
      if (!session || session.exp < Date.now()) throw new Error('Session expired. Sign in again.');
      return session.token;
    },
  };
}
