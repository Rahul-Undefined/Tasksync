import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny in-memory imitation of the GitHub REST endpoints TaskSync's storage uses
 * (repo, git refs/commits/trees/blobs, contents). Mirrors GitHub's quirks that matter:
 * an empty repository answers 409 to ref lookups and Git Data writes.
 */
export interface FakeGitHub {
  apiUrl: string;
  repo: string;
  token: string;
  /** Number of write requests (POST/PUT/PATCH) received. */
  writes(): number;
  /** Make every request fail with this HTTP status (0 = behave normally). */
  failWith(status: number): void;
  commitCount(): number;
  files(): Record<string, string>;
  parentsOfHead(): string[];
  close(): Promise<void>;
}

export async function startFakeGitHub(repo = 'acme/tasksync-data', token = 'ghp_test_token'): Promise<FakeGitHub> {
  const blobs = new Map<string, string>();
  const trees = new Map<string, { path: string; mode: string; type: string; sha: string }[]>();
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  const refs = new Map<string, string>();
  let writes = 0;
  let failStatus = 0;
  const sha = (s: string) => createHash('sha1').update(s).digest('hex');

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (failStatus) return send(failStatus, { message: 'Simulated outage' });
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: 'Bad credentials' });
      const url = new URL(req.url ?? '/', 'http://x');
      const prefix = `/repos/${repo}`;
      if (!url.pathname.startsWith(prefix)) return send(404, { message: 'Not Found' });
      const path = url.pathname.slice(prefix.length);
      const body = raw ? JSON.parse(raw) : {};
      if (req.method !== 'GET') writes++;
      const empty = refs.size === 0;

      if (req.method === 'GET' && path === '') return send(200, { full_name: repo, private: true });
      let m: RegExpExecArray | null;
      if (req.method === 'GET' && (m = /^\/git\/ref\/heads\/(.+)$/.exec(path))) {
        if (empty) return send(409, { message: 'Git Repository is empty.' });
        const head = refs.get(decodeURIComponent(m[1]!));
        return head ? send(200, { object: { sha: head } }) : send(404, { message: 'Not Found' });
      }
      if (req.method === 'GET' && (m = /^\/git\/commits\/(\w+)$/.exec(path))) {
        const c = commits.get(m[1]!);
        return c ? send(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((p) => ({ sha: p })) }) : send(404, {});
      }
      if (req.method === 'GET' && (m = /^\/git\/trees\/(\w+)$/.exec(path))) {
        const t = trees.get(m[1]!);
        return t ? send(200, { sha: m[1], tree: t }) : send(404, {});
      }
      if (req.method === 'GET' && (m = /^\/git\/blobs\/(\w+)$/.exec(path))) {
        const b = blobs.get(m[1]!);
        return b !== undefined ? send(200, { content: b, encoding: 'base64' }) : send(404, {});
      }
      if (req.method === 'PUT' && path === '/contents/README.md') {
        const blob = sha(`blob:${body.content}`);
        blobs.set(blob, body.content);
        const tree = sha(`tree:${blob}`);
        trees.set(tree, [{ path: 'README.md', mode: '100644', type: 'blob', sha: blob }]);
        const commit = sha(`commit:${tree}:${Date.now()}:${Math.random()}`);
        commits.set(commit, { tree, parents: [], message: body.message });
        refs.set(body.branch ?? 'main', commit);
        return send(201, { commit: { sha: commit } });
      }
      if (empty && req.method === 'POST' && path.startsWith('/git/')) return send(409, { message: 'Git Repository is empty.' });
      if (req.method === 'POST' && path === '/git/blobs') {
        const b = sha(`blob:${body.content}`);
        blobs.set(b, body.content);
        return send(201, { sha: b });
      }
      if (req.method === 'POST' && path === '/git/trees') {
        const t = sha(`tree:${JSON.stringify(body.tree)}`);
        trees.set(t, body.tree);
        return send(201, { sha: t });
      }
      if (req.method === 'POST' && path === '/git/commits') {
        const c = sha(`commit:${body.tree}:${Date.now()}:${Math.random()}`);
        commits.set(c, { tree: body.tree, parents: body.parents ?? [], message: body.message });
        return send(201, { sha: c });
      }
      if (req.method === 'PATCH' && (m = /^\/git\/refs\/heads\/(.+)$/.exec(path))) {
        refs.set(decodeURIComponent(m[1]!), body.sha);
        return send(200, { object: { sha: body.sha } });
      }
      return send(404, { message: `No fake for ${req.method} ${path}` });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  const headTree = () => {
    const head = refs.get('main');
    return head ? (trees.get(commits.get(head)!.tree) ?? []) : [];
  };
  return {
    apiUrl: `http://127.0.0.1:${port}`,
    repo,
    token,
    writes: () => writes,
    failWith: (s) => (failStatus = s),
    commitCount: () => commits.size,
    files: () => Object.fromEntries(headTree().map((e) => [e.path, e.sha])),
    parentsOfHead: () => {
      const head = refs.get('main');
      return head ? commits.get(head)!.parents : [];
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
