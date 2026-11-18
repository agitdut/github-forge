// GitHub REST v3 handlers under /api/v3: repositories, branches, refs, commits,
// contents, labels, issues, comments and pull requests (including merge).
// Every reply is application/json with a non-empty X-GitHub-Request-Id; errors
// are {"message": string}. Authentication is the trial bearer token, except
// for GET /api/v3[/] which answers without one, like the starter did.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  hashObject,
  parseCommit,
  parseTree,
  diffTrees,
  treeAtPath,
  createFileCommit,
} from './git.ts';
import type { TreeEntry } from './git.ts';
import type { Store } from './store.ts';
import type {
  CommentRecord,
  IssueRecord,
  LabelRecord,
  PullRecord,
  RepoRecord,
  RepoState,
} from './store.ts';
import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, nodeId } from './store.ts';
import { mergePullRequest } from './merge.ts';
import {
  sendJson,
  readBody,
  tryParseJson,
  requestIdHeaders,
  pathOf,
  queryOf,
  isAuthorized,
} from './util.ts';

// ---------------------------------------------------------------------------------------------
// Reply helpers

function originOf(req: IncomingMessage): string {
  return `http://${req.headers.host ?? 'localhost'}`;
}

function absUrl(req: IncomingMessage, path: string): string {
  return `${originOf(req)}${path}`;
}

function reply(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  sendJson(res, status, body, { ...requestIdHeaders(), ...headers });
}

function replyError(res: ServerResponse, status: number, message: string): void {
  reply(res, status, { message });
}

function replyNoContent(res: ServerResponse): void {
  res.writeHead(204, requestIdHeaders());
  res.end();
}

function decodeSeg(segment: string): string {
  // Most segments carry no escape: decodeURIComponent is ~1us a call and the router
  // decodes every segment of every REST path, so skip it on the plain fast path.
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((piece) => encodeURIComponent(piece))
    .join('/');
}

// ---------------------------------------------------------------------------------------------
// Presentation: the store keeps relative URLs; REST answers absolute ones.

function presentRepoRecord(record: RepoRecord, req: IncomingMessage): RepoRecord {
  const host = req.headers.host ?? 'localhost';
  return {
    ...record,
    html_url: `${originOf(req)}/${record.full_name}`,
    url: `${originOf(req)}/api/v3/repos/${record.full_name}`,
    clone_url: `${originOf(req)}/${record.full_name}.git`,
    git_url: `git://${host}/${record.full_name}.git`,
    ssh_url: `git@${host}:${record.full_name}.git`,
  };
}

function presentIssue(issue: IssueRecord, req: IncomingMessage): IssueRecord {
  const origin = originOf(req);
  return {
    ...issue,
    html_url: `${origin}${issue.html_url}`,
    url: `${origin}${issue.url}`,
    repository_url: `${origin}${issue.repository_url}`,
    labels_url: `${origin}${issue.labels_url}`,
    comments_url: `${origin}${issue.comments_url}`,
  };
}

function presentPull(pull: PullRecord, req: IncomingMessage): PullRecord {
  const origin = originOf(req);
  return {
    ...pull,
    html_url: `${origin}${pull.html_url}`,
    url: `${origin}${pull.url}`,
    head: { ...pull.head, repo: presentRepoRecord(pull.head.repo, req) },
    base: { ...pull.base, repo: presentRepoRecord(pull.base.repo, req) },
  };
}

function presentComment(
  comment: CommentRecord,
  state: RepoState,
  issueNumber: number,
  req: IncomingMessage,
): Record<string, unknown> {
  const full = state.repo.full_name;
  const origin = originOf(req);
  return {
    id: comment.id,
    node_id: comment.node_id,
    body: comment.body,
    user: comment.user,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    html_url: `${origin}/${full}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `${origin}/api/v3/repos/${full}/issues/${issueNumber}/comments/${comment.id}`,
    issue_url: `${origin}/api/v3/repos/${full}/issues/${issueNumber}`,
  };
}

function presentLabel(
  label: LabelRecord,
  state: RepoState,
  req: IncomingMessage,
): Record<string, unknown> {
  return {
    name: label.name,
    color: label.color,
    description: label.description,
    url: absUrl(req, `/api/v3/repos/${state.repo.full_name}/labels/${encodeURIComponent(label.name)}`),
    default: false,
  };
}

function presentViewer(req: IncomingMessage, store: Store): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: nodeId('User', VIEWER_ID),
    avatar_url: '',
    gravatar_id: '',
    url: absUrl(req, `/api/v3/users/${VIEWER_LOGIN}`),
    html_url: absUrl(req, `/${VIEWER_LOGIN}`),
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    public_repos: store.listViewerRepos().length,
    followers: 0,
    following: 0,
    created_at: store.nowIso,
    updated_at: store.nowIso,
  };
}

// ---------------------------------------------------------------------------------------------
// Pagination

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
  const rawPer = Number.parseInt(query.get('per_page') ?? '30', 10);
  return {
    page: Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1,
    perPage: Number.isFinite(rawPer) ? Math.min(100, Math.max(1, rawPer)) : 30,
  };
}

function paginate<T>(
  req: IncomingMessage,
  items: T[],
  basePath: string,
  query: URLSearchParams,
): { items: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(query);
  const total = items.length;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (total > perPage) {
    const origin = originOf(req);
    const linkFor = (p: number): string => {
      const q = new URLSearchParams(query);
      q.set('page', String(p));
      q.set('per_page', String(perPage));
      return `<${origin}${basePath}?${q.toString()}>`;
    };
    const parts: string[] = [];
    if (page < lastPage) parts.push(`${linkFor(page + 1)}; rel="next"`);
    if (page > 1) parts.push(`${linkFor(page - 1)}; rel="prev"`);
    parts.push(`${linkFor(1)}; rel="first"`);
    parts.push(`${linkFor(lastPage)}; rel="last"`);
    headers.link = parts.join(', ');
  }
  return { items: slice, headers };
}

// ---------------------------------------------------------------------------------------------
// Git helpers (read-only views over a repo's object/ref maps)

interface PersonIdentLike {
  name: string;
  email: string;
  time: number;
  tz: string;
}

function identJson(ident: PersonIdentLike): Record<string, unknown> {
  return {
    name: ident.name,
    email: ident.email,
    date: new Date(ident.time * 1000).toISOString(),
  };
}

function viewerOrNull(ident: PersonIdentLike): Record<string, unknown> | null {
  if (ident.email !== VIEWER_EMAIL) return null;
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: nodeId('User', VIEWER_ID),
    type: 'User',
    avatar_url: '',
  };
}

function branchTip(state: RepoState, branch: string): string | undefined {
  return state.git.refs.get(`refs/heads/${branch}`);
}

/** Resolve a `ref` query value (branch name or commit sha) to a commit, or undefined. */
function resolveRef(state: RepoState, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '') return branchTip(state, state.repo.default_branch);
  const tip = branchTip(state, ref);
  if (tip !== undefined) return tip;
  if (/^[0-9a-f]{40}$/i.test(ref) && state.git.objects.has(ref)) return ref;
  return undefined;
}

/** The blob (or tree) oid at `segments` below a commit's tree, or null when absent. */
function lookupPath(
  state: RepoState,
  commitOid: string,
  segments: readonly string[],
): { kind: 'file' | 'dir'; oid: string } | null {
  const obj = state.git.objects.get(commitOid);
  if (obj === undefined) return null;
  let parsed;
  try {
    parsed = parseCommit(obj.data);
  } catch {
    return null;
  }
  if (segments.length === 0) return { kind: 'dir', oid: parsed.tree };
  let found: { oid: string; mode: string } | null;
  try {
    found = treeAtPath(state.git.objects, parsed.tree, [...segments]);
  } catch {
    return null;
  }
  if (found === null) return null;
  const isDir = found.mode === '40000' || found.mode === '040000';
  return { kind: isDir ? 'dir' : 'file', oid: found.oid };
}

function blobAt(state: RepoState, treeOid: string, filename: string): string | null {
  try {
    const found = treeAtPath(state.git.objects, treeOid, filename.split('/'));
    return found === null ? null : found.oid;
  } catch {
    return null;
  }
}

function treeEntryName(entry: TreeEntry): string {
  const e = entry as unknown as Record<string, unknown>;
  if (typeof e.name === 'string') return e.name;
  if (typeof e.path === 'string') return e.path.split('/').pop() ?? '';
  return '';
}

function treeEntryOid(entry: TreeEntry): string {
  const e = entry as unknown as Record<string, unknown>;
  if (typeof e.oid === 'string') return e.oid;
  if (typeof e.sha === 'string') return e.sha;
  return '';
}

function listDir(
  state: RepoState,
  treeOid: string,
  prefix: string,
  req: IncomingMessage,
  refLabel: string,
): Record<string, unknown>[] {
  const obj = state.git.objects.get(treeOid);
  if (obj === undefined) return [];
  let entries: TreeEntry[];
  try {
    entries = parseTree(obj.data);
  } catch {
    return [];
  }
  const full = state.repo.full_name;
  const out: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const name = treeEntryName(entry);
    const oid = treeEntryOid(entry);
    if (name === '' || oid === '') continue;
    const target = state.git.objects.get(oid);
    const mode = (entry as unknown as Record<string, unknown>).mode;
    const typeField = (entry as unknown as Record<string, unknown>).type;
    const isDir =
      target !== undefined ? target.type === 'tree' : mode === '40000' || typeField === 'tree';
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const size = isDir ? 0 : target !== undefined ? target.data.length : 0;
    out.push({
      type: isDir ? 'dir' : 'file',
      name,
      path,
      sha: oid,
      size,
      url: absUrl(req, `/api/v3/repos/${full}/contents/${encodePath(path)}`),
      html_url: absUrl(
        req,
        isDir ? `/${full}/tree/${encodeURIComponent(refLabel)}/${encodePath(path)}` : `/${full}/blob/${encodeURIComponent(refLabel)}/${encodePath(path)}`,
      ),
      git_url: absUrl(req, `/api/v3/repos/${full}/git/${isDir ? 'trees' : 'blobs'}/${oid}`),
      download_url: isDir ? null : absUrl(req, `/api/v3/repos/${full}/contents/${encodePath(path)}`),
    });
  }
  return out;
}

function presentContentFile(
  state: RepoState,
  blobOid: string,
  segments: readonly string[],
  req: IncomingMessage,
  refLabel: string,
): Record<string, unknown> {
  const full = state.repo.full_name;
  const path = segments.join('/');
  const obj = state.git.objects.get(blobOid);
  const buf = obj === undefined ? Buffer.alloc(0) : obj.data;
  return {
    type: 'file',
    name: segments[segments.length - 1] ?? '',
    path,
    sha: blobOid,
    size: buf.length,
    content: buf.toString('base64'),
    encoding: 'base64',
    url: absUrl(req, `/api/v3/repos/${full}/contents/${encodePath(path)}`),
    html_url: absUrl(req, `/${full}/blob/${encodeURIComponent(refLabel)}/${encodePath(path)}`),
    git_url: absUrl(req, `/api/v3/repos/${full}/git/blobs/${blobOid}`),
    download_url: absUrl(req, `/api/v3/repos/${full}/contents/${encodePath(path)}`),
  };
}

function presentCommitSummary(
  sha: string,
  state: RepoState,
  req: IncomingMessage,
): Record<string, unknown> {
  const full = state.repo.full_name;
  const obj = state.git.objects.get(sha);
  if (obj === undefined) return { sha };
  let parsed;
  try {
    parsed = parseCommit(obj.data);
  } catch {
    return { sha };
  }
  return {
    sha,
    message: parsed.message,
    author: identJson(parsed.author),
    committer: identJson(parsed.committer),
    tree: { sha: parsed.tree },
    parents: parsed.parents.map((p: string) => ({
      sha: p,
      url: absUrl(req, `/api/v3/repos/${full}/commits/${p}`),
    })),
    url: absUrl(req, `/api/v3/repos/${full}/commits/${sha}`),
    html_url: absUrl(req, `/${full}/commit/${sha}`),
  };
}

function presentCommitEntry(
  sha: string,
  parsed: ReturnType<typeof parseCommit>,
  state: RepoState,
  req: IncomingMessage,
): Record<string, unknown> {
  const full = state.repo.full_name;
  return {
    sha,
    commit: {
      author: identJson(parsed.author),
      committer: identJson(parsed.committer),
      message: parsed.message,
      tree: { sha: parsed.tree },
      url: absUrl(req, `/api/v3/repos/${full}/git/commits/${sha}`),
      comment_count: 0,
    },
    author: viewerOrNull(parsed.author),
    committer: viewerOrNull(parsed.committer),
    parents: parsed.parents.map((p: string) => ({
      sha: p,
      url: absUrl(req, `/api/v3/repos/${full}/commits/${p}`),
    })),
    url: absUrl(req, `/api/v3/repos/${full}/commits/${sha}`),
    html_url: absUrl(req, `/${full}/commit/${sha}`),
  };
}

/**
 * A minimal unified diff for a text file pair (old null = added, new null =
 * removed). Only the changed lines, no context: enough for the `patch` field
 * the pull-files reply carries. Binary content yields no patch.
 */
function simplePatch(oldBuf: Buffer | null, newBuf: Buffer | null): string | undefined {
  const oldText = oldBuf === null ? null : oldBuf.toString('utf8');
  const newText = newBuf === null ? null : newBuf.toString('utf8');
  if ((oldText !== null && oldText.includes('\0')) || (newText !== null && newText.includes('\0'))) {
    return undefined;
  }
  const splitLines = (text: string | null): string[] => {
    if (text === null || text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  if (removed.length === 0 && added.length === 0) return undefined;
  const oldStart = removed.length === 0 ? prefix : prefix + 1;
  const newStart = added.length === 0 ? prefix : prefix + 1;
  const lines: string[] = [`@@ -${oldStart},${removed.length} +${newStart},${added.length} @@`];
  for (const line of removed) lines.push(`-${line}`);
  for (const line of added) lines.push(`+${line}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Body parsing

type BodyResult = { ok: true; value: Record<string, unknown> } | { ok: false };

async function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    return { ok: false };
  }
  const text = raw.toString('utf8');
  if (text.trim() === '') return { ok: true, value: {} };
  const parsed = tryParseJson(text);
  if (!parsed.ok) return { ok: false };
  const value = parsed.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
  return { ok: true, value: value as Record<string, unknown> };
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function labelNamesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (item !== null && typeof item === 'object') {
      const name = (item as Record<string, unknown>).name;
      if (typeof name === 'string') out.push(name);
    }
  }
  return out;
}

function parseNumber(segment: string): number {
  return /^\d+$/.test(segment) ? Number(segment) : Number.NaN;
}

function stripRefPrefix(ref: string): string {
  const idx = ref.indexOf(':');
  return idx === -1 ? ref : ref.slice(idx + 1);
}

// ---------------------------------------------------------------------------------------------
// Entry point

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
): Promise<boolean> {
  const rawPath = pathOf(req);
  if (rawPath !== '/api/v3' && !rawPath.startsWith('/api/v3/')) return false;
  const method = req.method ?? 'GET';

  // The API root answers without auth, like the starter did.
  if (method === 'GET' && (rawPath === '/api/v3' || rawPath === '/api/v3/')) {
    reply(
      res,
      200,
      {
        current_user_url: absUrl(req, '/api/v3/user'),
        rate_limit_url: absUrl(req, '/api/v3/rate_limit'),
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  if (!isAuthorized(req, store.token)) {
    replyError(res, 401, 'Bad credentials');
    return true;
  }

  const segments = rawPath
    .split('/')
    .filter((s) => s !== '')
    .map(decodeSeg);
  try {
    await routeRest(req, res, store, method, segments);
  } catch (err) {
    replyError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
  }
  return true;
}

async function routeRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  method: string,
  segments: string[],
): Promise<void> {
  const query = queryOf(req);
  let body: Record<string, unknown> = {};
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      replyError(res, 400, 'Invalid JSON in request body');
      return;
    }
    body = parsed.value;
  }

  const seg = segments.slice(2); // after api/v3

  if (seg.length === 1 && seg[0] === 'meta' && method === 'GET') {
    reply(res, 200, { installed_version: '1.0.0' });
    return;
  }

  if (seg.length === 1 && seg[0] === 'user' && method === 'GET') {
    reply(res, 200, presentViewer(req, store));
    return;
  }

  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.listViewerRepos().map((s) => presentRepoRecord(s.repo, req));
      const { items, headers } = paginate(req, repos, '/api/v3/user/repos', query);
      reply(res, 200, items, headers);
      return;
    }
    if (method === 'POST') {
      const name = stringField(body, 'name');
      if (name === '') {
        replyError(res, 422, 'name is required');
        return;
      }
      const created = store.createRepo(name, {
        private: typeof body.private === 'boolean' ? body.private : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
        defaultBranch:
          typeof body.default_branch === 'string' ? body.default_branch : undefined,
      });
      if (created === null) {
        replyError(res, 422, `Repository '${name}' already exists`);
        return;
      }
      reply(res, 201, presentRepoRecord(created.repo, req));
      return;
    }
  }

  if (seg.length >= 2 && seg[0] === 'repos') {
    await routeRepo(req, res, store, method, seg.slice(1), body, query);
    return;
  }

  replyError(res, 404, 'Not Found');
}

async function routeRepo(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  method: string,
  seg: string[],
  body: Record<string, unknown>,
  query: URLSearchParams,
): Promise<void> {
  const owner = seg[0] as string;
  const name = seg[1] as string;
  const state = store.getRepo(owner, name);
  if (state === undefined) {
    replyError(res, 404, 'Not Found');
    return;
  }
  const full = state.repo.full_name;
  const rest = seg.slice(2);

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      reply(res, 200, presentRepoRecord(state.repo, req));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') state.repo.description = body.description;
      state.repo.updated_at = store.nowIso;
      reply(res, 200, presentRepoRecord(state.repo, req));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      replyNoContent(res);
      return;
    }
    replyError(res, 404, 'Not Found');
    return;
  }

  // /repos/{o}/{r}/branches
  if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
    const branches: Record<string, unknown>[] = [];
    for (const [ref, sha] of state.git.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      branches.push({
        name: ref.slice('refs/heads/'.length),
        commit: { sha, url: absUrl(req, `/api/v3/repos/${full}/commits/${sha}`) },
        protected: false,
      });
    }
    branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    reply(res, 200, branches);
    return;
  }

  // /repos/{o}/{r}/git/refs
  if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
    const ref = stringField(body, 'ref');
    const sha = stringField(body, 'sha');
    if (!ref.startsWith('refs/heads/') || ref.length <= 'refs/heads/'.length) {
      replyError(res, 422, 'Invalid ref');
      return;
    }
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
      replyError(res, 422, 'Invalid sha');
      return;
    }
    const obj = state.git.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') {
      replyError(res, 422, 'Invalid sha');
      return;
    }
    if (state.git.refs.has(ref)) {
      replyError(res, 422, 'Reference already exists');
      return;
    }
    state.git.refs.set(ref, sha);
    reply(res, 201, {
      ref,
      object: { sha, type: 'commit', url: absUrl(req, `/api/v3/repos/${full}/git/commits/${sha}`) },
      url: absUrl(req, `/api/v3/repos/${full}/git/refs/${ref}`),
    });
    return;
  }

  // /repos/{o}/{r}/commits
  if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
    const refParam = query.get('sha') ?? undefined;
    const tip = resolveRef(state, refParam);
    if (tip === undefined) {
      if (refParam !== undefined) {
        replyError(res, 404, `No commit found for SHA: ${refParam}`);
        return;
      }
      reply(res, 200, []);
      return;
    }
    const visited = new Set<string>();
    const stack: string[] = [tip];
    const out: Record<string, unknown>[] = [];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (visited.has(sha)) continue;
      visited.add(sha);
      const obj = state.git.objects.get(sha);
      if (obj === undefined) continue;
      let parsed;
      try {
        parsed = parseCommit(obj.data);
      } catch {
        continue;
      }
      out.push(presentCommitEntry(sha, parsed, state, req));
      for (let i = parsed.parents.length - 1; i >= 0; i -= 1) {
        stack.push(parsed.parents[i] as string);
      }
    }
    reply(res, 200, out);
    return;
  }

  // /repos/{o}/{r}/contents[/{path}]
  if (rest.length >= 1 && rest[0] === 'contents') {
    await routeContents(req, res, store, state, method, rest.slice(1), body, query);
    return;
  }

  // /repos/{o}/{r}/labels
  if (rest.length === 1 && rest[0] === 'labels') {
    if (method === 'GET') {
      reply(
        res,
        200,
        [...state.labels.values()].map((label) => presentLabel(label, state, req)),
      );
      return;
    }
    if (method === 'POST') {
      const labelName = stringField(body, 'name');
      if (labelName === '') {
        replyError(res, 422, 'name is required');
        return;
      }
      const created = store.createLabel(
        state,
        labelName,
        typeof body.color === 'string' ? body.color : undefined,
        typeof body.description === 'string' ? body.description : undefined,
      );
      if (created === null) {
        replyError(res, 422, `Label '${labelName}' already exists`);
        return;
      }
      reply(res, 201, presentLabel(created, state, req));
      return;
    }
  }

  // /repos/{o}/{r}/issues...
  if (rest.length >= 1 && rest[0] === 'issues') {
    await routeIssues(req, res, store, state, method, rest.slice(1), body, query);
    return;
  }

  // /repos/{o}/{r}/pulls...
  if (rest.length >= 1 && rest[0] === 'pulls') {
    await routePulls(req, res, store, state, method, rest.slice(1), body, query);
    return;
  }

  replyError(res, 404, 'Not Found');
}

async function routeContents(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  state: RepoState,
  method: string,
  pathParts: string[],
  body: Record<string, unknown>,
  query: URLSearchParams,
): Promise<void> {
  const full = state.repo.full_name;
  const path = pathParts.join('/');
  const author = { name: VIEWER_NAME, email: VIEWER_EMAIL, time: store.nowSec, tz: '+0000' };

  if (method === 'GET') {
    const refParam = query.get('ref') ?? undefined;
    const tip = resolveRef(state, refParam);
    if (tip === undefined) {
      replyError(res, 404, 'Not Found');
      return;
    }
    const found = lookupPath(state, tip, pathParts);
    if (found === null) {
      replyError(res, 404, 'Not Found');
      return;
    }
    const refLabel = refParam ?? state.repo.default_branch;
    if (found.kind === 'dir') {
      reply(res, 200, listDir(state, found.oid, path, req, refLabel));
      return;
    }
    reply(res, 200, presentContentFile(state, found.oid, pathParts, req, refLabel));
    return;
  }

  if (method === 'PUT') {
    if (pathParts.length === 0) {
      replyError(res, 404, 'Not Found');
      return;
    }
    const contentB64 = stringField(body, 'content');
    if (contentB64 === '') {
      replyError(res, 422, 'content is required');
      return;
    }
    let contentBuf: Buffer;
    try {
      contentBuf = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      replyError(res, 422, 'content is not valid base64');
      return;
    }
    const message = stringField(body, 'message');
    const branch = stringField(body, 'branch') !== '' ? stringField(body, 'branch') : state.repo.default_branch;
    const tip = branchTip(state, branch);
    const hasAnyBranch = [...state.git.refs.keys()].some((ref) => ref.startsWith('refs/heads/'));
    if (tip === undefined && hasAnyBranch) {
      replyError(res, 422, `Branch '${branch}' not found`);
      return;
    }
    const existing = tip === undefined ? null : lookupPath(state, tip, pathParts);
    if (existing !== null && existing.kind === 'dir') {
      replyError(res, 422, 'Path is a directory');
      return;
    }
    const shaParam = typeof body.sha === 'string' ? body.sha : undefined;
    if (shaParam !== undefined) {
      if (existing === null) {
        replyError(res, 422, 'sha does not match the current file');
        return;
      }
      if (shaParam !== existing.oid) {
        replyError(res, 409, 'sha does not match the current file');
        return;
      }
    }
    const isUpdate = existing !== null;
    let commitSha: string;
    try {
      commitSha = createFileCommit(
        state.git.objects,
        state.git.refs,
        branch,
        path,
        contentBuf,
        message,
        author,
        store.nowSec,
      );
    } catch (err) {
      replyError(res, 422, err instanceof Error ? err.message : 'Could not create commit');
      return;
    }
    const blobSha = hashObject('blob', contentBuf);
    state.contents.set(path, { path, sha: blobSha, content: contentBuf, commitSha });
    state.repo.pushed_at = store.nowIso;
    state.repo.updated_at = store.nowIso;
    reply(res, isUpdate ? 200 : 201, {
      content: {
        type: 'file',
        name: pathParts[pathParts.length - 1] ?? '',
        path,
        sha: blobSha,
        size: contentBuf.length,
        content: contentBuf.toString('base64'),
        encoding: 'base64',
        url: absUrl(req, `/api/v3/repos/${full}/contents/${encodePath(path)}`),
      },
      commit: presentCommitSummary(commitSha, state, req),
    });
    return;
  }

  if (method === 'DELETE') {
    if (pathParts.length === 0) {
      replyError(res, 404, 'Not Found');
      return;
    }
    const branch = stringField(body, 'branch') !== '' ? stringField(body, 'branch') : state.repo.default_branch;
    const tip = branchTip(state, branch);
    if (tip === undefined) {
      replyError(res, 404, 'Not Found');
      return;
    }
    const existing = lookupPath(state, tip, pathParts);
    if (existing === null || existing.kind !== 'file') {
      replyError(res, 404, 'Not Found');
      return;
    }
    const message = stringField(body, 'message');
    let commitSha: string;
    try {
      commitSha = createFileCommit(
        state.git.objects,
        state.git.refs,
        branch,
        path,
        null,
        message,
        author,
        store.nowSec,
      );
    } catch (err) {
      replyError(res, 422, err instanceof Error ? err.message : 'Could not create commit');
      return;
    }
    state.contents.delete(path);
    state.repo.pushed_at = store.nowIso;
    state.repo.updated_at = store.nowIso;
    reply(res, 200, { commit: presentCommitSummary(commitSha, state, req), content: null });
    return;
  }

  replyError(res, 404, 'Not Found');
}

async function routeIssues(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  state: RepoState,
  method: string,
  rest: string[],
  body: Record<string, unknown>,
  query: URLSearchParams,
): Promise<void> {
  const full = state.repo.full_name;

  // /issues
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = stringField(body, 'title');
      if (title === '') {
        replyError(res, 422, 'title is required');
        return;
      }
      const bodyText = stringField(body, 'body');
      const created = store.createIssue(state, title, bodyText, labelNamesOf(body.labels));
      if ('error' in created) {
        replyError(res, 422, `Label '${created.label}' does not exist`);
        return;
      }
      reply(res, 201, presentIssue(created, req));
      return;
    }
    if (method === 'GET') {
      const stateParam = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = state.issues;
      if (stateParam === 'closed') list = list.filter((issue) => issue.state === 'closed');
      else if (stateParam === 'all') list = list.slice();
      else list = list.filter((issue) => issue.state === 'open');
      if (sort === 'created') list = direction === 'asc' ? list.slice() : list.slice().reverse();
      const presented = list.map((issue) => presentIssue(issue, req));
      const { items, headers } = paginate(req, presented, `/api/v3/repos/${full}/issues`, query);
      reply(res, 200, items, headers);
      return;
    }
    replyError(res, 404, 'Not Found');
    return;
  }

  // /issues/{n}
  const number = parseNumber(rest[0] as string);
  if (rest.length === 1) {
    if (method === 'GET') {
      const issue = store.getIssue(state, number);
      if (issue === undefined) {
        replyError(res, 404, 'Not Found');
        return;
      }
      reply(res, 200, presentIssue(issue, req));
      return;
    }
    if (method === 'PATCH') {
      const issue = store.getIssue(state, number);
      if (issue === undefined) {
        replyError(res, 404, 'Not Found');
        return;
      }
      const patch: { title?: string; body?: string; state?: 'open' | 'closed' } = {};
      if (typeof body.title === 'string') patch.title = body.title;
      if (typeof body.body === 'string') patch.body = body.body;
      if (body.state !== undefined) {
        if (body.state !== 'open' && body.state !== 'closed') {
          replyError(res, 422, 'Invalid state');
          return;
        }
        patch.state = body.state;
      }
      if (body.labels !== undefined) {
        const names = labelNamesOf(body.labels);
        for (const labelName of names) {
          if (!state.labels.has(labelName)) {
            replyError(res, 422, `Label '${labelName}' does not exist`);
            return;
          }
        }
        issue.labels = names.map((labelName) => state.labels.get(labelName) as LabelRecord);
      }
      const updated = store.updateIssue(state, number, patch) as IssueRecord;
      reply(res, 200, presentIssue(updated, req));
      return;
    }
    replyError(res, 404, 'Not Found');
    return;
  }

  // /issues/{n}/comments
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') {
      const issue = store.getIssue(state, number);
      if (issue === undefined) {
        replyError(res, 404, 'Not Found');
        return;
      }
      const text = stringField(body, 'body');
      if (text === '') {
        replyError(res, 422, 'body is required');
        return;
      }
      const comment = store.addComment(state, number, text) as CommentRecord;
      reply(res, 201, presentComment(comment, state, number, req));
      return;
    }
    if (method === 'GET') {
      const issue = store.getIssue(state, number);
      if (issue === undefined) {
        replyError(res, 404, 'Not Found');
        return;
      }
      const comments = store
        .listComments(state, number)
        .map((comment) => presentComment(comment, state, number, req));
      const { items, headers } = paginate(
        req,
        comments,
        `/api/v3/repos/${full}/issues/${number}/comments`,
        query,
      );
      reply(res, 200, items, headers);
      return;
    }
  }

  replyError(res, 404, 'Not Found');
}

async function routePulls(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  state: RepoState,
  method: string,
  rest: string[],
  body: Record<string, unknown>,
  query: URLSearchParams,
): Promise<void> {
  const full = state.repo.full_name;

  // /pulls
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = stringField(body, 'title');
      if (title === '') {
        replyError(res, 422, 'title is required');
        return;
      }
      const headRaw = stringField(body, 'head');
      if (headRaw === '') {
        replyError(res, 422, 'head is required');
        return;
      }
      const head = stripRefPrefix(headRaw);
      const baseRaw = stringField(body, 'base');
      const base = baseRaw === '' ? state.repo.default_branch : stripRefPrefix(baseRaw);
      const bodyText = stringField(body, 'body');
      const created = store.createPull(state, title, bodyText, head, base);
      if ('error' in created) {
        if (created.error === 'bad-head') replyError(res, 422, `Head branch '${head}' not found`);
        else replyError(res, 422, `Base branch '${base}' not found`);
        return;
      }
      reply(res, 201, presentPull(created, req));
      return;
    }
    if (method === 'GET') {
      const stateParam = query.get('state') ?? 'open';
      let list = state.pulls;
      if (stateParam === 'closed') list = list.filter((pull) => pull.state === 'closed');
      else if (stateParam === 'all') list = list.slice();
      else list = list.filter((pull) => pull.state === 'open');
      list = list.slice().reverse();
      const presented = list.map((pull) => presentPull(pull, req));
      const { items, headers } = paginate(req, presented, `/api/v3/repos/${full}/pulls`, query);
      reply(res, 200, items, headers);
      return;
    }
    replyError(res, 404, 'Not Found');
    return;
  }

  const number = parseNumber(rest[0] as string);

  // /pulls/{n}
  if (rest.length === 1) {
    if (method === 'GET') {
      const pull = store.getPull(state, number);
      if (pull === undefined) {
        replyError(res, 404, 'Not Found');
        return;
      }
      reply(res, 200, presentPull(pull, req));
      return;
    }
    replyError(res, 404, 'Not Found');
    return;
  }

  // /pulls/{n}/files
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const pull = store.getPull(state, number);
    if (pull === undefined) {
      replyError(res, 404, 'Not Found');
      return;
    }
    const headTip = branchTip(state, pull.head.ref) ?? pull.head.sha;
    const headObj = state.git.objects.get(headTip);
    const baseObj = state.git.objects.get(pull.base.sha);
    if (headObj === undefined || baseObj === undefined) {
      replyError(res, 404, 'Head or base commit not found');
      return;
    }
    let headTree: string;
    let baseTree: string;
    try {
      headTree = parseCommit(headObj.data).tree;
      baseTree = parseCommit(baseObj.data).tree;
    } catch {
      replyError(res, 404, 'Head or base commit not found');
      return;
    }
    let diffs;
    try {
      diffs = diffTrees(state.git.objects, baseTree, headTree);
    } catch (err) {
      replyError(res, 500, err instanceof Error ? err.message : 'Could not compute diff');
      return;
    }
    const files = diffs.map((diff) => {
      const oldOid = blobAt(state, baseTree, diff.filename);
      const newOid = blobAt(state, headTree, diff.filename);
      const oldBuf = oldOid === null ? null : (state.git.objects.get(oldOid)?.data ?? null);
      const newBuf = newOid === null ? null : (state.git.objects.get(newOid)?.data ?? null);
      const patch = simplePatch(oldBuf, newBuf);
      const out: Record<string, unknown> = {
        sha: newOid ?? oldOid ?? '',
        filename: diff.filename,
        status: diff.status,
        additions: diff.additions,
        deletions: diff.deletions,
        changes: diff.additions + diff.deletions,
        blob_url: absUrl(req, `/${full}/blob/${headTip}/${encodePath(diff.filename)}`),
        raw_url: absUrl(req, `/${full}/raw/${headTip}/${encodePath(diff.filename)}`),
        contents_url: absUrl(
          req,
          `/api/v3/repos/${full}/contents/${encodePath(diff.filename)}?ref=${encodeURIComponent(pull.head.ref)}`,
        ),
      };
      if (patch !== undefined) out.patch = patch;
      return out;
    });
    reply(res, 200, files);
    return;
  }

  // /pulls/{n}/merge
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const pull = store.getPull(state, number);
    if (pull === undefined) {
      replyError(res, 404, 'Not Found');
      return;
    }
    const mergeMethod = stringField(body, 'merge_method') !== '' ? stringField(body, 'merge_method') : 'squash';
    const result = mergePullRequest(store, state, pull, mergeMethod);
    if (!result.ok) {
      replyError(res, result.status, result.message);
      return;
    }
    reply(res, 200, { sha: result.sha, merged: true, message: result.message });
    return;
  }

  replyError(res, 404, 'Not Found');
}
