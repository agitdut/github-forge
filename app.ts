// The forge's HTTP server: one in-memory Store shared by all four surfaces, and a
// dispatcher that tries each surface in turn. main.ts owns the entry <-> env lifecycle
// (bind an ephemeral port, register it, poll /done); this file owns everything the suite
// drives: git smart HTTP, REST v3, GraphQL v4 and MCP.
//
// Dispatch order matters only for the fall-through: every handler answers false fast
// (without touching the request body) when the path is not its own, so a request reaches
// exactly one surface and anything else ends as GitHub's JSON 404.
//
// Determinism note: the Store is created once per process from MAKEFUN_TRIAL_NOW (see
// store.ts); nothing here reads the wall clock or randomness, so a live run and its
// replay serve the same bytes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './src/gitproto.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';
import { Store } from './src/store.ts';
import { pathOf, sendJson } from './src/util.ts';

/** One request, routed to its surface. A handler that answers true owned the request. */
async function dispatch(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}. No auth, as the starter had it.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (await handleRest(req, res, store)) return;
  if (await handleGraphql(req, res, store)) return;
  if (await handleMcp(req, res, store)) return;
  if (await handleGit(req, res, store)) return;

  // Everything else, every method: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void dispatch(req, res, store).catch(() => {
      // A handler must never take the process down with it: answer 500 JSON instead.
      // (The peer may already be gone; sendJson throwing there is equally fine to swallow.)
      try {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } catch {
        // Nothing left to write to.
      }
    });
  });
}
