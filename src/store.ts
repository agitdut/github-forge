// In-memory store for the git forge: repositories, issues, pull requests, labels,
// comments, file contents and the git object/ref maps. Everything is deterministic:
// ids and numbers are sequential counters, timestamps come from MAKEFUN_TRIAL_NOW
// (never the wall clock), and nothing here uses randomness.

import type { GitObject } from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export interface UserRef {
  login: string;
  id: number;
  node_id: string;
  type: string;
}

export const VIEWER: UserRef = {
  login: VIEWER_LOGIN,
  id: VIEWER_ID,
  node_id: nodeId('User', VIEWER_ID),
  type: 'User',
};

export interface RepoRecord {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  owner: UserRef;
  private: boolean;
  description: string;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  html_url: string;
  url: string;
  clone_url: string;
  git_url: string;
  ssh_url: string;
  homepage: string | null;
  language: string | null;
  forks_count: number;
  stargazers_count: number;
  watchers_count: number;
  open_issues_count: number;
  size: number;
  has_issues: boolean;
  archived: boolean;
  disabled: boolean;
  visibility: string;
  permissions: { admin: boolean; push: boolean; pull: boolean };
}

export interface LabelRecord {
  name: string;
  color: string;
  description: string;
}

export interface IssueRecord {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  user: UserRef;
  labels: LabelRecord[];
  assignee: null;
  locked: boolean;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  url: string;
  repository_url: string;
  labels_url: string;
  comments_url: string;
}

export interface PullRecord {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  merge_commit_sha: string | null;
  merged_at: string | null;
  closed_at: string | null;
  draft: boolean;
  user: UserRef;
  head: { label: string; ref: string; sha: string; user: UserRef; repo: RepoRecord };
  base: { label: string; ref: string; sha: string; user: UserRef; repo: RepoRecord };
  created_at: string;
  updated_at: string;
  html_url: string;
  url: string;
}

export interface CommentRecord {
  id: number;
  node_id: string;
  body: string;
  user: UserRef;
  created_at: string;
  updated_at: string;
}

export interface ContentEntry {
  path: string;
  sha: string;
  content: Buffer;
  commitSha: string;
}

export interface RepoState {
  repo: RepoRecord;
  labels: Map<string, LabelRecord>;
  issues: IssueRecord[];
  pulls: PullRecord[];
  comments: Map<number, CommentRecord[]>;
  contents: Map<string, ContentEntry>;
  git: { objects: Map<string, GitObject>; refs: Map<string, string> };
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
}

/** base64(`${kind}:${id}`), kind in Repository/Issue/PullRequest/User (others allowed). */
export function nodeId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

/** Inverse of nodeId, or null when the value does not decode to `<Kind>:<digits>`. */
export function decodeNodeId(value: string): { kind: string; id: number } | null {
  let text: string;
  try {
    text = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^([A-Za-z]+):([0-9]+)$/.exec(text);
  if (match === null) return null;
  return { kind: match[1] as string, id: Number(match[2]) };
}

/** The trial's fixed "now": MAKEFUN_TRIAL_NOW, or the documented fallback. */
export function trialNowIso(): string {
  const value = process.env.MAKEFUN_TRIAL_NOW;
  return value !== undefined && value !== '' ? value : '2026-11-14T06:30:00.000Z';
}

/** trialNowIso() as whole unix seconds. */
export function trialNowSec(): number {
  const ms = Date.parse(trialNowIso());
  if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  return Math.floor(Date.parse('2026-11-14T06:30:00.000Z') / 1000);
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export class Store {
  readonly nowIso: string;
  readonly nowSec: number;
  readonly token: string;
  readonly repos: Map<string, RepoState>;
  private idSeq = 1;

  constructor() {
    this.nowIso = trialNowIso();
    this.nowSec = trialNowSec();
    this.token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    this.repos = new Map<string, RepoState>();
  }

  /** The next globally unique record id (repos, issues, pulls, comments share the counter). */
  nextId(): number {
    const id = this.idSeq;
    this.idSeq += 1;
    return id;
  }

  createRepo(
    name: string,
    opts: { private?: boolean; description?: string; defaultBranch?: string },
  ): RepoState | null {
    if (this.repos.has(repoKey(VIEWER_LOGIN, name))) return null;
    const id = this.nextId();
    const defaultBranch = opts.defaultBranch ?? 'main';
    const fullName = `${VIEWER_LOGIN}/${name}`;
    const repo: RepoRecord = {
      id,
      node_id: nodeId('Repository', id),
      name,
      full_name: fullName,
      owner: VIEWER,
      private: opts.private ?? false,
      description: opts.description ?? '',
      default_branch: defaultBranch,
      created_at: this.nowIso,
      updated_at: this.nowIso,
      pushed_at: this.nowIso,
      html_url: `/${fullName}`,
      url: `/api/v3/repos/${fullName}`,
      clone_url: `/${fullName}.git`,
      git_url: `git:///${fullName}.git`,
      ssh_url: `git@forge:${fullName}.git`,
      homepage: null,
      language: null,
      forks_count: 0,
      stargazers_count: 0,
      watchers_count: 0,
      open_issues_count: 0,
      size: 0,
      has_issues: true,
      archived: false,
      disabled: false,
      visibility: opts.private === true ? 'private' : 'public',
      permissions: { admin: true, push: true, pull: true },
    };
    const state: RepoState = {
      repo,
      labels: new Map<string, LabelRecord>(),
      issues: [],
      pulls: [],
      comments: new Map<number, CommentRecord[]>(),
      contents: new Map<string, ContentEntry>(),
      git: { objects: new Map<string, GitObject>(), refs: new Map<string, string>() },
      issueSeq: 1,
      pullSeq: 1,
      commentSeq: 1,
    };
    this.repos.set(repoKey(VIEWER_LOGIN, name), state);
    return state;
  }

  getRepo(owner: string, name: string): RepoState | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  listViewerRepos(): RepoState[] {
    return [...this.repos.values()];
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  createLabel(
    repo: RepoState,
    name: string,
    color?: string,
    description?: string,
  ): LabelRecord | null {
    if (repo.labels.has(name)) return null;
    const label: LabelRecord = {
      name,
      color: color ?? 'ededed',
      description: description ?? '',
    };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(
    repo: RepoState,
    title: string,
    body: string,
    labels: string[],
  ): IssueRecord | { error: 'bad-label'; label: string } {
    for (const name of labels) {
      if (!repo.labels.has(name)) return { error: 'bad-label', label: name };
    }
    const number = repo.issueSeq;
    repo.issueSeq += 1;
    const id = this.nextId();
    const fullName = repo.repo.full_name;
    const issue: IssueRecord = {
      id,
      node_id: nodeId('Issue', id),
      number,
      title,
      body,
      state: 'open',
      user: VIEWER,
      labels: labels.map((name) => repo.labels.get(name) as LabelRecord),
      assignee: null,
      locked: false,
      comments: 0,
      created_at: this.nowIso,
      updated_at: this.nowIso,
      closed_at: null,
      html_url: `/${fullName}/issues/${number}`,
      url: `/api/v3/repos/${fullName}/issues/${number}`,
      repository_url: `/api/v3/repos/${fullName}`,
      labels_url: `/api/v3/repos/${fullName}/issues/${number}/labels`,
      comments_url: `/api/v3/repos/${fullName}/issues/${number}/comments`,
    };
    repo.issues.push(issue);
    repo.repo.open_issues_count += 1;
    return issue;
  }

  /** O(1): issues are stored in number order, so number n lives at index n - 1. */
  getIssue(repo: RepoState, number: number): IssueRecord | undefined {
    if (!Number.isInteger(number) || number < 1) return undefined;
    const issue = repo.issues[number - 1];
    return issue !== undefined && issue.number === number ? issue : undefined;
  }

  updateIssue(
    repo: RepoState,
    number: number,
    patch: { title?: string; body?: string; state?: 'open' | 'closed' },
  ): IssueRecord | undefined {
    const issue = this.getIssue(repo, number);
    if (issue === undefined) return undefined;
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.state !== undefined && patch.state !== issue.state) {
      if (patch.state === 'closed') {
        issue.state = 'closed';
        issue.closed_at = this.nowIso;
        repo.repo.open_issues_count = Math.max(0, repo.repo.open_issues_count - 1);
      } else {
        issue.state = 'open';
        issue.closed_at = null;
        repo.repo.open_issues_count += 1;
      }
    }
    issue.updated_at = this.nowIso;
    return issue;
  }

  addComment(repo: RepoState, issueNumber: number, body: string): CommentRecord | undefined {
    const issue = this.getIssue(repo, issueNumber);
    if (issue === undefined) return undefined;
    const id = this.nextId();
    const comment: CommentRecord = {
      id,
      node_id: nodeId('IssueComment', id),
      body,
      user: VIEWER,
      created_at: this.nowIso,
      updated_at: this.nowIso,
    };
    const list = repo.comments.get(issueNumber);
    if (list === undefined) repo.comments.set(issueNumber, [comment]);
    else list.push(comment);
    issue.comments += 1;
    return comment;
  }

  listComments(repo: RepoState, issueNumber: number): CommentRecord[] {
    const list = repo.comments.get(issueNumber);
    return list === undefined ? [] : list.slice();
  }

  createPull(
    repo: RepoState,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): PullRecord | { error: 'bad-head' | 'bad-base' } {
    const headSha = repo.git.refs.get(`refs/heads/${headRef}`);
    if (headSha === undefined) return { error: 'bad-head' };
    const baseSha = repo.git.refs.get(`refs/heads/${baseRef}`);
    if (baseSha === undefined) return { error: 'bad-base' };
    const number = repo.pullSeq;
    repo.pullSeq += 1;
    const id = this.nextId();
    const fullName = repo.repo.full_name;
    const pull: PullRecord = {
      id,
      node_id: nodeId('PullRequest', id),
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergeable: true,
      merge_commit_sha: null,
      merged_at: null,
      closed_at: null,
      draft: false,
      user: VIEWER,
      head: { label: `${VIEWER_LOGIN}:${headRef}`, ref: headRef, sha: headSha, user: VIEWER, repo: repo.repo },
      base: { label: `${VIEWER_LOGIN}:${baseRef}`, ref: baseRef, sha: baseSha, user: VIEWER, repo: repo.repo },
      created_at: this.nowIso,
      updated_at: this.nowIso,
      html_url: `/${fullName}/pull/${number}`,
      url: `/api/v3/repos/${fullName}/pulls/${number}`,
    };
    repo.pulls.push(pull);
    return pull;
  }

  /** O(1): pulls are stored in number order, so number n lives at index n - 1. */
  getPull(repo: RepoState, number: number): PullRecord | undefined {
    if (!Number.isInteger(number) || number < 1) return undefined;
    const pull = repo.pulls[number - 1];
    return pull !== undefined && pull.number === number ? pull : undefined;
  }
}
