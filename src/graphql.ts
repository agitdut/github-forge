// GraphQL v4 (POST /api/graphql) for the github-core-clone-01 forge.
//
// A small, dependency-free GraphQL executor: it tokenizes and parses the
// documents gh and github-mcp-server send, resolves them against the shared
// Store, and answers {data, errors} envelopes (plus GitHub's JSON-array
// operation batching). No network, no clock, no randomness: every id and
// timestamp comes from the Store, so a live run and its replay agree.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, RepoState, IssueRecord, PullRecord } from './store.ts';
import { VIEWER, VIEWER_LOGIN, nodeId, decodeNodeId } from './store.ts';
import { mergePullRequest } from './merge.ts';
import { sendJson, readBody, tryParseJson, pathOf, isAuthorized } from './util.ts';

// ---------------------------------------------------------------------------
// Small record helpers (the Store's exact record shapes live in store.ts;
// these read them defensively so a missing optional field degrades to a
// sensible default instead of a throw).
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rec(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** The repository record inside a RepoState (or the state itself when it already is one). */
function repoRecord(state: RepoState): Record<string, unknown> {
  const outer = rec(state);
  if (isRecord(outer.repo)) return outer.repo;
  return outer;
}

function repoName(state: RepoState): string {
  return str(repoRecord(state).name);
}

function repoOwnerLogin(state: RepoState): string {
  const owner = repoRecord(state).owner;
  if (typeof owner === 'string' && owner !== '') return owner;
  if (isRecord(owner) && typeof owner.login === 'string' && owner.login !== '') return owner.login;
  return VIEWER_LOGIN;
}

function repoNumericId(state: RepoState): number {
  return num(repoRecord(state).id) ?? 0;
}

function repoNodeId(state: RepoState): string {
  const record = repoRecord(state);
  if (typeof record.node_id === 'string' && record.node_id !== '') return record.node_id;
  if (typeof record.nodeId === 'string' && record.nodeId !== '') return record.nodeId;
  return nodeId('Repository', repoNumericId(state) || 0);
}

function repoDefaultBranch(state: RepoState): string {
  const record = repoRecord(state);
  return str(record.default_branch, str(record.defaultBranch, 'main')) || 'main';
}

function repoIssues(state: RepoState): IssueRecord[] {
  const list = rec(state).issues;
  return Array.isArray(list) ? (list as IssueRecord[]) : [];
}

function repoPulls(state: RepoState): PullRecord[] {
  const list = rec(state).pulls;
  return Array.isArray(list) ? (list as PullRecord[]) : [];
}

function issueNodeId(issue: IssueRecord): string {
  const record = rec(issue);
  if (typeof record.node_id === 'string' && record.node_id !== '') return record.node_id;
  if (typeof record.nodeId === 'string' && record.nodeId !== '') return record.nodeId;
  return nodeId('Issue', num(record.id) ?? num(record.number) ?? 0);
}

function pullNodeId(pull: PullRecord): string {
  const record = rec(pull);
  if (typeof record.node_id === 'string' && record.node_id !== '') return record.node_id;
  if (typeof record.nodeId === 'string' && record.nodeId !== '') return record.nodeId;
  return nodeId('PullRequest', num(record.id) ?? num(record.number) ?? 0);
}

/** A stable numeric Relay id for a user login (the viewer uses its real id). */
function userNodeId(login: string): string {
  if (login === VIEWER_LOGIN) return VIEWER.node_id;
  let hash = 0;
  for (let index = 0; index < login.length; index += 1) hash = (hash * 31 + login.charCodeAt(index)) >>> 0;
  return nodeId('User', 100000 + (hash % 100000));
}

function issueState(issue: IssueRecord): string {
  return str(rec(issue).state, 'open').toLowerCase() === 'closed' ? 'CLOSED' : 'OPEN';
}

function pullState(pull: PullRecord): string {
  const record = rec(pull);
  if (bool(record.merged, false)) return 'MERGED';
  return str(record.state, 'open').toLowerCase() === 'closed' ? 'CLOSED' : 'OPEN';
}

function pullHeadRef(pull: PullRecord): string {
  const head = rec(rec(pull).head);
  return str(head.ref, str(rec(pull).headRefName, ''));
}

function pullBaseRef(pull: PullRecord): string {
  const base = rec(rec(pull).base);
  return str(base.ref, str(rec(pull).baseRefName, ''));
}

function pullHeadSha(pull: PullRecord): string {
  return str(rec(rec(pull).head).sha, '');
}

function pullBaseSha(pull: PullRecord): string {
  return str(rec(rec(pull).base).sha, '');
}

function actorLogin(value: unknown): string {
  if (typeof value === 'string' && value !== '') return value;
  const record = rec(value);
  if (typeof record.login === 'string' && record.login !== '') return record.login;
  return VIEWER_LOGIN;
}

// ---------------------------------------------------------------------------
// Store lookups.
// ---------------------------------------------------------------------------

/** Every viewer repository as a RepoState, whatever listViewerRepos returns. */
async function allRepoStates(store: Store): Promise<RepoState[]> {
  const list = (await store.listViewerRepos()) as unknown;
  const arr = Array.isArray(list) ? list : [];
  const out: RepoState[] = [];
  for (const entry of arr) {
    const outer = rec(entry);
    if (isRecord(outer.repo)) {
      out.push(entry as RepoState);
      continue;
    }
    const name = str(outer.name);
    if (name === '') continue;
    const state = (await store.getRepo(actorLogin(outer.owner), name)) as unknown;
    if (state !== null && state !== undefined) out.push(state as RepoState);
  }
  return out;
}

async function findRepoState(store: Store, owner: string, name: string): Promise<RepoState | null> {
  const state = (await store.getRepo(owner, name)) as unknown;
  if (state === null || state === undefined) return null;
  return state as RepoState;
}

/** Find a repository by its Relay global id (decoded id, or the raw node id). */
async function findRepoByNodeId(store: Store, rawNodeId: string): Promise<RepoState | null> {
  if (rawNodeId === '') return null;
  const decoded = decodeNodeId(rawNodeId);
  for (const state of await allRepoStates(store)) {
    if (repoNodeId(state) === rawNodeId) return state;
    if (decoded !== null && decoded.kind === 'Repository') {
      if (repoNumericId(state) === decoded.id) return state;
      if (repoName(state) === String(decoded.id)) return state;
    }
  }
  return null;
}

interface FoundIssue {
  state: RepoState;
  issue: IssueRecord;
}

interface FoundPull {
  state: RepoState;
  pull: PullRecord;
}

/** Find an issue by its Relay global id, scanning every viewer repository. */
async function findIssueByNodeId(store: Store, rawNodeId: string): Promise<FoundIssue | null> {
  if (rawNodeId === '') return null;
  const decoded = decodeNodeId(rawNodeId);
  for (const state of await allRepoStates(store)) {
    for (const issue of repoIssues(state)) {
      if (issueNodeId(issue) === rawNodeId) return { state, issue };
      if (decoded !== null && decoded.kind === 'Issue') {
        const own = decodeNodeId(issueNodeId(issue));
        if (own !== null && own.kind === 'Issue' && own.id === decoded.id) return { state, issue };
      }
    }
  }
  return null;
}

/** Find a pull request by its Relay global id, scanning every viewer repository. */
async function findPullByNodeId(store: Store, rawNodeId: string): Promise<FoundPull | null> {
  if (rawNodeId === '') return null;
  const decoded = decodeNodeId(rawNodeId);
  for (const state of await allRepoStates(store)) {
    for (const pull of repoPulls(state)) {
      if (pullNodeId(pull) === rawNodeId) return { state, pull };
      if (decoded !== null && decoded.kind === 'PullRequest') {
        const own = decodeNodeId(pullNodeId(pull));
        if (own !== null && own.kind === 'PullRequest' && own.id === decoded.id) return { state, pull };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Comments (addComment) and pull-request files.
// ---------------------------------------------------------------------------

/**
 * Add a comment to an issue in the Store. Prefers a store method when one
 * exists, otherwise appends to the RepoState's comments Map (keyed by issue
 * number, falling back to whatever key the map already uses for this issue).
 */
async function addCommentToStore(
  store: Store,
  state: RepoState,
  issue: IssueRecord,
  body: string,
): Promise<Record<string, unknown>> {
  const loose = store as unknown as Record<string, unknown>;
  for (const method of ['addComment', 'createComment'] as const) {
    const fn = loose[method];
    if (typeof fn === 'function') {
      const made = (await (fn as (...args: unknown[]) => unknown).call(store, state, num(rec(issue).number) ?? 0, body)) as unknown;
      if (isRecord(made)) {
        if (typeof made.node_id !== 'string') {
          made.node_id = nodeId('IssueComment', num(made.id) ?? 0);
        }
        return made;
      }
    }
  }
  const map = rec(state).comments as Map<unknown, unknown[]> | undefined;
  if (map === undefined || typeof map.get !== 'function' || typeof map.set !== 'function') {
    throw new Error('the store does not support comments');
  }
  const number = num(rec(issue).number) ?? 0;
  let key: unknown = number;
  if (!map.has(number) && map.has(String(number))) key = String(number);
  if (!map.has(key) && map.has(issueNodeId(issue))) key = issueNodeId(issue);
  const existing = map.get(key);
  const list: unknown[] = Array.isArray(existing) ? [...existing] : [];
  let maxId = 0;
  for (const values of map.values()) {
    if (!Array.isArray(values)) continue;
    for (const entry of values) {
      const id = num(rec(entry).id);
      if (id !== undefined && id > maxId) maxId = id;
    }
  }
  const id = maxId + 1;
  const comment: Record<string, unknown> = {
    id,
    node_id: nodeId('IssueComment', id),
    body,
    user: { login: VIEWER_LOGIN },
    created_at: store.nowIso,
    updated_at: store.nowIso,
  };
  list.push(comment);
  map.set(key, list);
  return comment;
}

/** The changed file paths of a pull request, best effort. */
function pullFiles(state: RepoState, pull: PullRecord): string[] {
  const record = rec(pull);
  for (const key of ['files', 'changed_files', 'changedFiles', 'file_paths', 'filePaths'] as const) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const paths: string[] = [];
    for (const entry of value) {
      if (typeof entry === 'string' && entry !== '') paths.push(entry);
      else {
        const path = str(rec(entry).path, '');
        if (path !== '') paths.push(path);
      }
    }
    if (paths.length > 0) return paths;
  }
  try {
    return gitDiffFiles(state, pull);
  } catch {
    return [];
  }
}

/**
 * Diff the head tree against the base tree from the Store's raw git objects
 * (Buffers in "commit <len>\0..." / "tree <len>\0..." form). Returns [] when
 * the objects are absent or unreadable.
 */
function gitDiffFiles(state: RepoState, pull: PullRecord): string[] {
  const git = rec(rec(state).git);
  const objects = git.objects as Map<string, unknown> | undefined;
  if (objects === undefined || typeof objects.get !== 'function') return [];
  const headSha = pullHeadSha(pull);
  const baseSha = pullBaseSha(pull);
  if (headSha === '' || baseSha === '') return [];
  const headTree = treePaths(objects, headSha);
  const baseTree = treePaths(objects, baseSha);
  if (headTree === null || baseTree === null) return [];
  const out: string[] = [];
  const all = new Set<string>([...headTree.keys(), ...baseTree.keys()]);
  for (const path of all) {
    if (headTree.get(path) !== baseTree.get(path)) out.push(path);
  }
  return out.sort();
}

function rawGitObject(objects: Map<string, unknown>, sha: string): Buffer | null {
  const value = objects.get(sha);
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (isRecord(value)) {
    // The Store's GitObject shape: { type, data } with headerless content.
    const data = value.data;
    if (Buffer.isBuffer(data)) return data;
    if (typeof data === 'string') return Buffer.from(data, 'utf8');
    if (data instanceof Uint8Array) return Buffer.from(data);
  }
  return null;
}

/** Strip a "<type> <len>\0" header when present; otherwise the bytes are the content. */
function gitContent(raw: Buffer): Buffer {
  const nul = raw.indexOf(0);
  if (nul < 0 || nul > 32) return raw;
  const header = raw.subarray(0, nul).toString('utf8');
  if (/^(blob|tree|commit|tag) \d+$/.test(header)) return raw.subarray(nul + 1);
  return raw;
}

function treePaths(objects: Map<string, unknown>, commitSha: string): Map<string, string> | null {
  const commit = rawGitObject(objects, commitSha);
  if (commit === null) return null;
  const body = gitContent(commit).toString('utf8');
  const match = /^tree ([0-9a-f]{40})/m.exec(body);
  if (match === null) return null;
  return readTree(objects, match[1] as string, '');
}

function readTree(objects: Map<string, unknown>, treeSha: string, prefix: string): Map<string, string> | null {
  const raw = rawGitObject(objects, treeSha);
  if (raw === null) return null;
  const content = gitContent(raw);
  const out = new Map<string, string>();
  let pos = 0;
  while (pos < content.length) {
    const space = content.indexOf(0x20, pos);
    if (space < 0) break;
    const mode = content.subarray(pos, space).toString('utf8');
    const nameEnd = content.indexOf(0, space + 1);
    if (nameEnd < 0) break;
    const name = content.subarray(space + 1, nameEnd).toString('utf8');
    if (nameEnd + 21 > content.length) break;
    const sha = content.subarray(nameEnd + 1, nameEnd + 21).toString('hex');
    pos = nameEnd + 21;
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (mode === '40000' || mode === '040000') {
      const sub = readTree(objects, sha, path);
      if (sub !== null) {
        for (const [key, value] of sub) out.set(key, value);
      }
    } else {
      out.set(path, sha);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cursors and connections.
// ---------------------------------------------------------------------------

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface ConnectionArgs {
  first?: number;
  after?: string | null;
  states?: string[];
  orderBy?: { field?: string; direction?: string };
}

function connectionArgs(args: Record<string, unknown>): ConnectionArgs {
  const out: ConnectionArgs = {};
  const first = num(args.first);
  if (first !== undefined) out.first = first;
  if (typeof args.after === 'string' || args.after === null) out.after = args.after as string | null;
  if (Array.isArray(args.states)) out.states = args.states.map((entry) => String(entry).toUpperCase());
  if (isRecord(args.orderBy)) {
    out.orderBy = {
      field: str(args.orderBy.field, 'CREATED_AT'),
      direction: str(args.orderBy.direction, 'DESC'),
    };
  }
  return out;
}

/** Sort issues CREATED_AT/UPDATED_AT with ties by number, in the asked direction. */
function sortIssues(issues: IssueRecord[], orderBy: { field?: string; direction?: string } | undefined): IssueRecord[] {
  const field = str(orderBy?.field, 'CREATED_AT').toUpperCase();
  const dir = str(orderBy?.direction, 'DESC').toUpperCase() === 'ASC' ? 1 : -1;
  return [...issues].sort((a, b) => {
    const ra = rec(a);
    const rb = rec(b);
    let cmp = 0;
    if (field === 'UPDATED_AT') cmp = str(ra.updated_at, '').localeCompare(str(rb.updated_at, ''));
    else if (field !== 'COMMENTS') cmp = str(ra.created_at, '').localeCompare(str(rb.created_at, ''));
    if (cmp === 0) cmp = (num(ra.number) ?? 0) - (num(rb.number) ?? 0);
    return cmp * dir;
  });
}

function issueConnectionSource(state: RepoState, args: Record<string, unknown>): Source {
  const parsed = connectionArgs(args);
  let list = repoIssues(state);
  if (parsed.states !== undefined && parsed.states.length > 0) {
    const want = new Set(parsed.states.map((entry) => (entry === 'OPEN' ? 'open' : 'closed')));
    list = list.filter((issue) => want.has(str(rec(issue).state, 'open').toLowerCase()));
  }
  const sorted = sortIssues(list, parsed.orderBy);
  let start = 0;
  if (typeof parsed.after === 'string' && parsed.after !== '') {
    const cursorNumber = decodeCursor(parsed.after);
    if (cursorNumber !== null) {
      const index = sorted.findIndex((issue) => num(rec(issue).number) === cursorNumber);
      if (index >= 0) start = index + 1;
    }
  }
  const page = parsed.first !== undefined ? sorted.slice(start, start + parsed.first) : sorted.slice(start);
  const end = start + page.length;
  return {
    __type: 'IssueConnection',
    state,
    issues: page,
    totalCount: sorted.length,
    hasNextPage: end < sorted.length,
    hasPreviousPage: start > 0,
    startCursor: page.length > 0 ? encodeCursor(num(rec(page[0]).number) ?? 0) : null,
    endCursor: page.length > 0 ? encodeCursor(num(rec(page[page.length - 1]).number) ?? 0) : null,
  };
}

function pullConnectionSource(state: RepoState, args: Record<string, unknown>): Source {
  const parsed = connectionArgs(args);
  let list = repoPulls(state);
  if (parsed.states !== undefined && parsed.states.length > 0) {
    list = list.filter((pull) => {
      const stateName = pullState(pull);
      return parsed.states?.includes(stateName) ?? true;
    });
  }
  const sorted = [...list].sort((a, b) => (num(rec(b).number) ?? 0) - (num(rec(a).number) ?? 0));
  let start = 0;
  if (typeof parsed.after === 'string' && parsed.after !== '') {
    const cursorNumber = decodeCursor(parsed.after);
    if (cursorNumber !== null) {
      const index = sorted.findIndex((pull) => num(rec(pull).number) === cursorNumber);
      if (index >= 0) start = index + 1;
    }
  }
  const page = parsed.first !== undefined ? sorted.slice(start, start + parsed.first) : sorted.slice(start);
  const end = start + page.length;
  return {
    __type: 'PullRequestConnection',
    state,
    pulls: page,
    totalCount: sorted.length,
    hasNextPage: end < sorted.length,
    hasPreviousPage: start > 0,
    startCursor: page.length > 0 ? encodeCursor(num(rec(page[0]).number) ?? 0) : null,
    endCursor: page.length > 0 ? encodeCursor(num(rec(page[page.length - 1]).number) ?? 0) : null,
  };
}

// ---------------------------------------------------------------------------
// Introspection data: the types gh feature-detects, plus the rest of the
// surface this executor answers.
// ---------------------------------------------------------------------------

interface TypeDef {
  kind: string;
  fields: string[];
  fieldTypes?: Record<string, string>;
  enumValues?: string[];
}

const SCALAR_DEF = (name: string): TypeDef => ({ kind: 'SCALAR', fields: [] });

const TYPE_DEFS: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: ['viewer', 'repository', 'node'],
    fieldTypes: { viewer: 'User', repository: 'Repository', node: 'Node' },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
    fieldTypes: {
      createIssue: 'CreateIssuePayload',
      closeIssue: 'CloseIssuePayload',
      createPullRequest: 'CreatePullRequestPayload',
      mergePullRequest: 'MergePullRequestPayload',
      addComment: 'AddCommentPayload',
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
      'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
      'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate',
    ],
    fieldTypes: {
      id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User',
      defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean',
      issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection',
      pullRequest: 'PullRequest', description: 'String', url: 'String',
      createdAt: 'String', updatedAt: 'String', isPrivate: 'Boolean',
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'repository'],
    fieldTypes: {
      id: 'ID', number: 'Int', title: 'String', state: 'IssueState', body: 'String',
      url: 'String', createdAt: 'String', updatedAt: 'String', author: 'User', repository: 'Repository',
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable',
      'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files',
      'url', 'createdAt', 'updatedAt', 'author',
    ],
    fieldTypes: {
      id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'PullRequestState',
      merged: 'Boolean', mergeable: 'MergeableState', headRefName: 'String', baseRefName: 'String',
      headRefOid: 'String', baseRefOid: 'String', files: 'PullRequestChangedFileConnection',
      url: 'String', createdAt: 'String', updatedAt: 'String', author: 'User',
    },
  },
  User: {
    kind: 'OBJECT',
    fields: ['id', 'login', 'name'],
    fieldTypes: { id: 'ID', login: 'String', name: 'String' },
  },
  Ref: {
    kind: 'OBJECT',
    fields: ['name'],
    fieldTypes: { name: 'String' },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'edges', 'pageInfo', 'totalCount'],
    fieldTypes: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'edges', 'pageInfo', 'totalCount'],
    fieldTypes: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  },
  IssueEdge: {
    kind: 'OBJECT',
    fields: ['node', 'cursor'],
    fieldTypes: { node: 'Issue', cursor: 'String' },
  },
  PullRequestEdge: {
    kind: 'OBJECT',
    fields: ['node', 'cursor'],
    fieldTypes: { node: 'PullRequest', cursor: 'String' },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
    fieldTypes: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'edges', 'pageInfo', 'totalCount'],
    fieldTypes: { nodes: 'PullRequestChangedFile', edges: 'PullRequestChangedFileEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: ['path'],
    fieldTypes: { path: 'String' },
  },
  PullRequestChangedFileEdge: {
    kind: 'OBJECT',
    fields: ['node', 'cursor'],
    fieldTypes: { node: 'PullRequestChangedFile', cursor: 'String' },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
    fieldTypes: { id: 'ID', body: 'String', createdAt: 'String', updatedAt: 'String', author: 'User' },
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: ['node', 'cursor'],
    fieldTypes: { node: 'IssueComment', cursor: 'String' },
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: ['issue', 'clientMutationId'],
    fieldTypes: { issue: 'Issue', clientMutationId: 'String' },
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: ['issue', 'clientMutationId'],
    fieldTypes: { issue: 'Issue', clientMutationId: 'String' },
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: ['pullRequest', 'clientMutationId'],
    fieldTypes: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: ['pullRequest', 'clientMutationId'],
    fieldTypes: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: ['commentEdge', 'clientMutationId'],
    fieldTypes: { commentEdge: 'IssueCommentEdge', clientMutationId: 'String' },
  },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', fields: [], enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  RepositoryPermission: { kind: 'ENUM', fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  PullRequestMergeMethod: { kind: 'ENUM', fields: [], enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  Node: { kind: 'INTERFACE', fields: ['id'], fieldTypes: { id: 'ID' } },
  String: SCALAR_DEF('String'),
  Int: SCALAR_DEF('Int'),
  Boolean: SCALAR_DEF('Boolean'),
  ID: SCALAR_DEF('ID'),
};

function typeSource(name: string): Source | null {
  const def = TYPE_DEFS[name];
  if (def === undefined) return null;
  return { __type: '__Type', def };
}

// ---------------------------------------------------------------------------
// GraphQL document parsing (tokenizer + recursive descent). No directives
// other than @skip/@include are evaluated; unknown ones are ignored.
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '"') {
      if (src[i + 1] === '"' && src[i + 2] === '"') {
        let j = i + 3;
        let out = '';
        while (j < src.length && !(src[j] === '"' && src[j + 1] === '"' && src[j + 2] === '"')) {
          out += src[j] as string;
          j += 1;
        }
        tokens.push({ kind: 'string', value: out });
        i = j + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1] as string;
          const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };
          if (e === 'u' && j + 5 < src.length) {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += escapes[e] ?? e;
            j += 2;
          }
          continue;
        }
        out += src[j] as string;
        j += 1;
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!=$@[]|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface DirectiveNode {
  name: string;
  args: Record<string, ValueNode>;
}

type SelectionNode =
  | { kind: 'field'; name: string; alias: string; args: Record<string, ValueNode>; directives: DirectiveNode[]; selections: SelectionNode[] }
  | { kind: 'inline'; typeCondition: string | null; directives: DirectiveNode[]; selections: SelectionNode[] }
  | { kind: 'spread'; name: string; directives: DirectiveNode[] };

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, { defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Record<string, FragmentNode>;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(src: string) {
    this.tokens = tokenize(src);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}" in GraphQL document, got ${token.kind} ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected name${value === undefined ? '' : ` "${value}"`} in GraphQL document, got ${token.kind} ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private atName(value?: string): boolean {
    const token = this.peek();
    return token.kind === 'name' && (value === undefined || token.value === value);
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: {} };
    while (this.peek().kind !== 'eof') {
      if (this.atName('fragment')) {
        const fragment = this.parseFragment();
        doc.fragments[fragment.name] = fragment;
      } else {
        doc.operations.push(this.parseOperation());
      }
    }
    return doc;
  }

  private parseFragment(): FragmentNode {
    this.expectName('fragment');
    const name = this.expectName();
    this.expectName('on');
    const typeCondition = this.expectName();
    this.parseDirectives();
    return { name, typeCondition, selections: this.parseSelectionSet() };
  }

  private parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    if (this.atName('query') || this.atName('mutation')) {
      kind = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables: Record<string, { defaultValue: ValueNode | null }> = {};
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.atPunct('=')) {
          this.next();
          defaultValue = this.parseValue();
        }
        variables[varName] = { defaultValue };
        if (this.peek().kind === 'eof') throw new Error('unterminated variable definitions in GraphQL document');
      }
      this.expectPunct(')');
    }
    this.parseDirectives();
    return { kind, name, variables, selections: this.parseSelectionSet() };
  }

  /** Skip a type reference (Name, [..], !) — only its presence matters here. */
  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.atPunct('@')) {
      this.next();
      const name = this.expectName();
      let args: Record<string, ValueNode> = {};
      if (this.atPunct('(')) args = this.parseArguments();
      directives.push({ name, args });
    }
    return directives;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set in GraphQL document');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.atPunct('...')) {
      this.next();
      if (this.atName('on')) {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        return { kind: 'inline', typeCondition, directives, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'spread', name, directives };
      }
      const directives = this.parseDirectives();
      return { kind: 'inline', typeCondition: null, directives, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let name = first;
    let alias = first;
    if (this.atPunct(':')) {
      this.next();
      name = this.expectName();
    }
    let args: Record<string, ValueNode> = {};
    if (this.atPunct('(')) args = this.parseArguments();
    const directives = this.parseDirectives();
    let selections: SelectionNode[] = [];
    if (this.atPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, directives, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    this.expectPunct('(');
    const args: Record<string, ValueNode> = {};
    while (!this.atPunct(')')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated arguments in GraphQL document');
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$') {
      this.next();
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) {
        if (this.peek().kind === 'eof') throw new Error('unterminated list in GraphQL document');
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.next();
      const fields: Record<string, ValueNode> = {};
      while (!this.atPunct('}')) {
        if (this.peek().kind === 'eof') throw new Error('unterminated input object in GraphQL document');
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int' || token.kind === 'float') {
      this.next();
      return { kind: 'literal', value: Number(token.value) };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'literal', value: token.value };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'literal', value: token.value };
    }
    throw new Error(`unexpected token ${token.kind} ${JSON.stringify(token.value)} in GraphQL document`);
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'literal':
      return node.value;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = evalValue(value, variables);
      return out;
    }
  }
}

function evalArgs(args: Record<string, ValueNode>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = evalValue(value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------

interface Source {
  __type: string;
  [key: string]: unknown;
}

interface GraphQLContext {
  store: Store;
  fragments: Record<string, FragmentNode>;
  errors: Array<{ message: string; path?: (string | number)[] }>;
}

type Resolver = (source: Source, args: Record<string, unknown>, ctx: GraphQLContext) => unknown | Promise<unknown>;

function isSource(value: unknown): value is Source {
  return isRecord(value) && typeof value.__type === 'string';
}

function directivesSkip(directives: DirectiveNode[], variables: Record<string, unknown>): boolean {
  for (const directive of directives) {
    if (directive.name === 'skip') {
      const value = evalValue(directive.args.if as ValueNode, variables);
      if (value === true) return true;
    }
    if (directive.name === 'include') {
      const value = evalValue(directive.args.if as ValueNode, variables);
      if (value === false) return true;
    }
  }
  return false;
}

async function executeSelections(
  typeName: string,
  source: Source,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  ctx: GraphQLContext,
  path: (string | number)[],
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const fields = RESOLVERS[typeName] ?? {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      if (directivesSkip(selection.directives, variables)) continue;
      const fragment = ctx.fragments[selection.name];
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      if (fragment.typeCondition !== typeName) continue;
      Object.assign(out, await executeSelections(typeName, source, fragment.selections, variables, ctx, path));
      continue;
    }
    if (selection.kind === 'inline') {
      if (directivesSkip(selection.directives, variables)) continue;
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      Object.assign(out, await executeSelections(typeName, source, selection.selections, variables, ctx, path));
      continue;
    }
    if (directivesSkip(selection.directives, variables)) continue;
    if (selection.name === '__typename') {
      out[selection.alias] = typeName;
      continue;
    }
    const resolver = fields[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({
        message: `Cannot query field "${selection.name}" on type "${typeName}".`,
        path: [...path, selection.alias],
      });
      out[selection.alias] = null;
      continue;
    }
    let value: unknown;
    try {
      value = await resolver(source, evalArgs(selection.args, variables), ctx);
    } catch (err) {
      ctx.errors.push({
        message: err instanceof Error ? err.message : String(err),
        path: [...path, selection.alias],
      });
      out[selection.alias] = null;
      continue;
    }
    out[selection.alias] = await completeValue(value, selection.selections, variables, ctx, [...path, selection.alias]);
  }
  return out;
}

async function completeValue(
  value: unknown,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  ctx: GraphQLContext,
  path: (string | number)[],
): Promise<unknown> {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      out.push(await completeValue(value[index], selections, variables, ctx, [...path, index]));
    }
    return out;
  }
  if (isSource(value)) {
    if (selections.length === 0) return null;
    return executeSelections(value.__type, value, selections, variables, ctx, path);
  }
  if (isRecord(value)) {
    if (selections.length === 0) return value;
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind !== 'field') continue;
      out[selection.alias] = await completeValue(value[selection.name], selection.selections, variables, ctx, [...path, selection.alias]);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Field resolvers.
// ---------------------------------------------------------------------------

function userSource(login: string): Source {
  return { __type: 'User', login };
}

function repoSource(state: RepoState): Source {
  return { __type: 'Repository', state };
}

function issueSource(state: RepoState, issue: IssueRecord): Source {
  return { __type: 'Issue', state, issue };
}

function pullSource(state: RepoState, pull: PullRecord): Source {
  return { __type: 'PullRequest', state, pull };
}

function pageInfoSource(source: Source): Source {
  return {
    __type: 'PageInfo',
    hasNextPage: bool(source.hasNextPage, false),
    hasPreviousPage: bool(source.hasPreviousPage, false),
    startCursor: (source.startCursor as string | null) ?? null,
    endCursor: (source.endCursor as string | null) ?? null,
  };
}

const queryResolvers: Record<string, Resolver> = {
  viewer: () => userSource(VIEWER_LOGIN),
  repository: async (_source, args, ctx) => {
    const state = await findRepoState(ctx.store, str(args.owner), str(args.name));
    return state === null ? null : repoSource(state);
  },
  node: async (_source, args, ctx) => {
    const rawId = str(args.id, '');
    if (rawId === '') return null;
    const decoded = decodeNodeId(rawId);
    if (decoded === null) return null;
    if (decoded.kind === 'Repository') {
      const state = await findRepoByNodeId(ctx.store, rawId);
      return state === null ? null : repoSource(state);
    }
    if (decoded.kind === 'Issue') {
      const found = await findIssueByNodeId(ctx.store, rawId);
      return found === null ? null : issueSource(found.state, found.issue);
    }
    if (decoded.kind === 'PullRequest') {
      const found = await findPullByNodeId(ctx.store, rawId);
      return found === null ? null : pullSource(found.state, found.pull);
    }
    if (decoded.kind === 'User') return decoded.id === VIEWER.id ? userSource(VIEWER_LOGIN) : null;
    return null;
  },
  __type: (_source, args) => typeSource(str(args.name, '')),
  __schema: () => ({ __type: '__Schema' }),
};

const mutationResolvers: Record<string, Resolver> = {
  createIssue: async (_source, args, ctx) => {
    const input = rec(args.input);
    const state = await findRepoByNodeId(ctx.store, str(input.repositoryId, ''));
    if (state === null) throw new Error(`repository not found: ${str(input.repositoryId, '')}`);
    const title = str(input.title, '');
    if (title === '') throw new Error('createIssue requires a title');
    const made = (await ctx.store.createIssue(state, title, str(input.body, ''), [])) as unknown;
    if (isRecord(made) && typeof made.error === 'string') {
      throw new Error(`createIssue failed: ${made.error}${typeof made.label === 'string' ? ` (${made.label})` : ''}`);
    }
    const issue = made as IssueRecord;
    return { __type: 'CreateIssuePayload', issue: issueSource(state, issue), clientMutationId: null };
  },
  closeIssue: async (_source, args, ctx) => {
    const input = rec(args.input);
    const found = await findIssueByNodeId(ctx.store, str(input.issueId, ''));
    if (found === null) throw new Error(`issue not found: ${str(input.issueId, '')}`);
    const updated = (await ctx.store.updateIssue(found.state, num(rec(found.issue).number) ?? 0, { state: 'closed' })) as unknown;
    const issue = (isRecord(updated) ? (updated as IssueRecord) : found.issue) as IssueRecord;
    return { __type: 'CloseIssuePayload', issue: issueSource(found.state, issue), clientMutationId: null };
  },
  createPullRequest: async (_source, args, ctx) => {
    const input = rec(args.input);
    const state = await findRepoByNodeId(ctx.store, str(input.repositoryId, ''));
    if (state === null) throw new Error(`repository not found: ${str(input.repositoryId, '')}`);
    const title = str(input.title, '');
    if (title === '') throw new Error('createPullRequest requires a title');
    const made = (await ctx.store.createPull(
      state,
      title,
      str(input.body, ''),
      str(input.headRefName, ''),
      str(input.baseRefName, ''),
    )) as unknown;
    if (isRecord(made) && typeof made.error === 'string') {
      throw new Error(`createPullRequest failed: ${made.error} (head ${str(input.headRefName, '')}, base ${str(input.baseRefName, '')})`);
    }
    const pull = made as PullRecord;
    return { __type: 'CreatePullRequestPayload', pull: pullSource(state, pull), clientMutationId: null };
  },
  mergePullRequest: async (_source, args, ctx) => {
    const input = rec(args.input);
    const found = await findPullByNodeId(ctx.store, str(input.pullRequestId, ''));
    if (found === null) throw new Error(`pull request not found: ${str(input.pullRequestId, '')}`);
    const method = str(input.mergeMethod, 'MERGE') || 'MERGE';
    const result = await mergePullRequest(ctx.store, found.state, found.pull, method);
    if (!result.ok) throw new Error(result.message || `merge failed (HTTP ${result.status})`);
    const fresh = (await ctx.store.getPull(found.state, num(rec(found.pull).number) ?? 0)) as unknown;
    const pull = (isRecord(fresh) ? (fresh as PullRecord) : found.pull) as PullRecord;
    return { __type: 'MergePullRequestPayload', pull: pullSource(found.state, pull), clientMutationId: null };
  },
  addComment: async (_source, args, ctx) => {
    const input = rec(args.input);
    const body = str(input.body, '');
    if (body === '') throw new Error('addComment requires a body');
    const subjectId = str(input.subjectId, '');
    let found = await findIssueByNodeId(ctx.store, subjectId);
    if (found === null) {
      const pullFound = await findPullByNodeId(ctx.store, subjectId);
      if (pullFound !== null) {
        const issue = repoIssues(pullFound.state).find((entry) => num(rec(entry).number) === num(rec(pullFound.pull).number));
        if (issue !== undefined) found = { state: pullFound.state, issue };
      }
    }
    if (found === null) throw new Error(`comment subject not found: ${subjectId}`);
    const comment = await addCommentToStore(ctx.store, found.state, found.issue, body);
    return {
      __type: 'AddCommentPayload',
      commentEdge: { __type: 'IssueCommentEdge', node: { __type: 'IssueComment', comment }, cursor: null },
      clientMutationId: null,
    };
  },
};

const repositoryResolvers: Record<string, Resolver> = {
  id: (source) => repoNodeId(source.state as RepoState),
  databaseId: (source) => repoNumericId(source.state as RepoState),
  name: (source) => repoName(source.state as RepoState),
  nameWithOwner: (source) => `${repoOwnerLogin(source.state as RepoState)}/${repoName(source.state as RepoState)}`,
  owner: (source) => userSource(repoOwnerLogin(source.state as RepoState)),
  defaultBranchRef: (source) => ({ __type: 'Ref', name: repoDefaultBranch(source.state as RepoState) }),
  viewerPermission: () => 'ADMIN',
  hasIssuesEnabled: () => true,
  description: (source) => str(repoRecord(source.state as RepoState).description, ''),
  url: (source) => `https://github.com/${repoOwnerLogin(source.state as RepoState)}/${repoName(source.state as RepoState)}`,
  createdAt: (source, _args, ctx) => str(repoRecord(source.state as RepoState).created_at, ctx.store.nowIso),
  updatedAt: (source, _args, ctx) => str(repoRecord(source.state as RepoState).updated_at, ctx.store.nowIso),
  isPrivate: (source) => bool(repoRecord(source.state as RepoState).private, false),
  issue: (source, args) => {
    const number = num(args.number);
    const issue = repoIssues(source.state as RepoState).find((entry) => num(rec(entry).number) === number);
    return issue === undefined ? null : issueSource(source.state as RepoState, issue);
  },
  issues: (source, args) => issueConnectionSource(source.state as RepoState, args),
  pullRequests: (source, args) => pullConnectionSource(source.state as RepoState, args),
  pullRequest: (source, args) => {
    const number = num(args.number);
    const pull = repoPulls(source.state as RepoState).find((entry) => num(rec(entry).number) === number);
    return pull === undefined ? null : pullSource(source.state as RepoState, pull);
  },
};

const issueResolvers: Record<string, Resolver> = {
  id: (source) => issueNodeId(source.issue as IssueRecord),
  number: (source) => num(rec(source.issue).number) ?? 0,
  title: (source) => str(rec(source.issue).title, ''),
  state: (source) => issueState(source.issue as IssueRecord),
  body: (source) => str(rec(source.issue).body, ''),
  url: (source) => {
    const state = source.state as RepoState;
    return `https://github.com/${repoOwnerLogin(state)}/${repoName(state)}/issues/${num(rec(source.issue).number) ?? 0}`;
  },
  createdAt: (source, _args, ctx) => str(rec(source.issue).created_at, ctx.store.nowIso),
  updatedAt: (source, _args, ctx) => str(rec(source.issue).updated_at, ctx.store.nowIso),
  author: (source) => userSource(actorLogin(rec(source.issue).user)),
  repository: (source) => repoSource(source.state as RepoState),
};

const pullRequestResolvers: Record<string, Resolver> = {
  id: (source) => pullNodeId(source.pull as PullRecord),
  number: (source) => num(rec(source.pull).number) ?? 0,
  title: (source) => str(rec(source.pull).title, ''),
  body: (source) => str(rec(source.pull).body, ''),
  state: (source) => pullState(source.pull as PullRecord),
  merged: (source) => bool(rec(source.pull).merged, false),
  mergeable: (source) => {
    const value = rec(source.pull).mergeable;
    if (typeof value === 'boolean') return value ? 'MERGEABLE' : 'CONFLICTING';
    const text = str(value, '').toUpperCase();
    return text === 'MERGEABLE' || text === 'CONFLICTING' || text === 'UNKNOWN' ? text : 'UNKNOWN';
  },
  headRefName: (source) => pullHeadRef(source.pull as PullRecord),
  baseRefName: (source) => pullBaseRef(source.pull as PullRecord),
  headRefOid: (source) => pullHeadSha(source.pull as PullRecord),
  baseRefOid: (source) => pullBaseSha(source.pull as PullRecord),
  files: (source, args) => {
    const paths = pullFiles(source.state as RepoState, source.pull as PullRecord);
    const first = num(args.first);
    const sliced = first !== undefined ? paths.slice(0, first) : paths;
    return { __type: 'PullRequestChangedFileConnection', files: sliced, totalCount: paths.length };
  },
  url: (source) => {
    const state = source.state as RepoState;
    return `https://github.com/${repoOwnerLogin(state)}/${repoName(state)}/pull/${num(rec(source.pull).number) ?? 0}`;
  },
  createdAt: (source, _args, ctx) => str(rec(source.pull).created_at, ctx.store.nowIso),
  updatedAt: (source, _args, ctx) => str(rec(source.pull).updated_at, ctx.store.nowIso),
  author: (source) => userSource(actorLogin(rec(source.pull).user)),
};

const userResolvers: Record<string, Resolver> = {
  id: (source) => userNodeId(str(source.login, VIEWER_LOGIN)),
  login: (source) => str(source.login, VIEWER_LOGIN),
  name: (source) => str(source.login, VIEWER_LOGIN),
};

const refResolvers: Record<string, Resolver> = {
  name: (source) => str(source.name, ''),
};

function connectionNodes(source: Source, make: (state: RepoState, record: IssueRecord | PullRecord) => Source): Source[] {
  const state = source.state as RepoState;
  const records = (source.issues ?? source.pulls ?? source.files ?? []) as unknown[];
  if (Array.isArray(source.files)) {
    return (source.files as string[]).map((path) => ({ __type: 'PullRequestChangedFile', path }));
  }
  return (records as Array<IssueRecord | PullRecord>).map((record) => make(state, record));
}

function connectionEdges(source: Source): Source[] {
  const nodes = connectionNodes(source, (state, record) => {
    if (source.__type === 'IssueConnection') return issueSource(state, record as IssueRecord);
    if (source.__type === 'PullRequestConnection') return pullSource(state, record as PullRecord);
    return { __type: 'PullRequestChangedFile', path: String(record) };
  });
  return nodes.map((node) => {
    const number = num(rec(node.issue ?? node.pull).number);
    const cursor = number !== undefined ? encodeCursor(number) : null;
    return { __type: source.__type === 'IssueConnection' ? 'IssueEdge' : source.__type === 'PullRequestConnection' ? 'PullRequestEdge' : 'PullRequestChangedFileEdge', node, cursor };
  });
}

const connectionResolvers: Record<string, Resolver> = {
  nodes: (source) => connectionNodes(source, (state, record) => {
    if (source.__type === 'IssueConnection') return issueSource(state, record as IssueRecord);
    if (source.__type === 'PullRequestConnection') return pullSource(state, record as PullRecord);
    return { __type: 'PullRequestChangedFile', path: String(record) };
  }),
  edges: (source) => connectionEdges(source),
  pageInfo: (source) => pageInfoSource(source),
  totalCount: (source) => num(source.totalCount) ?? 0,
};

const edgeResolvers: Record<string, Resolver> = {
  node: (source) => (source.node as Source | null) ?? null,
  cursor: (source) => (source.cursor as string | null) ?? null,
};

const pageInfoResolvers: Record<string, Resolver> = {
  hasNextPage: (source) => bool(source.hasNextPage, false),
  hasPreviousPage: (source) => bool(source.hasPreviousPage, false),
  startCursor: (source) => (source.startCursor as string | null) ?? null,
  endCursor: (source) => (source.endCursor as string | null) ?? null,
};

const changedFileResolvers: Record<string, Resolver> = {
  path: (source) => str(source.path, ''),
};

const commentResolvers: Record<string, Resolver> = {
  id: (source) => str(rec(source.comment).node_id, str(rec(source.comment).id, '')),
  body: (source) => str(rec(source.comment).body, ''),
  createdAt: (source, _args, ctx) => str(rec(source.comment).created_at, ctx.store.nowIso),
  updatedAt: (source, _args, ctx) => str(rec(source.comment).updated_at, ctx.store.nowIso),
  author: (source) => userSource(actorLogin(rec(source.comment).user)),
};

const payloadResolvers: Record<string, Resolver> = {
  issue: (source) => (source.issue as Source | null) ?? null,
  pullRequest: (source) => (source.pull as Source | null) ?? null,
  commentEdge: (source) => (source.commentEdge as Source | null) ?? null,
  clientMutationId: (source) => (source.clientMutationId as string | null) ?? null,
};

const introspectionTypeResolvers: Record<string, Resolver> = {
  kind: (source) => str(rec(source.def).kind, ''),
  name: (source) => str(rec(source.def).name, ''),
  description: () => '',
  fields: (source) => {
    const def = rec(source.def);
    const fields = Array.isArray(def.fields) ? (def.fields as string[]) : [];
    const fieldTypes = rec(def.fieldTypes);
    return fields.map((name) => ({ __type: '__Field', name, typeName: str(fieldTypes[name], 'String') }));
  },
  enumValues: (source) => {
    const values = rec(source.def).enumValues;
    if (!Array.isArray(values)) return [];
    return (values as string[]).map((name) => ({ __type: '__EnumValue', name }));
  },
  inputFields: () => null,
  interfaces: () => [],
  possibleTypes: () => [],
  ofType: () => null,
};

const introspectionFieldResolvers: Record<string, Resolver> = {
  name: (source) => str(source.name, ''),
  description: () => '',
  args: () => [],
  type: (source) => typeSource(str(source.typeName, 'String')),
};

const introspectionEnumValueResolvers: Record<string, Resolver> = {
  name: (source) => str(source.name, ''),
  description: () => '',
};

const schemaResolvers: Record<string, Resolver> = {
  queryType: () => typeSource('Query'),
  mutationType: () => typeSource('Mutation'),
  subscriptionType: () => null,
  types: () => Object.keys(TYPE_DEFS).map((name) => typeSource(name)).filter((entry): entry is Source => entry !== null),
  directives: () => [],
};

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: queryResolvers,
  Mutation: mutationResolvers,
  Repository: repositoryResolvers,
  Issue: issueResolvers,
  PullRequest: pullRequestResolvers,
  User: userResolvers,
  Ref: refResolvers,
  IssueConnection: connectionResolvers,
  PullRequestConnection: connectionResolvers,
  PullRequestChangedFileConnection: connectionResolvers,
  IssueEdge: edgeResolvers,
  PullRequestEdge: edgeResolvers,
  PullRequestChangedFileEdge: edgeResolvers,
  PageInfo: pageInfoResolvers,
  PullRequestChangedFile: changedFileResolvers,
  IssueComment: commentResolvers,
  IssueCommentEdge: edgeResolvers,
  CreateIssuePayload: payloadResolvers,
  CloseIssuePayload: payloadResolvers,
  CreatePullRequestPayload: payloadResolvers,
  MergePullRequestPayload: payloadResolvers,
  AddCommentPayload: payloadResolvers,
  __Type: introspectionTypeResolvers,
  __Field: introspectionFieldResolvers,
  __EnumValue: introspectionEnumValueResolvers,
  __Schema: schemaResolvers,
};

// ---------------------------------------------------------------------------
// One operation, then the HTTP handler.
// ---------------------------------------------------------------------------

function selectOperation(doc: DocumentNode, operationName: string | null): OperationNode | null {
  if (doc.operations.length === 0) return null;
  if (operationName !== null) {
    return doc.operations.find((operation) => operation.name === operationName) ?? null;
  }
  if (doc.operations.length === 1) return doc.operations[0] as OperationNode;
  return null;
}

async function runOperation(body: unknown, store: Store): Promise<Record<string, unknown>> {
  if (!isRecord(body) || typeof body.query !== 'string') {
    return { data: null, errors: [{ message: 'expected a GraphQL operation with a string query' }] };
  }
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  let doc: DocumentNode;
  try {
    doc = new Parser(body.query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = selectOperation(doc, operationName);
  if (operation === null) {
    return {
      data: null,
      errors: [{ message: operationName !== null ? `unknown operation "${operationName}"` : 'multiple operations in one document require an operationName' }],
    };
  }
  const mergedVariables: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(operation.variables)) {
    if (name in variables) mergedVariables[name] = variables[name];
    else if (definition.defaultValue !== null) mergedVariables[name] = evalValue(definition.defaultValue, mergedVariables);
    else mergedVariables[name] = undefined;
  }
  for (const [name, value] of Object.entries(variables)) {
    if (!(name in mergedVariables)) mergedVariables[name] = value;
  }
  const ctx: GraphQLContext = { store, fragments: doc.fragments, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = await executeSelections(rootType, { __type: rootType }, operation.selections, mergedVariables, ctx, []);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

/**
 * Serve POST /api/graphql. Returns false when the path does not match, so
 * the coordinator can try the next handler.
 */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/api/graphql' && path !== '/api/graphql/') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!isAuthorized(req, store.token ?? '')) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'request body too large' });
    return true;
  }
  const parsed = tryParseJson(raw.toString('utf8'));
  if (!parsed.ok) {
    sendJson(res, 400, { message: 'malformed JSON body' });
    return true;
  }
  const body = parsed.value;
  if (Array.isArray(body)) {
    if (body.length === 0) {
      sendJson(res, 400, { message: 'empty batch' });
      return true;
    }
    const results: unknown[] = [];
    for (const operation of body) results.push(await runOperation(operation, store));
    sendJson(res, 200, results);
    return true;
  }
  if (!isRecord(body)) {
    sendJson(res, 400, { message: 'expected a JSON object' });
    return true;
  }
  sendJson(res, 200, await runOperation(body, store));
  return true;
}
