// Thin fetch wrapper: attaches the access token, normalises errors, and rides out
// Render free-tier cold starts (the API can take ~1 minute to wake up).

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export type TokenProvider = (opts?: { forceRefresh?: boolean }) => Promise<string>;

let tokenProvider: TokenProvider | null = null;
const wakeListeners = new Set<(waking: boolean) => void>();

export function setTokenProvider(p: TokenProvider | null) {
  tokenProvider = p;
}

/** Notified while the API is unreachable and requests are being retried. */
export function onServerWaking(fn: (waking: boolean) => void) {
  wakeListeners.add(fn);
  return () => {
    wakeListeners.delete(fn);
  };
}
const setWaking = (w: boolean) => wakeListeners.forEach((fn) => fn(w));

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Retry on network errors / 502-504 (safe for GET and idempotent writes). */
  retry?: boolean;
  auth?: boolean;
  signal?: AbortSignal;
}

const RETRYABLE = new Set([502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const retry = opts.retry ?? method === 'GET';
  const deadline = Date.now() + 120_000;
  let attempt = 0;
  let refreshed = false;

  for (;;) {
    attempt++;
    const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth !== false && tokenProvider) {
      headers.authorization = `Bearer ${await tokenProvider({ forceRefresh: refreshed })}`;
    }
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
        cache: 'no-store',
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      // Offline: fail fast so writes go to the offline outbox. Network errors while
      // online usually mean a cold-starting server, which is worth waiting for.
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (retry && !offline && Date.now() < deadline) {
        setWaking(true);
        await sleep(Math.min(1000 * 2 ** Math.min(attempt, 4), 10_000));
        continue;
      }
      setWaking(false);
      throw new ApiError(0, 'network_error', navigator.onLine ? 'Cannot reach TaskSync. Check your connection.' : 'You are offline.');
    }

    // Render's proxy answers with an HTML "waking up" page or 502/503 during a cold start.
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    if ((RETRYABLE.has(res.status) || (!isJson && path.startsWith('/api/') && res.ok)) && retry && Date.now() < deadline) {
      const body = isJson ? await res.clone().json().catch(() => null) : null;
      // 503 "not_configured" from our own API is permanent, not a cold start; "storage_loading"
      // and "storage_unavailable" clear up by themselves once the server has its data.
      const transient = ['internal_error', 'storage_loading', 'storage_unavailable'];
      if (!body?.error?.code || transient.includes(body.error.code)) {
        setWaking(true);
        await sleep(Math.min(1500 * attempt, 8000));
        continue;
      }
    }
    setWaking(false);

    if (res.status === 401 && !refreshed && tokenProvider && opts.auth !== false) {
      refreshed = true; // token may have just expired: get a fresh one once
      continue;
    }
    if (res.status === 204) return undefined as T;
    const data = isJson ? await res.json().catch(() => null) : null;
    if (!res.ok) {
      const e = data?.error ?? {};
      throw new ApiError(res.status, e.code ?? 'http_error', e.message ?? `Request failed (${res.status})`, e.details);
    }
    return data as T;
  }
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const post = <T>(path: string, body?: unknown, extra: Partial<RequestOptions> = {}) =>
  api<T>(path, { method: 'POST', body: body ?? {}, ...extra });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
