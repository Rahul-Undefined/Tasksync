import { MSA_CONSUMER_TENANT } from './verify.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Finds the Microsoft Entra tenant ID for a company email domain from Microsoft's public
 * OpenID metadata (https://login.microsoftonline.com/<domain>/v2.0/.well-known/openid-configuration),
 * so ENTRA_TENANT_ID doesn't have to be configured by hand. Returns null if the domain
 * isn't a work/school (Entra) tenant.
 */
export async function discoverTenantId(
  domain: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<string | null> {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return null;
  const res = await fetchImpl(
    `https://login.microsoftonline.com/${encodeURIComponent(domain)}/v2.0/.well-known/openid-configuration`,
    { signal: AbortSignal.timeout(timeoutMs) },
  );
  if (!res.ok) return null;
  const meta = (await res.json()) as { issuer?: unknown };
  const match = typeof meta.issuer === 'string' ? /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0$/.exec(meta.issuer) : null;
  const tid = match?.[1]?.toLowerCase();
  if (!tid || !GUID.test(tid) || tid === MSA_CONSUMER_TENANT) return null;
  return tid;
}
