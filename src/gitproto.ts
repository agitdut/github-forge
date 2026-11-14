// Smart-HTTP git handlers: protocol v2 + v0 upload-pack, v0 receive-pack.
// No git binary, no network, no clock, no randomness: every byte answered here is a
// deterministic function of the store. The wire shape follows the suite's client
// (kit program/env/src/git-client.ts) line for line.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';
import { getBearerToken, pathOf, queryOf, readBody } from './util.ts';
import {
  ZERO_OID,
  buildPack,
  isAncestor,
  parseCommit,
  parsePack,
  parseTag,
  parseTree,
  type GitObject,
} from './git.ts';

/** The only owner the scenario's viewer holds: every other owner is a missing repo. */
const GIT_OWNER = 'adaiversen';
const AGENT = 'github-forge/1.0';

type RepoState = NonNullable<ReturnType<Store['getRepo']>>;

/** A malformed git request: answered 400, never a crash, never a 500. */
class BadGitRequest extends Error {}

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');
const PKT_LINE_MAX = 65520;

/** One pkt-line: 4 hex length bytes (payload + 4) then the payload. */
function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new BadGitRequest('pkt-line payload too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

/** Encode a sequence; 'flush'/'delim' are the control packets. */
function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pkt(item));
  }
  return Buffer.concat(parts);
}

type DecodedPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

interface PacketCursor {
  buf: Buffer;
  pos: number;
}

function makeCursor(buf: Buffer): PacketCursor {
  return { buf, pos: 0 };
}

/**
 * The next packet at the cursor, or null when the buffer is exhausted. Throws BadGitRequest
 * on a malformed header or a truncated packet. The cursor stops just past a flush, so a
 * caller can take the raw bytes that follow it (a receive-pack packfile).
 */
function readPacket(cursor: PacketCursor): DecodedPacket | null {
  const { buf } = cursor;
  if (buf.length - cursor.pos < 4) return null;
  const lengthText = buf.subarray(cursor.pos, cursor.pos + 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) {
    throw new BadGitRequest(`invalid pkt-line length ${JSON.stringify(lengthText)}`);
  }
  const length = Number.parseInt(lengthText, 16);
  if (length === 0) {
    cursor.pos += 4;
    return { kind: 'flush' };
  }
  if (length === 1) {
    cursor.pos += 4;
    return { kind: 'delim' };
  }
  if (length === 2) {
    cursor.pos += 4;
    return { kind: 'response-end' };
  }
  if (length === 3) throw new BadGitRequest('invalid pkt-line length 0003');
  if (length > PKT_LINE_MAX) throw new BadGitRequest(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
  if (cursor.pos + length > buf.length) throw new BadGitRequest('truncated pkt-line');
  const payload = buf.subarray(cursor.pos + 4, cursor.pos + length);
  cursor.pos += length;
  return { kind: 'data', payload };
}

/** Split `pack` bytes into sideband band-1 packets (1 band byte + data, each within the limit). */
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = PKT_LINE_MAX - 4 - 1; // payload room minus the band byte
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    out.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (out.length === 0) out.push(pkt(Buffer.from([1])));
  return out;
}

// ---------------------------------------------------------------------------------------------
// small HTTP helpers
// ---------------------------------------------------------------------------------------------

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendBuffer(res, status, 'application/json; charset=utf-8', Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// ref helpers
// ---------------------------------------------------------------------------------------------

function sortedRefNames(refs: Map<string, string>): string[] {
  return [...refs.keys()].sort();
}

function isAnnotatedTag(objects: Map<string, GitObject>, oid: string): boolean {
  const object = objects.get(oid);
  return object !== undefined && object.type === 'tag';
}

/** Peel annotated tags to the first non-tag object; null when missing or cyclic. */
function peelTag(objects: Map<string, GitObject>, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = objects.get(current);
    if (object === undefined) return null;
    if (object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function v0Advertisement(state: RepoState, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const objects = state.git.objects;
  const refs = state.git.refs;
  const defaultBranch = state.repo.default_branch;
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${defaultBranch} side-band-64k thin-pack ofs-delta shallow multi_ack_detailed agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const names = sortedRefNames(refs);
  if (names.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    let first = true;
    const emit = (line: string): void => {
      parts.push(pkt(first ? `${line}\u0000${caps}\n` : `${line}\n`));
      first = false;
    };
    emit(`${refs.get(`refs/heads/${defaultBranch}`) ?? ZERO_OID} HEAD`);
    for (const name of names) {
      const oid = refs.get(name)!;
      emit(`${oid} ${name}`);
      if (isAnnotatedTag(objects, oid)) {
        const peeled = peelTag(objects, oid);
        if (peeled !== null && peeled !== oid) emit(`${peeled} ${name}^{}`);
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// ---------------------------------------------------------------------------------------------
// v2 request parsing
// ---------------------------------------------------------------------------------------------

interface V2Request {
  command: string;
  args: string[];
}

/** The data lines of a v2 request body (command first, then arguments; delim is a separator). */
function parseV2Request(body: Buffer): V2Request {
  const cursor = makeCursor(body);
  const lines: string[] = [];
  for (;;) {
    const packet = readPacket(cursor);
    if (packet === null) break;
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (lines.length === 0) throw new BadGitRequest('empty v2 request');
  const first = lines[0]!;
  if (!first.startsWith('command=')) {
    throw new BadGitRequest(`v2 request has no command: ${JSON.stringify(first.slice(0, 40))}`);
  }
  return { command: first.slice('command='.length), args: lines.slice(1) };
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  /** True when the request carried 'done' (the usual single-round fetch). */
  done: boolean;
  /** True when the request carried 'deepen-relative': `deepen N` counts N commits below the
   * client's current shallow boundary, not N from the tip. */
  deepenRelative: boolean;
}

function parseV2FetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], done: false, deepenRelative: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line === 'done') args.done = true;
    else if (line === 'deepen-relative') args.deepenRelative = true;
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not: accepted, no effect.
  }
  return args;
}

// ---------------------------------------------------------------------------------------------
// v0 upload-pack request parsing
// ---------------------------------------------------------------------------------------------

/** Two sections: wants/shallow/deepen, flush, haves/done, flush. */
function parseV0FetchRequest(body: Buffer): FetchArgs {
  const cursor = makeCursor(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], done: false, deepenRelative: false };
  let section = 0;
  let sawAny = false;
  for (;;) {
    const packet = readPacket(cursor);
    if (packet === null) break;
    if (packet.kind === 'flush') {
      section += 1;
      if (section > 1) break;
      continue;
    }
    if (packet.kind !== 'data') continue;
    sawAny = true;
    const line = packet.payload.toString('utf8').split('\u0000')[0]!.replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const oid = line.split(' ')[1] ?? '';
        if (oid !== '') args.wants.push(oid);
      } else if (line.startsWith('shallow ')) {
        args.shallow.push(line.slice(8).trim());
      } else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) args.depth = n;
      } else if (line === 'deepen-relative') {
        args.deepenRelative = true;
      }
      // deepen-since / deepen-not: accepted, no effect (no check sends them).
    } else if (line.startsWith('have ')) {
      args.haves.push(line.slice(5).trim());
    } else if (line === 'done') {
      args.done = true;
    }
  }
  if (!sawAny) throw new BadGitRequest('empty upload-pack request');
  return args;
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

/** Add a tree and everything below it (blobs, subtrees; gitlinks skipped) to `into`. */
function addTreeClosure(objects: Map<string, GitObject>, treeOid: string, into: Set<string>): void {
  const stack: string[] = [treeOid];
  while (stack.length) {
    const oid = stack.pop()!;
    if (into.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    into.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        stack.push(entry.oid);
      }
    }
  }
}

/**
 * The objects a holder of `roots` already has: each root commit plus its tree closure, walking
 * parents — except a commit in `cutParents` (a shallow boundary) contributes itself and its tree
 * only, never its parents.
 */
function closureFromCommits(
  objects: Map<string, GitObject>,
  roots: string[],
  cutParents: Set<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      addTreeClosure(objects, commit.tree, seen);
      if (!cutParents.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      addTreeClosure(objects, oid, seen);
    }
  }
  return seen;
}

/** Commits within `depth` generations of `roots` (distance 0 is the roots); boundary = depth edge. */
function depthLimitedCommits(
  objects: Map<string, GitObject>,
  roots: string[],
  depth: number,
): { commits: Set<string>; boundary: Set<string> } {
  const commits = new Set<string>();
  const boundary = new Set<string>();
  const seen = new Map<string, number>();
  const queue: Array<{ oid: string; dist: number }> = roots.map((oid) => ({ oid, dist: 0 }));
  let head = 0;
  while (head < queue.length) {
    const { oid, dist } = queue[head++]!;
    const prev = seen.get(oid);
    if (prev !== undefined && prev <= dist) continue;
    seen.set(oid, dist);
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    commits.add(oid);
    if (dist >= depth - 1) {
      boundary.add(oid);
      continue;
    }
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, dist: dist + 1 });
  }
  return { commits, boundary };
}

/**
 * Relative deepen (`deepen-relative`): `depth` counts commits below the client's current
 * shallow boundary, not from the tip. The walk has two parts: everything reachable from
 * `roots` without passing an old boundary (`free`, which stops at each boundary commit
 * itself), plus up to `depth` generations below every old boundary reachable from the
 * roots. The new boundary is the set of commits exactly `depth` generations below an old
 * boundary that are not also reachable via a boundary-free path (such a commit's parents
 * are already included through that path, so it is not a cut).
 */
function depthLimitedCommitsRelative(
  objects: Map<string, GitObject>,
  roots: string[],
  oldBoundaries: string[],
  depth: number,
): { commits: Set<string>; boundary: Set<string> } {
  const free = fullCommitClosure(objects, roots, new Set(oldBoundaries));
  const below = new Map<string, number>();
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const boundary of oldBoundaries) {
    if (free.has(boundary)) queue.push({ oid: boundary, dist: 0 });
  }
  let head = 0;
  while (head < queue.length) {
    const { oid, dist } = queue[head++]!;
    const prev = below.get(oid);
    if (prev !== undefined && prev <= dist) continue;
    below.set(oid, dist);
    if (dist >= depth) continue;
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, dist: dist + 1 });
  }
  const commits = new Set<string>(free);
  for (const [oid, dist] of below) {
    if (dist >= 1) commits.add(oid);
  }
  const boundary = new Set<string>();
  for (const [oid, dist] of below) {
    if (dist === depth && !free.has(oid)) boundary.add(oid);
  }
  return { commits, boundary };
}

/** Every commit reachable from `roots` by following parents. A commit in `cutParents` (a
 * shallow boundary) contributes itself but never its parents. */
function fullCommitClosure(objects: Map<string, GitObject>, roots: string[], cutParents: Set<string> = new Set()): Set<string> {
  const commits = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (commits.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    commits.add(oid);
    if (cutParents.has(oid)) continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return commits;
}

interface FetchPlan {
  send: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * What a fetch transfers: the wants' closure (depth-limited when asked) minus what the
 * client already holds. A shallow boundary is a cut in both directions: the client's
 * `shallow` lines stop the haves' closure, and the depth limit draws the new boundary.
 */
function planFetch(objects: Map<string, GitObject>, args: FetchArgs): FetchPlan {
  const sendSet = new Set<string>();
  const peeledCommits: string[] = [];
  for (const want of args.wants) {
    let current = want;
    for (;;) {
      const object = objects.get(current);
      if (object === undefined || object.type !== 'tag') break;
      sendSet.add(current);
      current = parseTag(object.data).object;
    }
    const object = objects.get(current);
    if (object === undefined) continue; // a want the server does not hold transfers nothing
    if (object.type === 'commit') peeledCommits.push(current);
    else sendSet.add(current); // a blob/tree want
  }
  let included: Set<string>;
  let boundary = new Set<string>();
  if (args.depth !== undefined) {
    if (args.deepenRelative && args.shallow.length > 0) {
      const relative = depthLimitedCommitsRelative(objects, peeledCommits, args.shallow, args.depth);
      included = relative.commits;
      boundary = relative.boundary;
    } else {
      const limited = depthLimitedCommits(objects, peeledCommits, args.depth);
      included = limited.commits;
      boundary = limited.boundary;
    }
  } else {
    // Without a depth limit the client's shallow boundaries are still cuts: the wants'
    // closure includes a boundary commit but never its parents (as if it were a have),
    // so a plain fetch from a shallow clone does not silently send the history below
    // the boundary.
    included = fullCommitClosure(objects, peeledCommits, new Set(args.shallow));
  }
  for (const oid of included) {
    sendSet.add(oid);
    addTreeClosure(objects, parseCommit(objects.get(oid)!.data).tree, sendSet);
  }
  const haveSet = closureFromCommits(objects, args.haves, new Set(args.shallow));
  for (const oid of haveSet) sendSet.delete(oid);
  // An old boundary is unshallowed once the traversal actually went past it: it is
  // included and at least one of its parents is included too. A boundary at the depth
  // edge, or one whose parents were never reached, stays shallow.
  const unshallow: string[] = [];
  for (const old of args.shallow) {
    const object = objects.get(old);
    if (object === undefined || object.type !== 'commit') continue;
    if (included.has(old) && parseCommit(object.data).parents.some((parent) => included.has(parent))) {
      unshallow.push(old);
    }
  }
  unshallow.sort();
  const send: GitObject[] = [];
  for (const oid of [...sendSet].sort()) {
    const object = objects.get(oid);
    if (object !== undefined) send.push(object);
  }
  return { send, shallow: [...boundary].sort(), unshallow };
}

// ---------------------------------------------------------------------------------------------
// ls-refs and fetch responses
// ---------------------------------------------------------------------------------------------

function lsRefsResponse(state: RepoState, args: LsRefsArgs): Buffer {
  const objects = state.git.objects;
  const refs = state.git.refs;
  const headRef = `refs/heads/${state.repo.default_branch}`;
  const headTip = refs.get(headRef);
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  if (keep('HEAD')) {
    if (headTip !== undefined) {
      lines.push(args.symrefs ? `${headTip} HEAD symref-target:${headRef}` : `${headTip} HEAD`);
    } else if (args.unborn) {
      lines.push(args.symrefs ? `unborn HEAD symref-target:${headRef}` : 'unborn HEAD');
    }
  }
  for (const name of sortedRefNames(refs)) {
    if (!keep(name)) continue;
    const oid = refs.get(name)!;
    if (oid === ZERO_OID) {
      lines.push(`unborn ${name}`);
      continue;
    }
    let line = `${oid} ${name}`;
    if (args.peel && isAnnotatedTag(objects, oid)) {
      const peeled = peelTag(objects, oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return pktLines([...lines.map((line) => `${line}\n`), 'flush']);
}

/** `<oid> <ref>` for every ref pointing at a want (HEAD excluded; the client only reads refs/*). */
function wantedRefs(state: RepoState, wants: string[]): Array<[string, string]> {
  const wantSet = new Set(wants);
  const out: Array<[string, string]> = [];
  for (const name of sortedRefNames(state.git.refs)) {
    const oid = state.git.refs.get(name)!;
    if (wantSet.has(oid)) out.push([oid, name]);
  }
  return out;
}

function v2FetchResponse(state: RepoState, args: FetchArgs): Buffer {
  const plan = planFetch(state.git.objects, args);
  const pack = buildPack(plan.send);
  const parts: Buffer[] = [];
  if (!args.done) {
    // Multi-round negotiation: the client sent no 'done', so it is in its
    // acknowledgments state and will send another request. Answer NAK + ready
    // (this server has everything it needs for the pack) and send the packfile
    // now, so the fetch completes in this round.
    parts.push(pkt('acknowledgments\n'), pkt('NAK\n'), pkt('ready\n'), DELIM);
  }
  // When 'done' was sent, the client is already in its packfile state
  // (fetch-pack.c FETCH_GET_PACK) and expects no acknowledgments section at
  // all: sending one dies with "expected 'packfile', received
  // 'acknowledgments'". A packfile is sent if and only if 'ready' was sent,
  // and that rule only applies inside an acknowledgments section.
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  const wanted = wantedRefs(state, args.wants);
  if (wanted.length > 0) {
    parts.push(pkt('wanted-refs\n'));
    for (const [oid, name] of wanted) parts.push(pkt(`${oid} ${name}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v0FetchResponse(state: RepoState, args: FetchArgs): Buffer {
  const plan = planFetch(state.git.objects, args);
  const parts: Buffer[] = [];
  // Protocol v0 (fetch-pack.c find_common / consume_shallow_list): the shallow list is
  // only ever read when a depth was asked. With a depth, the client first sends
  // wants+deepen and reads ONLY shallow/unshallow lines up to a flush, then sends
  // haves+done and reads the shallow list again (shallow lines + flush) before NAK.
  // Without a depth the client reads ACK/NAK first (get_ack), so a shallow line there
  // would kill the fetch with "expected ACK/NAK".
  if (args.depth !== undefined) {
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  if (!args.done && args.haves.length === 0) {
    // First round of a deepen negotiation: the shallow list + flush only, no NAK, no pack.
    return Buffer.concat(parts);
  }
  parts.push(pkt('NAK\n'));
  if (!args.done) {
    // Intermediate negotiation round (more haves to come): NAK only, no pack yet.
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  for (const packet of sidebandPackets(buildPack(plan.send))) parts.push(packet);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Command lines up to the flush; everything after it is the raw packfile. */
function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const cursor = makeCursor(body);
  const commands: PushCommand[] = [];
  for (;;) {
    const packet = readPacket(cursor);
    if (packet === null) throw new BadGitRequest('truncated receive-pack command list');
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').split('\u0000')[0]!.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3 || parts[0] === '' || parts[1] === '' || parts[2] === '') {
      throw new BadGitRequest(`bad receive-pack command: ${JSON.stringify(line.slice(0, 60))}`);
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  return { commands, pack: body.subarray(cursor.pos) };
}

/** False when `tip`'s closure names an object the store does not hold. */
function closureComplete(objects: Map<string, GitObject>, tip: string): boolean {
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) return false;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return true;
}

interface PushResultLine {
  ref: string;
  ok: boolean;
  reason: string;
}

interface PushOutcome {
  unpackOk: boolean;
  unpackDetail: string;
  results: PushResultLine[];
}

/**
 * Apply one command list. Objects are merged first; a new tip whose closure is incomplete
 * fails the whole unpack and moves nothing. Per ref: create, delete, or fast-forward only;
 * a refused ref leaves its ref untouched while the accepted ones still apply.
 */
function applyPush(
  state: RepoState,
  commands: PushCommand[],
  packObjects: Map<string, GitObject> | null,
): PushOutcome {
  const objects = state.git.objects;
  const refs = state.git.refs;
  if (packObjects !== null) {
    for (const [oid, object] of packObjects) if (!objects.has(oid)) objects.set(oid, object);
  }
  for (const command of commands) {
    if (command.newOid === ZERO_OID) continue;
    if (!closureComplete(objects, command.newOid)) {
      return {
        unpackOk: false,
        unpackDetail: `error: object ${command.newOid} is missing or incomplete`,
        results: [],
      };
    }
  }
  const results: PushResultLine[] = [];
  for (const command of commands) {
    const current = refs.get(command.ref);
    if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) {
      results.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
      refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'no such ref' });
        continue;
      }
      if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'stale info' });
        continue;
      }
      refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'no such ref' });
      continue;
    }
    if (current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (!isAncestor(objects, command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { unpackOk: true, unpackDetail: 'ok', results };
}

/** report-status inside side-band-64k band 1: the report is itself a pkt-line stream, so it is
 * terminated by a flush packet inside band 1 (a reader that hits the end of the stream without
 * one reports "the remote end hung up"); the outer stream ends with a flush of its own. */
function pushReportResponse(outcome: PushOutcome): Buffer {
  const lines: string[] = [`unpack ${outcome.unpackDetail}\n`];
  for (const result of outcome.results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = pktLines([...lines, 'flush']);
  return Buffer.concat([...sidebandPackets(report), FLUSH]);
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

function gitProtocolVersion(req: IncomingMessage): 2 | 0 {
  const header = req.headers['git-protocol'];
  const value = Array.isArray(header) ? header[0] ?? '' : header ?? '';
  return value.trim() === 'version=2' ? 2 : 0;
}

async function handleGitRoute(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  rest: string,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (rest === 'info/refs' && method !== 'GET') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (rest !== 'info/refs' && method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  // The suite's git client sends Authorization: Bearer <token> on every call; a presented
  // token that is not the trial's is 401. A call with no Authorization header is not refused.
  const presented = getBearerToken(req);
  if (presented !== null && store.token !== '' && presented !== store.token) {
    sendBuffer(res, 401, 'text/plain; charset=utf-8', Buffer.from('unauthorized\n', 'utf8'));
    return;
  }
  if (owner !== GIT_OWNER) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const state = store.getRepo(owner, repoName);
  if (state === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (rest === 'info/refs') {
    const service = queryOf(req).get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 400, { message: 'unknown service' });
      return;
    }
    if (service === 'git-upload-pack' && gitProtocolVersion(req) === 2) {
      sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
    } else {
      sendBuffer(res, 200, `application/x-${service}-advertisement`, v0Advertisement(state, service));
    }
    return;
  }

  const body = await readBody(req);

  if (rest === 'git-upload-pack') {
    if (gitProtocolVersion(req) === 2) {
      const request = parseV2Request(body);
      if (request.command === 'ls-refs') {
        sendBuffer(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(state, parseLsRefsArgs(request.args)));
      } else if (request.command === 'fetch') {
        sendBuffer(res, 200, 'application/x-git-upload-pack-result', v2FetchResponse(state, parseV2FetchArgs(request.args)));
      } else {
        sendJson(res, 400, { message: `unknown command ${request.command}` });
      }
    } else {
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', v0FetchResponse(state, parseV0FetchRequest(body)));
    }
    return;
  }

  // git-receive-pack is v0 only.
  const { commands, pack } = parseReceivePack(body);
  let outcome: PushOutcome;
  if (pack.length === 0) {
    outcome = applyPush(state, commands, null);
  } else {
    let packObjects: Map<string, GitObject> | null = null;
    let unpackError: string | null = null;
    try {
      // Thin packs are normal for incremental pushes: a delta's base may be an object
      // the server already holds rather than one inside the pack.
      packObjects = parsePack(pack, (oid) => state.git.objects.get(oid));
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'pack parse failed';
    }
    outcome =
      unpackError !== null
        ? { unpackOk: false, unpackDetail: `error: ${unpackError}`, results: [] }
        : applyPush(state, commands, packObjects);
  }
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', pushReportResponse(outcome));
}

/**
 * Handle a smart-HTTP git request. Returns false when the path is not a git endpoint
 * (the caller falls through to its own 404); a matched path is always answered here,
 * including a missing repository's 404.
 */
export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const parts = pathOf(req).split('/');
  // ['', owner, '<repo>.git', ...rest]
  if (parts.length < 3 || parts[1] === '' || !parts[2]!.endsWith('.git')) return false;
  const owner = parts[1]!;
  const repoName = parts[2]!.slice(0, -4);
  if (repoName === '') return false;
  const rest = parts.slice(3).join('/');
  if (rest !== 'info/refs' && rest !== 'git-upload-pack' && rest !== 'git-receive-pack') return false;
  try {
    await handleGitRoute(req, res, store, owner, repoName, rest);
  } catch (err) {
    if (!res.writableEnded) {
      const message = err instanceof Error ? err.message : 'internal error';
      if (err instanceof BadGitRequest) sendJson(res, 400, { message });
      else if (message === 'request body too large') sendJson(res, 413, { message });
      else sendJson(res, 500, { message });
    }
  }
  return true;
}
