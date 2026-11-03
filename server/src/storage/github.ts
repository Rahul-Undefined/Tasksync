// Stores encrypted TaskSync snapshots in a private GitHub repository using the Git Data API.
// Each save writes a single parentless commit containing:
//   tasksync-snapshot.bin       latest snapshot
//   backups/YYYY-MM-DD.bin      one per day, newest 7 kept
//   README.md                   what this repo is
// and force-moves the branch to it, so the repository doesn't grow with every change.

export interface SnapshotStore {
  describe(): string;
  /** null when the store is reachable but has no snapshot yet (first run). Throws on any other problem. */
  load(): Promise<{ data: Buffer; version: string } | null>;
  /** Current version (commit sha) of the stored snapshot, or null if none. */
  head(): Promise<string | null>;
  save(data: Buffer, now?: Date): Promise<string>;
}

export class StoreError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

const SNAPSHOT_PATH = 'tasksync-snapshot.bin';
const BACKUP_DIR = 'backups/';
const KEEP_BACKUPS = 7;
const README = `# TaskSync data

This private repository holds TaskSync's **encrypted** data snapshots, written automatically by the
TaskSync server. The files can only be read with the server's DATA_ENCRYPTION_KEY.

- Do not edit, rename or delete files here.
- Keep this repository **private**.
- \`backups/\` holds one snapshot per day for the last ${KEEP_BACKUPS} days.
`;

interface GitHubOptions {
  repo: string; // owner/name
  token: string;
  branch?: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

export class GitHubSnapshotStore implements SnapshotStore {
  private readonly base: string;
  private readonly branch: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GitHubOptions) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new StoreError(`Invalid repository name "${opts.repo}" (expected owner/name)`);
    this.base = `${(opts.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')}/repos/${opts.repo}`;
    this.branch = opts.branch ?? 'main';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  describe() {
    return `github:${this.opts.repo}@${this.branch}`;
  }

  private async call<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; json: T }> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'TaskSync',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok && !okStatuses.includes(res.status)) {
      const hint =
        res.status === 401
          ? 'GitHub rejected GITHUB_DATA_TOKEN (expired or wrong)'
          : res.status === 403
            ? 'GITHUB_DATA_TOKEN lacks "Contents: read and write" on the data repository, or GitHub rate-limited it'
            : res.status === 404
              ? `Repository ${this.opts.repo} not found, or the token can't access it`
              : `GitHub API ${method} ${path} failed`;
      throw new StoreError(`${hint} (HTTP ${res.status}${json?.message ? `: ${json.message}` : ''})`, res.status);
    }
    return { status: res.status, json };
  }

  /** Commit sha of the branch, or null if the repo/branch has no commits yet. */
  async head(): Promise<string | null> {
    const { status, json } = await this.call<{ object?: { sha: string } }>(
      'GET',
      `/git/ref/heads/${encodeURIComponent(this.branch)}`,
      undefined,
      [404, 409],
    );
    return status === 200 ? (json.object?.sha ?? null) : null;
  }

  private async treeOf(commitSha: string): Promise<{ path: string; sha: string; type: string }[]> {
    const { json: commit } = await this.call<{ tree: { sha: string } }>('GET', `/git/commits/${commitSha}`);
    const { json: tree } = await this.call<{ tree: { path: string; sha: string; type: string }[] }>(
      'GET',
      `/git/trees/${commit.tree.sha}?recursive=1`,
    );
    return tree.tree;
  }

  async load(): Promise<{ data: Buffer; version: string } | null> {
    // Fail loudly if the repository itself is unreachable (bad token/name) instead of treating it as empty.
    await this.call('GET', '');
    const version = await this.head();
    if (!version) return null;
    const entry = (await this.treeOf(version)).find((e) => e.path === SNAPSHOT_PATH && e.type === 'blob');
    if (!entry) return null;
    const { json: blob } = await this.call<{ content: string; encoding: string }>('GET', `/git/blobs/${entry.sha}`);
    if (blob.encoding !== 'base64') throw new StoreError(`Unexpected blob encoding ${blob.encoding}`);
    return { data: Buffer.from(blob.content, 'base64'), version };
  }

  async save(data: Buffer, now = new Date()): Promise<string> {
    let current = await this.head();
    if (!current) {
      // The Git Data API doesn't work on an empty repository: create a first commit with the README.
      await this.call(
        'PUT',
        '/contents/README.md',
        { message: 'Initialise TaskSync data repository', content: Buffer.from(README).toString('base64'), branch: this.branch },
        [422],
      );
      current = await this.head();
    }

    const previous = current ? await this.treeOf(current) : [];
    const { json: blob } = await this.call<{ sha: string }>('POST', '/git/blobs', {
      content: data.toString('base64'),
      encoding: 'base64',
    });
    const today = `${BACKUP_DIR}${now.toISOString().slice(0, 10)}.bin`;
    const backups = previous
      .filter((e) => e.type === 'blob' && e.path.startsWith(BACKUP_DIR) && e.path !== today)
      .sort((a, b) => b.path.localeCompare(a.path))
      .slice(0, KEEP_BACKUPS - 1);

    const { json: readme } = await this.call<{ sha: string }>('POST', '/git/blobs', {
      content: Buffer.from(README).toString('base64'),
      encoding: 'base64',
    });
    const entries = [
      { path: 'README.md', mode: '100644', type: 'blob', sha: readme.sha },
      { path: SNAPSHOT_PATH, mode: '100644', type: 'blob', sha: blob.sha },
      { path: today, mode: '100644', type: 'blob', sha: blob.sha },
      ...backups.map((b) => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
    ];
    const { json: tree } = await this.call<{ sha: string }>('POST', '/git/trees', { tree: entries });
    const { json: commit } = await this.call<{ sha: string }>('POST', '/git/commits', {
      message: `TaskSync snapshot ${now.toISOString()}`,
      tree: tree.sha,
      parents: [],
    });
    await this.call('PATCH', `/git/refs/heads/${encodeURIComponent(this.branch)}`, { sha: commit.sha, force: true });
    return commit.sha;
  }
}
