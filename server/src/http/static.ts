import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serves the built web dashboard and falls back to index.html for client-side routes.
 * Paths are resolved inside the dist directory only; anything else is a 404.
 */
export function registerStatic(app: FastifyInstance, distDir: string): boolean {
  const root = path.resolve(distDir);
  const index = path.join(root, 'index.html');
  if (!existsSync(index)) return false;

  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? '/';
    if ((req.method !== 'GET' && req.method !== 'HEAD') || url.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.split('?')[0]!.split('#')[0]!);
    } catch {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'Bad path' } });
    }
    if (pathname.includes('\0')) return reply.code(400).send({ error: { code: 'bad_request', message: 'Bad path' } });

    const candidate = path.resolve(root, `.${path.posix.normalize(`/${pathname}`)}`);
    const inside = candidate === root || candidate.startsWith(root + path.sep);
    let file = index;
    if (inside && candidate !== root) {
      try {
        if (statSync(candidate).isFile()) file = candidate;
      } catch {
        // not a file: fall through to the SPA shell unless it looks like an asset
        if (path.extname(pathname)) {
          return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
        }
      }
    }
    const ext = path.extname(file).toLowerCase();
    reply.type(TYPES[ext] ?? 'application/octet-stream');
    reply.header(
      'cache-control',
      file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    );
    return reply.send(createReadStream(file));
  });
  return true;
}
