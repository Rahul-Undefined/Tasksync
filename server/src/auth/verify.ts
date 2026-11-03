import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { ApiError } from '../lib/errors.js';

/** Tenant id Microsoft uses for all personal (MSA) accounts. */
export const MSA_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VerifiedIdentity {
  oid: string;
  tid: string;
  email: string;
  name: string;
  roles: string[];
  scopes: string[];
  expiresAt: number;
}

export interface TokenVerifierOptions {
  tenantId: string;
  clientId: string;
  scope: string;
  allowedEmailDomains: string[];
  allowGuests?: boolean;
  requiredRole?: string;
  /** Override the signing keys (tests and local development sign-in). */
  keySet?: JWTVerifyGetKey;
}

export type TokenVerifier = (token: string) => Promise<VerifiedIdentity>;

export class AuthError extends ApiError {
  constructor(code: string, message: string, status = 401) {
    super(status, code, message);
    this.name = 'AuthError';
  }
}

export function emailDomainAllowed(email: string, domains: string[]): boolean {
  const at = email.lastIndexOf('@');
  if (at < 1 || at !== email.indexOf('@')) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return domains.some((d) => domain === d.toLowerCase());
}

/**
 * Validates a Microsoft Entra ID access token issued for the TaskSync API.
 *
 * Checks, in order: signature (tenant JWKS), algorithm, expiry, issuer (exact tenant),
 * audience (this API), tenant id claim, personal/guest/external accounts, delegated
 * scope, optional app role, user object id, and the organisation email domain.
 * The email domain is only one layer; the tenant id and signature are what make
 * the identity trustworthy.
 */
export function createTokenVerifier(opts: TokenVerifierOptions): TokenVerifier {
  const tenantId = opts.tenantId.toLowerCase();
  const clientId = opts.clientId.toLowerCase();
  const keySet =
    opts.keySet ??
    createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`), {
      cooldownDuration: 30_000,
      cacheMaxAge: 6 * 60 * 60 * 1000,
    });
  const issuers = [`https://login.microsoftonline.com/${tenantId}/v2.0`, `https://sts.windows.net/${tenantId}/`];
  const audiences = [clientId, `api://${clientId}`];

  return async (token: string) => {
    if (!token || token.length > 16_384) throw new AuthError('invalid_token', 'Missing or malformed access token');

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keySet, {
        issuer: issuers,
        audience: audiences,
        algorithms: ['RS256'],
        clockTolerance: 60,
        requiredClaims: ['exp', 'iat', 'tid', 'oid'],
      }));
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw new AuthError('token_expired', 'Your session has expired');
      if (err instanceof joseErrors.JWTClaimValidationFailed && err.claim === 'iss') {
        throw new AuthError('wrong_tenant', 'This account does not belong to the Omnifi organisation', 403);
      }
      throw new AuthError('invalid_token', 'Access token validation failed');
    }

    const claims = payload as JWTPayload & Record<string, unknown>;
    const tid = String(claims.tid ?? '').toLowerCase();
    if (tid === MSA_CONSUMER_TENANT) {
      throw new AuthError('personal_account', 'Personal Microsoft accounts cannot use TaskSync', 403);
    }
    if (tid !== tenantId) {
      throw new AuthError('wrong_tenant', 'This account does not belong to the Omnifi organisation', 403);
    }

    if (!opts.allowGuests) {
      // acct: 0 = member, 1 = guest (optional claim). idp is present when the user
      // authenticated with an identity provider other than this tenant (B2B guests, MSA guests).
      if (claims.acct === 1 || claims.acct === '1') {
        throw new AuthError('guest_account', 'Guest accounts cannot use TaskSync', 403);
      }
      const idp = typeof claims.idp === 'string' ? claims.idp.toLowerCase() : undefined;
      if (idp && !issuers.some((iss) => iss.toLowerCase() === idp)) {
        throw new AuthError('external_account', 'External or personal identities cannot use TaskSync', 403);
      }
    }

    const scopes = typeof claims.scp === 'string' ? claims.scp.split(' ').filter(Boolean) : [];
    if (!scopes.includes(opts.scope)) {
      // App-only tokens (no scp) or tokens for other APIs are rejected.
      throw new AuthError('insufficient_scope', 'Token is not valid for TaskSync', 403);
    }

    const roles = Array.isArray(claims.roles) ? claims.roles.map(String) : [];
    if (opts.requiredRole && !roles.includes(opts.requiredRole)) {
      throw new AuthError('not_assigned', 'Your account has not been granted access to TaskSync', 403);
    }

    const oid = String(claims.oid ?? '').toLowerCase();
    if (!GUID.test(oid)) throw new AuthError('invalid_token', 'Token has no user object id');

    const email = String(claims.preferred_username ?? claims.upn ?? claims.email ?? '')
      .trim()
      .toLowerCase();
    if (email.includes('#ext#')) {
      throw new AuthError('guest_account', 'Guest accounts cannot use TaskSync', 403);
    }
    if (!emailDomainAllowed(email, opts.allowedEmailDomains)) {
      throw new AuthError('domain_not_allowed', 'Only Omnifi company accounts can use TaskSync', 403);
    }

    const name = String(claims.name ?? '').trim() || email.split('@')[0] || email;
    return {
      oid,
      tid,
      email,
      name: name.slice(0, 200),
      roles,
      scopes,
      expiresAt: typeof claims.exp === 'number' ? claims.exp * 1000 : Date.now() + 5 * 60_000,
    };
  };
}
