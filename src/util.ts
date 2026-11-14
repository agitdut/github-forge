// Shared HTTP helpers for the forge's surfaces (REST v3, GraphQL, MCP, git smart HTTP).
// Deliberately small and allocation-light: the timed workloads (2000 sequential issue
// reads, 200 pushes, 50 concurrent shallow clones) punish per-request overhead, and
// everything a reply carries must stay deterministic across a live run and its replay
// (no wall clock, no randomness: request ids are a plain counter).

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** Deterministic, non-empty request id: a counter, never random, so replays match. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** The single header every REST reply carries beside the JSON ones. */
export function requestIdHeaders(): Record<string, string> {
  return { 'x-github-request-id': nextRequestId() };
}

/** Answer one request with a JSON body; `headers` go beside content-type/length. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw). */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The query string of a request URL, or empty when it does not parse (never a throw). */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** The bearer token of an `Authorization: Bearer <token>` header, or null. */
export function getBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/.exec(header);
  return match === null ? null : match[1];
}

/** True when the request carries exactly the token the trial gave this process. */
export function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  if (expectedToken === '') return false;
  return getBearerToken(req) === expectedToken;
}

/** Read a whole request body, up to `maxBytes` (rejects past it). */
export async function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export type JsonParse = { ok: true; value: unknown } | { ok: false };

/** Parse JSON without throwing; `{ok:false}` on any malformed body. */
export function tryParseJson(text: string): JsonParse {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
