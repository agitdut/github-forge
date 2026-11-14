// MCP endpoint (POST /mcp) for the github-core-clone-01 forge.
//
// JSON-RPC 2.0 over Streamable HTTP, answered as plain application/json.
// Speaks both eras the suite accepts:
//   - modern 2026-07-28: server/discover answers supportedVersions;
//   - legacy 2025-11-25 and earlier: initialize + notifications/initialized.
// No network, no clock, no randomness, no mutable per-request state: the
// tools list is built once from a frozen constant, so two tools/list calls
// answer byte for byte identically, and concurrent tools/call requests keep
// their own JSON-RPC ids and arguments.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, RepoState, IssueRecord, PullRecord } from './store.ts';
import { VIEWER_LOGIN } from './store.ts';
import { mergePullRequest } from './merge.ts';
import { sendJson, readBody, tryParseJson, pathOf, isAuthorized } from './util.ts';

// ---------------------------------------------------------------------------
// Small helpers.
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
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

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
  return '';
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
  return '';
}

function pullNodeId(pull: PullRecord): string {
  const record = rec(pull);
  if (typeof record.node_id === 'string' && record.node_id !== '') return record.node_id;
  if (typeof record.nodeId === 'string' && record.nodeId !== '') return record.nodeId;
  return '';
}

function issueLabels(issue: IssueRecord): unknown[] {
  const labels = rec(issue).labels;
  return Array.isArray(labels) ? labels : [];
}

// ---------------------------------------------------------------------------
// JSON shapes returned inside tool results (REST-shaped, so the suite's
// cross-surface reads see the same objects, ids unchanged).
// ---------------------------------------------------------------------------

function repoJson(state: RepoState): Record<string, unknown> {
  const record = repoRecord(state);
  const owner = repoOwnerLogin(state);
  const name = repoName(state);
  return {
    id: repoNumericId(state),
    node_id: repoNodeId(state),
    name,
    full_name: `${owner}/${name}`,
    owner: { login: owner },
    private: typeof record.private === 'boolean' ? record.private : false,
    description: str(record.description, ''),
    default_branch: repoDefaultBranch(state),
    html_url: `https://github.com/${owner}/${name}`,
    created_at: str(record.created_at, ''),
    updated_at: str(record.updated_at, ''),
  };
}

function issueJson(state: RepoState, issue: IssueRecord): Record<string, unknown> {
  const record = rec(issue);
  const owner = repoOwnerLogin(state);
  const name = repoName(state);
  const number = num(record.number) ?? 0;
  const user = rec(record.user);
  return {
    id: num(record.id) ?? number,
    node_id: issueNodeId(issue),
    number,
    title: str(record.title, ''),
    body: str(record.body, ''),
    state: str(record.state, 'open'),
    user: { login: typeof user.login === 'string' && user.login !== '' ? user.login : VIEWER_LOGIN },
    labels: issueLabels(issue),
    created_at: str(record.created_at, ''),
    updated_at: str(record.updated_at, ''),
    html_url: `https://github.com/${owner}/${name}/issues/${number}`,
  };
}

function pullJson(state: RepoState, pull: PullRecord): Record<string, unknown> {
  const record = rec(pull);
  const owner = repoOwnerLogin(state);
  const name = repoName(state);
  const number = num(record.number) ?? 0;
  const head = rec(record.head);
  const base = rec(record.base);
  const headRef = str(head.ref, str(record.headRefName, ''));
  const baseRef = str(base.ref, str(record.baseRefName, ''));
  const user = rec(record.user);
  return {
    id: num(record.id) ?? number,
    node_id: pullNodeId(pull),
    number,
    title: str(record.title, ''),
    body: str(record.body, ''),
    state: str(record.state, 'open'),
    merged: typeof record.merged === 'boolean' ? record.merged : false,
    mergeable: typeof record.mergeable === 'boolean' ? (record.mergeable ? 'MERGEABLE' : 'CONFLICTING') : str(record.mergeable, 'UNKNOWN'),
    head: { ref: headRef, sha: str(head.sha, ''), label: `${owner}:${headRef}` },
    base: { ref: baseRef, sha: str(base.sha, ''), label: `${owner}:${baseRef}` },
    user: { login: typeof user.login === 'string' && user.login !== '' ? user.login : VIEWER_LOGIN },
    created_at: str(record.created_at, ''),
    updated_at: str(record.updated_at, ''),
    html_url: `https://github.com/${owner}/${name}/pull/${number}`,
  };
}

// ---------------------------------------------------------------------------
// The tools. One frozen constant, serialized in declaration order every
// time, so tools/list is byte-identical across calls.
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  required: string[];
  inputSchema: Record<string, unknown>;
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, Record<string, string>>,
  required: string[],
): ToolDef {
  return {
    name,
    description,
    required,
    inputSchema: { type: 'object', properties, required },
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  toolDef(
    'create_repo',
    'Create a new repository owned by the viewer.',
    {
      name: { type: 'string', description: 'The name of the repository to create.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
      owner: { type: 'string', description: 'The login that will own the repository (defaults to the viewer).' },
    },
    ['name'],
  ),
  toolDef(
    'get_repo',
    'Get a repository by owner and name.',
    {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      full_name: { type: 'string', description: 'The full name "owner/repo", an alternative to owner and repo.' },
    },
    ['owner', 'repo'],
  ),
  toolDef(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      full_name: { type: 'string', description: 'The full name "owner/repo", an alternative to owner and repo.' },
      title: { type: 'string', description: 'The title of the issue.' },
      body: { type: 'string', description: 'The body of the issue.' },
    },
    ['owner', 'repo', 'title'],
  ),
  toolDef(
    'list_issues',
    'List the issues of a repository.',
    {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      full_name: { type: 'string', description: 'The full name "owner/repo", an alternative to owner and repo.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    ['owner', 'repo'],
  ),
  toolDef(
    'create_pull_request',
    'Create a pull request in a repository.',
    {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      full_name: { type: 'string', description: 'The full name "owner/repo", an alternative to owner and repo.' },
      title: { type: 'string', description: 'The title of the pull request.' },
      body: { type: 'string', description: 'The body of the pull request.' },
      head: { type: 'string', description: 'The head branch of the pull request.' },
      base: { type: 'string', description: 'The base branch of the pull request.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  toolDef(
    'merge_pull_request',
    'Merge a pull request in a repository.',
    {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      full_name: { type: 'string', description: 'The full name "owner/repo", an alternative to owner and repo.' },
      pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
]);

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

// ---------------------------------------------------------------------------
// JSON-RPC plumbing.
// ---------------------------------------------------------------------------

class RpcError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function toolResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/** Resolve owner/repo from the arguments, accepting full_name as an alternative. */
function ownerRepoOf(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = str(args.owner, str(args.owner_login, ''));
  let repo = str(args.repo, str(args.repository, str(args.repo_name, '')));
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      if (owner === '') owner = parts[0] as string;
      if (repo === '') repo = parts[1] as string;
    }
  }
  return { owner, repo };
}

async function getRepoState(store: Store, owner: string, repo: string): Promise<RepoState> {
  if (owner === '' || repo === '') throw new RpcError(-32602, 'Missing required argument(s): owner, repo');
  const state = (await store.getRepo(owner, repo)) as unknown;
  if (state === null || state === undefined) throw new RpcError(-32602, `Repository not found: ${owner}/${repo}`);
  return state as RepoState;
}

// ---------------------------------------------------------------------------
// tools/call implementations. Each works only on its own arguments and the
// shared Store; nothing is kept in module-level mutable state.
// ---------------------------------------------------------------------------

async function callCreateRepo(store: Store, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const name = str(args.name, '');
  if (name === '') throw new RpcError(-32602, 'Missing required argument: name');
  const owner = str(args.owner, '') || VIEWER_LOGIN;
  void owner;
  let state: unknown;
  try {
    state = await store.createRepo(name, {
      private: args.private === true,
      description: str(args.description, ''),
    });
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  if (state === null || state === undefined) return toolError(`Repository already exists: ${name}`);
  const repoState = isRecord(state) && isRecord((state as Record<string, unknown>).repo)
    ? (state as unknown as RepoState)
    : (state as RepoState);
  return toolResult(repoJson(repoState));
}

async function callGetRepo(store: Store, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { owner, repo } = ownerRepoOf(args);
  const state = await getRepoState(store, owner, repo);
  return toolResult(repoJson(state));
}

async function callCreateIssue(store: Store, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { owner, repo } = ownerRepoOf(args);
  const title = str(args.title, '');
  if (title === '') throw new RpcError(-32602, 'Missing required argument: title');
  const state = await getRepoState(store, owner, repo);
  let issue: unknown;
  try {
    issue = await store.createIssue(state, title, str(args.body, ''), []);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  if (isRecord(issue) && typeof issue.error === 'string') {
    return toolError(`create_issue failed: ${String(issue.error)}${typeof issue.label === 'string' ? ` (${String(issue.label)})` : ''}`);
  }
  return toolResult(issueJson(state, issue as IssueRecord));
}

async function callListIssues(store: Store, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { owner, repo } = ownerRepoOf(args);
  const state = await getRepoState(store, owner, repo);
  const wanted = str(args.state, 'open').toLowerCase();
  const issues = repoIssues(state).filter((issue) => {
    if (wanted === 'all') return true;
    if (wanted === 'closed') return str(rec(issue).state, 'open').toLowerCase() === 'closed';
    return str(rec(issue).state, 'open').toLowerCase() !== 'closed';
  });
  return toolResult(issues.map((issue) => issueJson(state, issue)));
}

async function callCreatePullRequest(store: Store, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { owner, repo } = ownerRepoOf(args);
  const title = str(args.title, '');
  const head = str(args.head, str(args.head_ref, ''));
  const base = str(args.base, str(args.base_ref, ''));
  if (title === '' || head === '' || base === '') {
    throw new RpcError(-32602, 'Missing required argument(s): title, head, base');
  }
  const state = await getRepoState(store, owner, repo);
  let pull: unknown;
  try {
    pull = await store.createPull(state, title, str(args.body, ''), head, base);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  if (isRecord(pull) && typeof pull.error === 'string') {
    return toolError(`create_pull_request failed: ${String(pull.error)} (head ${head}, base ${base})`);
  }
  return toolResult(pullJson(state, pull as PullRecord));
}

async function callMergePullRequest(store: Store, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { owner, repo } = ownerRepoOf(args);
  const pullNumber = num(args.pull_number);
  if (pullNumber === undefined) throw new RpcError(-32602, 'Missing required argument: pull_number');
  const state = await getRepoState(store, owner, repo);
  const pull = repoPulls(state).find((entry) => num(rec(entry).number) === pullNumber);
  if (pull === undefined) {
    const fetched = (await store.getPull(state, pullNumber)) as unknown;
    if (fetched === null || fetched === undefined) return toolError(`Pull request not found: #${pullNumber}`);
    return toolError(`Pull request not found: #${pullNumber}`);
  }
  let result: { ok: boolean; sha?: string; message: string; status?: number };
  try {
    result = await mergePullRequest(store, state, pull, 'MERGE');
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  if (!result.ok) return toolError(result.message || 'merge failed');
  const fresh = (await store.getPull(state, pullNumber)) as unknown;
  const merged = (isRecord(fresh) ? (fresh as PullRecord) : pull) as PullRecord;
  const out = pullJson(state, merged);
  out.merged = true;
  if (typeof result.sha === 'string') out.sha = result.sha;
  if (typeof result.message === 'string') out.message = result.message;
  return toolResult(out);
}

async function callTool(store: Store, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const name = str(params.name, '');
  const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) throw new RpcError(-32601, `Unknown tool: ${name}`);
  // Resolve owner/repo first (full_name is an accepted alternative), then
  // enforce the tool's required properties on the resolved arguments.
  const resolved: Record<string, unknown> = { ...args };
  if (tool.name !== 'create_repo') {
    const { owner, repo } = ownerRepoOf(args);
    if (owner !== '') resolved.owner = owner;
    if (repo !== '') resolved.repo = repo;
  }
  const missing = tool.required.filter((key) => {
    const value = resolved[key];
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0) throw new RpcError(-32602, `Missing required argument(s): ${missing.join(', ')}`);
  switch (tool.name) {
    case 'create_repo':
      return callCreateRepo(store, resolved);
    case 'get_repo':
      return callGetRepo(store, resolved);
    case 'create_issue':
      return callCreateIssue(store, resolved);
    case 'list_issues':
      return callListIssues(store, resolved);
    case 'create_pull_request':
      return callCreatePullRequest(store, resolved);
    case 'merge_pull_request':
      return callMergePullRequest(store, resolved);
    default:
      throw new RpcError(-32601, `Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Method dispatch.
// ---------------------------------------------------------------------------

async function dispatchMethod(method: string, params: Record<string, unknown>, store: Store): Promise<unknown> {
  if (method === 'server/discover') {
    return {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'A GitHub-compatible git forge: repositories, issues and pull requests over MCP tools.',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    };
  }
  if (method === 'initialize') {
    const requested = str(rec(params).protocolVersion, '');
    const protocolVersion = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
    return {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') {
    return { tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) };
  }
  if (method === 'tools/call') {
    return callTool(store, params);
  }
  if (method.startsWith('notifications/')) return {};
  throw new RpcError(-32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// HTTP handler.
// ---------------------------------------------------------------------------

/**
 * Serve POST /mcp. Returns false when the path does not match, so the
 * coordinator can try the next handler.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/mcp' && path !== '/mcp/') return false;
  if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return true;
  }
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
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body too large' } });
    return true;
  }
  const parsed = tryParseJson(raw.toString('utf8'));
  if (!parsed.ok) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: body is not valid JSON' } });
    return true;
  }
  const body = parsed.value;
  if (!isRecord(body)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: expected a JSON object' } });
    return true;
  }
  // A JSON-RPC notification carries no id: answer HTTP 202 with no body.
  if (!('id' in body) || body.id === undefined) {
    res.writeHead(202);
    res.end();
    return true;
  }
  const id = body.id as string | number | null;
  const method = typeof body.method === 'string' ? body.method : '';
  if (method === '') {
    sendJson(res, 400, { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request: missing method' } });
    return true;
  }
  const params = isRecord(body.params) ? (body.params as Record<string, unknown>) : {};
  try {
    const result = await dispatchMethod(method, params, store);
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  } catch (err) {
    if (err instanceof RpcError) {
      sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: err.code, message: err.message } });
    } else {
      sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
    }
  }
  return true;
}
