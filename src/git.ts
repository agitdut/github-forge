// Pure git object/pack layer: no HTTP, no Store, no git binary, no clock, no randomness.
// Every function here is deterministic: same inputs, same bytes. SHA-1 throughout.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface PersonIdent {
  name: string;
  email: string;
  time: number;
  tz: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: PersonIdent;
  committer: PersonIdent;
  message: string;
}

export const ZERO_OID = '0'.repeat(40);

const HEX40 = /^[0-9a-f]{40}$/;

function isOid(value: string): boolean {
  return HEX40.test(value);
}

/** SHA-1 hex of raw bytes. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** git's object id: SHA-1 over `<type> <len>\0` + data. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** A blob object holding `content` verbatim. */
export function buildBlob(content: Buffer): GitObject {
  return { type: 'blob', data: Buffer.from(content) };
}

function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(isDirMode(a.mode) ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(isDirMode(b.mode) ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes; entries are sorted the way git sorts them. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function formatIdent(ident: PersonIdent): string {
  return `${ident.name} <${ident.email}> ${ident.time} ${ident.tz}`;
}

/** Build a commit object's bytes. `message` is written verbatim after the blank line. */
export function buildCommit(c: {
  tree: string;
  parents: string[];
  author: PersonIdent;
  committer: PersonIdent;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${c.tree}`];
  for (const parent of c.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${formatIdent(c.author)}`, `committer ${formatIdent(c.committer)}`, '');
  return Buffer.from(`${lines.join('\n')}\n${c.message}`, 'utf8');
}

/** Parse `Name <email> <unix> <tz>`; on a malformed line keep the raw text as the name. */
function parseIdent(raw: string): PersonIdent {
  const match = /^(.*) <([^<>]*)> (\d+) ([+-]\d{4})$/.exec(raw);
  if (match === null) return { name: raw, email: '', time: 0, tz: '+0000' };
  return { name: match[1] ?? '', email: match[2] ?? '', time: Number(match[3]), tz: match[4] ?? '+0000' };
}

/** Parse a commit object into its headers and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author: PersonIdent = { name: '', email: '', time: 0, tz: '+0000' };
  let committer: PersonIdent = { name: '', email: '', time: 0, tz: '+0000' };
  for (const line of headerText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = parseIdent(value);
    else if (key === 'committer') committer = parseIdent(value);
    // Any other header (gpgsig, encoding, ...) is not modelled and is dropped on rebuild.
  }
  return { tree, parents, author, committer, message };
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > data.length) throw new Error('tree entry has a truncated object id');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Parse an annotated tag object. `tagger` is null when the tag carries no tagger line. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: PersonIdent | null } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const taggerRaw = headers.get('tagger');
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: taggerRaw === undefined ? null : parseIdent(taggerRaw),
  };
}

// ---------------------------------------------------------------------------------------------
// deltas
// ---------------------------------------------------------------------------------------------

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readPackSizeVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buf.length) throw new Error('pack entry has no size header');
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('pack entry size varint is truncated');
    byte = buf[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buf.length) throw new Error('ofs-delta has no base offset');
  let byte = buf[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('ofs-delta base offset is truncated');
    byte = buf[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA and REF_DELTA.
 * The trailer checksum is verified; any corruption throws.
 * `resolveExternalBase` is consulted for a REF_DELTA base that is not in the pack (a thin
 * pack, as real git clients send on incremental pushes: the base lives on the server).
 * Without it — or when it returns undefined — such a pack is rejected.
 */
export function parsePack(buf: Buffer, resolveExternalBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (buf.length < 32) throw new Error(`pack is ${buf.length} bytes, too short`);
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackSizeVarint(buf, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buf, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buf.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        // Thin pack: the base is not in the pack; ask the caller (the server's objects).
        const external = resolveExternalBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is not in the pack (thin pack unsupported)`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  // Resolve every whole object first, so a REF_DELTA may name a base that appears later
  // in the pack (a forward reference) as well as one before it.
  for (const entry of raw) {
    if (entry.typeCode !== 6 && entry.typeCode !== 7) resolve(entry);
  }
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

/** Encode one object's pack header: the type/size varint the pack format uses. */
function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile v2 from plain objects (no deltas). The trailer is SHA-1 over all prior bytes. */
export function buildPack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// reachability and history
// ---------------------------------------------------------------------------------------------

/** Peel an annotated tag to its target, following tag chains; null when the object is missing. */
function peelToNonTag(objects: Map<string, GitObject>, oid: string): string | null {
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

/**
 * True when `ancestor` is reachable from `oid` by following commit parents (tags peeled).
 * `ancestor === oid` is true; a missing object is false.
 */
export function isAncestor(objects: Map<string, GitObject>, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const start = peelToNonTag(objects, oid);
  const target = peelToNonTag(objects, ancestor);
  if (start === null || target === null) return false;
  if (start === target) return true;
  const seen = new Set<string>();
  const queue: string[] = [start];
  while (queue.length) {
    const current = queue.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = objects.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/**
 * Every object reachable from `tips`: commit -> tree + parents, tree -> entries (gitlinks skipped),
 * tag -> its target. Missing objects are skipped, never thrown.
 */
export function collectReachable(objects: Map<string, GitObject>, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const tip of tips) if (isOid(tip)) queue.push(tip);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue; // a gitlink names a commit the repo does not hold
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

/** Flatten a tree into path -> {oid, mode}; a missing tree is an empty map. */
function flattenTree(objects: Map<string, GitObject>, treeOid: string | null): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  if (treeOid === null) return out;
  const walk = (oid: string, prefix: string): void => {
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isDirMode(entry.mode)) walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Split content into lines; a trailing newline does not make an empty last line. */
function splitLines(content: Buffer): string[] {
  const text = content.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Multiset line diff: [additions, deletions] between two line lists. */
function lineDiff(baseLines: string[], headLines: string[]): [number, number] {
  const baseCounts = new Map<string, number>();
  for (const line of baseLines) baseCounts.set(line, (baseCounts.get(line) ?? 0) + 1);
  const headCounts = new Map<string, number>();
  for (const line of headLines) headCounts.set(line, (headCounts.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  const names = new Set([...baseCounts.keys(), ...headCounts.keys()]);
  for (const name of names) {
    const diff = (headCounts.get(name) ?? 0) - (baseCounts.get(name) ?? 0);
    if (diff > 0) additions += diff;
    else deletions -= diff;
  }
  return [additions, deletions];
}

function blobLines(objects: Map<string, GitObject>, oid: string | null): string[] {
  if (oid === null) return [];
  const object = objects.get(oid);
  if (object === undefined || object.type !== 'blob') return [];
  return splitLines(object.data);
}

/**
 * Compare two trees file by file, in filename order. `baseTreeOid` null means an empty tree.
 * Line counts are a simple multiset diff per line.
 */
export function diffTrees(
  objects: Map<string, GitObject>,
  baseTreeOid: string | null,
  headTreeOid: string,
): Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }> {
  const base = flattenTree(objects, baseTreeOid);
  const head = flattenTree(objects, headTreeOid);
  const names = [...new Set([...base.keys(), ...head.keys()])].sort();
  const out: Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }> = [];
  for (const name of names) {
    const inBase = base.get(name);
    const inHead = head.get(name);
    if (inBase === undefined && inHead !== undefined) {
      const lines = blobLines(objects, inHead.oid);
      out.push({ filename: name, status: 'added', additions: lines.length, deletions: 0 });
    } else if (inBase !== undefined && inHead === undefined) {
      const lines = blobLines(objects, inBase.oid);
      out.push({ filename: name, status: 'removed', additions: 0, deletions: lines.length });
    } else if (inBase !== undefined && inHead !== undefined && inBase.oid !== inHead.oid) {
      const [additions, deletions] = lineDiff(blobLines(objects, inBase.oid), blobLines(objects, inHead.oid));
      out.push({ filename: name, status: 'modified', additions, deletions });
    }
  }
  return out;
}

/** The object at `segments` below `treeOid`, or null when the path does not exist. */
export function treeAtPath(
  objects: Map<string, GitObject>,
  treeOid: string,
  segments: string[],
): { oid: string; mode: string } | null {
  if (segments.length === 0) return { oid: treeOid, mode: '40000' };
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (!isDirMode(entry.mode)) return null;
    current = entry.oid;
  }
  return null;
}

/**
 * Return the oid of a new tree equal to `treeOid` with `segments` set to `blobOid`
 * (`blobOid` null removes the path). Intermediate trees are inserted into `objects`;
 * a directory emptied by a removal is pruned. A null `treeOid` starts from the empty tree.
 */
export function setTreePath(
  objects: Map<string, GitObject>,
  treeOid: string | null,
  segments: string[],
  blobOid: string | null,
): string {
  const putTree = (entries: TreeEntry[]): string => {
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!objects.has(oid)) objects.set(oid, { type: 'tree', data });
    return oid;
  };
  const emptyTreeOid = (): string => putTree([]);

  const apply = (currentOid: string | null, rest: string[]): string | null => {
    const entries: TreeEntry[] = [];
    if (currentOid !== null) {
      const object = objects.get(currentOid);
      if (object !== undefined && object.type === 'tree') entries.push(...parseTree(object.data));
    }
    const name = rest[0]!;
    const at = entries.findIndex((entry) => entry.name === name);
    if (rest.length === 1) {
      if (blobOid === null) {
        if (at >= 0) entries.splice(at, 1);
      } else if (at >= 0) {
        entries[at] = { mode: '100644', name, oid: blobOid };
      } else {
        entries.push({ mode: '100644', name, oid: blobOid });
      }
    } else {
      const childOid = at >= 0 && isDirMode(entries[at]!.mode) ? entries[at]!.oid : null;
      const next = apply(childOid, rest.slice(1));
      if (next === null) {
        if (at >= 0) entries.splice(at, 1);
      } else if (at >= 0) {
        entries[at] = { mode: '40000', name, oid: next };
      } else {
        entries.push({ mode: '40000', name, oid: next });
      }
    }
    if (entries.length === 0) return null;
    return putTree(entries);
  };

  if (segments.length === 0) return treeOid ?? emptyTreeOid();
  const result = apply(treeOid, segments);
  return result ?? emptyTreeOid();
}

/**
 * Create a commit that writes (`content`) or deletes (`content` null) one file on `branch`.
 * The parent is the branch tip (or none); the new commit's author and committer are `author`
 * stamped at `timeSec`; `refs` is updated and the new commit oid is returned.
 */
export function createFileCommit(
  objects: Map<string, GitObject>,
  refs: Map<string, string>,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
  author: PersonIdent,
  timeSec: number,
): string {
  const refName = `refs/heads/${branch}`;
  const tip = refs.get(refName);
  const parents: string[] = tip === undefined ? [] : [tip];
  let baseTree: string | null = null;
  if (tip !== undefined) {
    const tipObject = objects.get(tip);
    if (tipObject !== undefined && tipObject.type === 'commit') baseTree = parseCommit(tipObject.data).tree;
  }
  let blobOid: string | null = null;
  if (content !== null) {
    blobOid = hashObject('blob', content);
    if (!objects.has(blobOid)) objects.set(blobOid, { type: 'blob', data: Buffer.from(content) });
  }
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  const treeOid = setTreePath(objects, baseTree, segments, blobOid);
  const stamped: PersonIdent = { name: author.name, email: author.email, time: timeSec, tz: author.tz };
  const commitData = buildCommit({ tree: treeOid, parents, author: stamped, committer: stamped, message });
  const commitOid = hashObject('commit', commitData);
  if (!objects.has(commitOid)) objects.set(commitOid, { type: 'commit', data: commitData });
  refs.set(refName, commitOid);
  return commitOid;
}
