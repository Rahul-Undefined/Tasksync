import { createHash, randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTVerifyGetKey } from 'jose';

/**
 * Local development sign-in. It mints tokens that look exactly like Entra ID v2 access
 * tokens but are signed by a key generated in memory at startup, so they go through the
 * same verifier as production tokens. Only available when DEV_AUTH=true and never in
 * production (enforced in config.ts and app.ts).
 */
export interface DevAuth {
  tenantId: string;
  clientId: string;
  keyId: string;
  keySet: JWTVerifyGetKey;
  mint(input: DevTokenInput): Promise<string>;
}

export interface DevTokenInput {
  email: string;
  name: string;
  tenantId?: string;
  scope?: string;
  extraClaims?: Record<string, unknown>;
  expiresInSeconds?: number;
}

export const DEV_TENANT_ID = '00000000-0000-4000-8000-00000000d0e1';
export const DEV_CLIENT_ID = '00000000-0000-4000-8000-00000000c11e';

/** Deterministic object id so a dev persona keeps the same identity across restarts. */
export function devObjectId(email: string): string {
  const h = createHash('sha256').update(`tasksync-dev:${email.toLowerCase()}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function createDevAuth(opts: { tenantId?: string; clientId?: string; scope: string }): Promise<DevAuth> {
  const tenantId = opts.tenantId ?? DEV_TENANT_ID;
  const clientId = opts.clientId ?? DEV_CLIENT_ID;
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const keyId = `dev-${randomUUID()}`;
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: keyId, alg: 'RS256', use: 'sig' };
  const keySet = createLocalJWKSet({ keys: [jwk] });

  return {
    tenantId,
    clientId,
    keyId,
    keySet,
    async mint(input) {
      const tid = input.tenantId ?? tenantId;
      return new SignJWT({
        tid,
        oid: devObjectId(input.email),
        preferred_username: input.email,
        name: input.name,
        scp: input.scope ?? opts.scope,
        ver: '2.0',
        ...input.extraClaims,
      })
        .setProtectedHeader({ alg: 'RS256', kid: keyId, typ: 'JWT' })
        .setIssuer(`https://login.microsoftonline.com/${tid}/v2.0`)
        .setAudience(clientId)
        .setIssuedAt()
        .setExpirationTime(`${input.expiresInSeconds ?? 8 * 3600}s`)
        .sign(privateKey);
    },
  };
}
