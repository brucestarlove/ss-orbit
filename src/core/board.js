// Barrel module + startup orchestration.
//
// Startup contract:
//   1. Ensure the registry DB and its schema exist.
//   2. If the registry has zero boards, create a first board under
//      PROJECT_ROOT and seed it. This is the open-source one-command-startup
//      ergonomic — drop into a repo, run the server, get a board.
//   3. Iterate every registry board, ensuring the per-board schema exists
//      and reindexing FTS for that board's DB. No "active board" singleton:
//      each iteration opens its own connection.
//
// Beyond startup this module just re-exports per-domain functions for
// `src/server.js` and `src/mcp-server.js` to consume.

import { existsSync, mkdirSync } from "node:fs";
import "./paths.js";
import { createBoardSchema, createRegistrySchema } from "./db.js";
import { reindexAllTickets } from "./tickets.js";
import { deleteBoard, listBoards, openBoardDb, syncRegistryFromBoardDb } from "./registry.js";
import { provisionRepoBoard } from "./provision-repo-board.js";
import { id, slugify } from "./util.js";
import {
  DATA_DIR,
  EXPORT_DIR,
  BACKUP_DIR,
  PORT,
  PROJECT_ROOT,
  PUBLIC_DIR,
  REGISTRY_DB_PATH,
  ROOT_DIR
} from "./paths.js";

function ensureWorkspace() {
  mkdirSync(DATA_DIR, { recursive: true });
  createRegistrySchema();
}

function ensureFirstBoard() {
  if (listBoards().length > 0) return;
  // Bootstrap a first board under PROJECT_ROOT so the server is useful out of
  // the box. Shared logic with `orbit init` (provision-repo-board.js).
  provisionRepoBoard(PROJECT_ROOT);
}

function ensureSchemaForEveryBoard() {
  for (const row of listBoards()) {
    if (!existsSync(row.db_path)) {
      console.warn(
        `[orbit] Removing stale registry row for "${row.slug}": database file missing (${row.db_path}).`
      );
      deleteBoard(row.id);
      continue;
    }
    const db = openBoardDb(row);
    createBoardSchema(db);
    reindexAllTickets(db);
    syncRegistryFromBoardDb(row, db);
  }
}

ensureWorkspace();
// Reconcile the registry against disk *before* deciding whether to bootstrap a
// first board — otherwise a stale row from a deleted .orbit/ folder makes
// listBoards() non-empty and we never re-seed.
ensureSchemaForEveryBoard();
ensureFirstBoard();

export const boardRuntime = {
  rootDir: ROOT_DIR,
  publicDir: PUBLIC_DIR,
  projectRoot: PROJECT_ROOT,
  dataDir: DATA_DIR,
  registryPath: REGISTRY_DB_PATH,
  exportDir: EXPORT_DIR,
  backupDir: BACKUP_DIR,
  port: PORT
};

export function startupSummary() {
  const rows = listBoards();
  return {
    url: `http://localhost:${PORT}`,
    registryPath: REGISTRY_DB_PATH,
    boardCount: rows.length,
    boardPaths: rows.map((row) => row.db_path)
  };
}

export { localOwnerActor, localAgentActor } from "./auth.js";
export { startSSEStream } from "./events.js";
export { sendEmpty, sendJson, serveStatic } from "./http.js";
export { handleApi } from "./router.js";
export { getBootstrap } from "./bootstrap.js";
export {
  createBoard,
  createBoardEntry,
  getBoardContext,
  insertBoardEntry,
  updateBoard,
  updateBoardEntry,
  boardManual
} from "./boards.js";
export { archiveTicket, createComment, createTicket, deleteTicket, restoreTicket, updateTicket } from "./tickets.js";
export { archivedTicketsForBoard } from "./queries.js";
export { getTicketBlockers, getTicketRelations } from "./relations.js";
export { checkpointTicket, claimNext, completeTicket, getContextPack, readComments, readTicket } from "./agent.js";
export { searchTickets } from "./search.js";
export { exportBoard } from "./snapshots.js";

// Helpers for ad-hoc id/slug minting in callers (e.g. MCP tools that mint
// per-process tokens). Intentionally kept tiny and side-effect-free.
export const mint = { id, slugify };
