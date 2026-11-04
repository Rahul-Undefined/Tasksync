import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context.js';

/** The file the release workflow attaches to each "desktop-vX.Y.Z" GitHub release. */
export const DESKTOP_ASSET = 'TaskSync-win-x64.zip';
const TAG_PREFIX = 'desktop-v';
const CACHE_MS = 10 * 60 * 1000;

export interface DesktopRelease {
  version: string;
  url: string;
  sha256: string;
  size: number;
  publishedAt: string | null;
  notes: string;
}

interface GitHubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  body?: string | null;
  assets?: { name?: string; browser_download_url?: string; size?: number; digest?: string | null }[];
}

const versionOf = (tag: string) => (/^desktop-v(\d+\.\d+\.\d+)$/.exec(tag) ?? [])[1];

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Newest published desktop release with a verifiable (SHA-256) Windows build, or null. */
export function pickDesktopRelease(releases: GitHubRelease[], repo: string): DesktopRelease | null {
  let best: DesktopRelease | null = null;
  for (const r of releases) {
    if (r.draft || r.prerelease || !r.tag_name?.startsWith(TAG_PREFIX)) continue;
    const version = versionOf(r.tag_name);
    const asset = r.assets?.find((a) => a.name === DESKTOP_ASSET);
    const sha256 = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest ?? '')?.[1]?.toLowerCase();
    const url = asset?.browser_download_url ?? '';
    // Only GitHub's own download address for this repository's release is ever handed to the app.
    if (!version || !sha256 || !url.startsWith(`https://github.com/${repo}/releases/download/`)) continue;
    if (best && compareVersions(version, best.version) <= 0) continue;
    best = { version, url, sha256, size: asset?.size ?? 0, publishedAt: r.published_at ?? null, notes: (r.body ?? '').slice(0, 2000) };
  }
  return best;
}

/**
 * GET /api/desktop/latest — what the Windows app's updater checks. Public information only
 * (the same as the repository's public releases page), cached so GitHub's rate limit is never hit.
 */
export async function desktopRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { repo, apiUrl } = ctx.config.desktopReleases;
  let cache: { at: number; value: DesktopRelease | null } | null = null;

  const load = async (): Promise<DesktopRelease | null> => {
    if (!repo) return null;
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    try {
      const res = await fetch(`${apiUrl}/repos/${repo}/releases?per_page=20`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'TaskSync-server', 'x-github-api-version': '2022-11-28' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const value = pickDesktopRelease((await res.json()) as GitHubRelease[], repo);
      cache = { at: Date.now(), value };
      return value;
    } catch (err) {
      app.log.warn({ err }, 'Could not check desktop releases');
      return cache?.value ?? null; // keep serving the last good answer
    }
  };

  app.get('/api/desktop/latest', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    const latest = await load();
    if (!latest) {
      reply.code(404);
      return { error: { code: 'no_release', message: 'No Windows app release has been published yet.' } };
    }
    return latest;
  });
}
