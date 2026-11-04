import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DESKTOP_ASSET, pickDesktopRelease } from '../src/routes/desktop.js';
import { createTestEnv, type TestEnv } from './helpers.js';

const REPO = 'acme/tasksync';
const sha = (c: string) => c.repeat(64);
const release = (tag: string, extra: Record<string, unknown> = {}, asset: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  published_at: '2026-11-01T10:00:00Z',
  body: `Release ${tag}`,
  assets: [
    {
      name: DESKTOP_ASSET,
      size: 1234,
      digest: `sha256:${sha('a')}`,
      browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/${DESKTOP_ASSET}`,
      ...asset,
    },
  ],
  ...extra,
});

describe('[T21] Windows app updates', () => {
  it('picks the newest published desktop release that has a verifiable download', () => {
    const picked = pickDesktopRelease(
      [
        release('desktop-v0.2.0'),
        release('desktop-v0.10.0', { draft: true }), // drafts are never offered
        release('desktop-v0.9.0', { prerelease: true }),
        release('desktop-v0.3.0', {}, { digest: null }), // no checksum: can't be verified
        release('desktop-v0.4.0', {}, { browser_download_url: 'https://evil.example/TaskSync-win-x64.zip' }),
        release('v9.9.9'), // not a desktop tag
        release('desktop-v0.2.1', {}, { digest: `sha256:${sha('B')}` }),
      ],
      REPO,
    );
    expect(picked?.version).toBe('0.2.1');
    expect(picked?.sha256).toBe(sha('b'));
    expect(picked?.url).toBe(`https://github.com/${REPO}/releases/download/desktop-v0.2.1/${DESKTOP_ASSET}`);
    expect(pickDesktopRelease([], REPO)).toBeNull();
  });

  describe('GET /api/desktop/latest', () => {
    let env: TestEnv;
    let gh: http.Server;
    let calls = 0;
    beforeAll(async () => {
      gh = http.createServer((req, res) => {
        calls++;
        res.writeHead(req.url?.startsWith(`/repos/${REPO}/releases`) ? 200 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify([release('desktop-v1.2.3'), release('desktop-v1.0.0')]));
      });
      await new Promise<void>((r) => gh.listen(0, '127.0.0.1', r));
      const apiUrl = `http://127.0.0.1:${(gh.address() as AddressInfo).port}`;
      env = await createTestEnv({ DESKTOP_RELEASES_REPO: REPO, GITHUB_API_URL: apiUrl });
    });
    afterAll(async () => {
      await env?.close();
      await new Promise((r) => gh.close(r));
    });

    it('tells the app about the newest version without sign-in, and caches GitHub answers', async () => {
      const a = await env.req('GET', '/api/desktop/latest');
      expect(a.status).toBe(200);
      expect(a.body).toMatchObject({ version: '1.2.3', sha256: sha('a') });
      const b = await env.req('GET', '/api/desktop/latest');
      expect(b.body.version).toBe('1.2.3');
      expect(calls).toBe(1);
    });
  });

  it('answers 404 when no release repository is known', async () => {
    const env = await createTestEnv({});
    try {
      const res = await env.req('GET', '/api/desktop/latest');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('no_release');
    } finally {
      await env.close();
    }
  });
});
