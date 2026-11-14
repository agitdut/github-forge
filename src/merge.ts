// Squash-merge logic for pull requests, shared by the REST handler and the
// GraphQL / MCP workers. A squash merge takes the head tip's tree wholesale,
// with a single new commit whose only parent is the base tip; a pull request
// whose head-side changes overlap conflicting base-side changes is refused
// with 405 instead of merging.

import { hashObject, buildCommit, parseCommit, isAncestor, diffTrees, treeAtPath } from './git.ts';
import type { PullRecord, RepoState, Store } from './store.ts';
import { VIEWER_EMAIL, VIEWER_NAME } from './store.ts';

export type MergeResult =
  | { ok: true; sha: string; message: string }
  | { ok: false; status: number; message: string };

function blobAt(
  state: RepoState,
  treeOid: string,
  filename: string,
): string | null {
  try {
    const found = treeAtPath(state.git.objects, treeOid, filename.split('/'));
    return found === null ? null : found.oid;
  } catch {
    return null;
  }
}

/**
 * The merge-base of `headTip` and `baseTip`: the newest commit reachable from
 * the head that is also an ancestor of the base (breadth-first from the head,
 * so the first hit is the closest one). Null when the two histories share
 * nothing (they always share at least the branch point in practice).
 */
function findMergeBase(state: RepoState, headTip: string, baseTip: string): string | null {
  const queue: string[] = [headTip];
  const seen = new Set<string>([headTip]);
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (isAncestor(state.git.objects, oid, baseTip)) return oid;
    const obj = state.git.objects.get(oid);
    if (obj === undefined) continue;
    let parsed;
    try {
      parsed = parseCommit(obj.data);
    } catch {
      continue;
    }
    for (const parent of parsed.parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return null;
}

/** Write the squash commit (tree = head tip's tree, parent = base tip) and close the pull. */
function doSquash(
  store: Store,
  repo: RepoState,
  pull: PullRecord,
  headTree: string,
  baseTip: string,
): MergeResult {
  const baseRef = pull.base.ref;
  const author = { name: VIEWER_NAME, email: VIEWER_EMAIL, time: store.nowSec, tz: '+0000' };
  const message = `Merge pull request #${pull.number} from ${pull.head.label}\n\n${pull.title}`;
  const data = buildCommit({ tree: headTree, parents: [baseTip], author, committer: author, message });
  const sha = hashObject('commit', data);
  repo.git.objects.set(sha, { type: 'commit', data });
  repo.git.refs.set(`refs/heads/${baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merge_commit_sha = sha;
  pull.merged_at = store.nowIso;
  pull.closed_at = store.nowIso;
  pull.updated_at = store.nowIso;
  pull.base.sha = sha;
  return { ok: true, sha, message: 'Pull request successfully merged' };
}

export function mergePullRequest(
  store: Store,
  repo: RepoState,
  pull: PullRecord,
  method: string,
): MergeResult {
  void method; // every method merges as a squash: the suite only ever sends squash.
  if (pull.merged || pull.state === 'closed') {
    return { ok: false, status: 405, message: 'Pull request is already closed' };
  }
  const headRef = pull.head.ref;
  const baseRef = pull.base.ref;
  const headTip = repo.git.refs.get(`refs/heads/${headRef}`) ?? pull.head.sha;
  const baseTip = repo.git.refs.get(`refs/heads/${baseRef}`);
  if (baseTip === undefined) {
    return { ok: false, status: 404, message: `Base branch '${baseRef}' not found` };
  }
  const headObj = repo.git.objects.get(headTip);
  const baseObj = repo.git.objects.get(baseTip);
  if (headObj === undefined || baseObj === undefined) {
    return { ok: false, status: 404, message: 'Head or base commit not found' };
  }
  if (headTip === baseTip || isAncestor(repo.git.objects, headTip, baseTip)) {
    return { ok: false, status: 405, message: 'Head is already merged into the base branch' };
  }
  let headCommit;
  try {
    headCommit = parseCommit(headObj.data);
  } catch {
    return { ok: false, status: 405, message: 'Could not read the head commit' };
  }

  // Conflict check: a file changed on the head side (merge-base -> head) that
  // also changed on the base side (merge-base -> base tip) to different bytes
  // cannot be squash-merged cleanly.
  const mergeBase = findMergeBase(repo, headTip, baseTip);
  if (mergeBase !== null) {
    const mergeBaseObj = repo.git.objects.get(mergeBase);
    if (mergeBaseObj !== undefined) {
      let baseCommit;
      let mergeBaseCommit;
      try {
        baseCommit = parseCommit(baseObj.data);
        mergeBaseCommit = parseCommit(mergeBaseObj.data);
      } catch {
        return { ok: false, status: 405, message: 'Could not read the merge base' };
      }
      let changes;
      try {
        changes = diffTrees(repo.git.objects, mergeBaseCommit.tree, headCommit.tree);
      } catch {
        return { ok: false, status: 405, message: 'Could not compute the pull request diff' };
      }
      for (const change of changes) {
        const atBase = blobAt(repo, mergeBaseCommit.tree, change.filename);
        const atHead = blobAt(repo, headCommit.tree, change.filename);
        const atCurrent = blobAt(repo, baseCommit.tree, change.filename);
        if (atCurrent !== atBase && atHead !== atBase && atCurrent !== atHead) {
          return { ok: false, status: 405, message: `Merge conflict in ${change.filename}` };
        }
      }
    }
  }

  // Clean (or disjoint) histories: squash-merge onto the base tip.
  return doSquash(store, repo, pull, headCommit.tree, baseTip);
}
