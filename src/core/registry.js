// Registry-level operations. No mutable global "active board" state lives
// here: every function either reads from the registry, opens a known
// per-board DB by path, or scans a bounded set of registry rows to locate
// the board that owns a given ticket / state / entry / relation. Callers
// receive `{ board, db }` and pass it down via `ctx`.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBoardSchema, getRegistry, openConnection } from "./db.js";
import { BOARDS_DIR } from "./paths.js";
import { now, slugify } from "./util.js";

export function listBoards() {
  return getRegistry().prepare("SELECT * FROM boards ORDER BY name").all();
}

export function getBoardByRegistryId(boardId) {
  return getRegistry().prepare("SELECT * FROM boards WHERE id = ?").get(boardId);
}

export function getBoardBySlug(slug) {
  return getRegistry().prepare("SELECT * FROM boards WHERE slug = ?").get(slugify(slug));
}

export function getBoardByRepoPath(repoPathNorm) {
  return getRegistry()
    .prepare(
      `SELECT * FROM boards
       WHERE repo_path = ?
       ORDER BY (last_active_at IS NULL) ASC, last_active_at DESC, rowid DESC
       LIMIT 1`
    )
    .get(repoPathNorm);
}

/** Most-recently-active registry row, or null. Used as a tie-breaker for the
 *  bootstrap-default case when no board is specified by the caller. */
export function pickDefaultBoard() {
  return getRegistry()
    .prepare(
      `SELECT * FROM boards
       ORDER BY (last_active_at IS NULL) ASC, last_active_at DESC, rowid DESC
       LIMIT 1`
    )
    .get();
}

export function deleteBoard(boardId) {
  getRegistry().prepare("DELETE FROM boards WHERE id = ?").run(boardId);
}

export function touchBoardActive(boardId) {
  const t = now();
  getRegistry()
    .prepare("UPDATE boards SET last_active_at = ?, updated_at = ? WHERE id = ?")
    .run(t, t, boardId);
}

export function insertBoard(row) {
  const t = row.created_at || now();
  getRegistry()
    .prepare(
      `INSERT INTO boards (id, slug, name, repo_path, db_path, repo_url, default_branch, last_active_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.slug,
      row.name,
      row.repo_path,
      row.db_path,
      row.repo_url || "",
      row.default_branch || "main",
      row.last_active_at || t,
      t,
      row.updated_at || t
    );
}

export function updateBoardMeta(boardId, patch) {
  const sets = [];
  const vals = [];
  for (const k of ["slug", "name", "repo_path", "db_path", "repo_url", "default_branch"]) {
    if (patch[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(patch[k]);
    }
  }
  if (!sets.length) return;
  vals.push(now(), boardId);
  getRegistry()
    .prepare(`UPDATE boards SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...vals);
}

/** Where a new board.db should live: always in the central DATA_DIR/boards/<slug>/ directory.
 *  Falls back to a numeric suffix if the canonical path already exists on disk (orphaned file). */
export function computeNewBoardDbPath(_repoPathNorm, slug) {
  const preferred = join(BOARDS_DIR, slug, "board.db");
  if (!existsSync(preferred)) return preferred;
  for (let i = 2; i < 1000; i++) {
    const alt = join(BOARDS_DIR, `${slug}-${i}`, "board.db");
    if (!existsSync(alt)) return alt;
  }
  return preferred; // callers will handle any existing file
}

/** Create the directory + file and apply the per-board schema. Returns the
 *  open connection. */
export function ensureBoardDbFileAndSchema(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const conn = openConnection(dbPath);
  createBoardSchema(conn);
  return conn;
}

/** Open the connection for a registry row. */
export function openBoardDb(boardRow) {
  return openConnection(boardRow.db_path);
}

// Whitelisted table names — these come from our own call sites, never user
// input, but interpolating into SQL is only safe because of this guard.
const ROW_OWNER_TABLES = new Set(["tickets", "states", "board_entries", "relations"]);

/**
 * Find which registry board's DB contains a row with `id` in `table`. Pure:
 * opens one db per candidate to probe and returns `{ board, db }` (no global
 * side effects). If `hintBoardId` is supplied it's checked first to avoid a
 * full scan across every registered board.
 */
function findBoardForRow(table, rowId, hintBoardId = null) {
  if (!ROW_OWNER_TABLES.has(table)) throw new Error(`unsupported owner table: ${table}`);
  const probe = `SELECT 1 FROM ${table} WHERE id = ?`;
  if (hintBoardId) {
    const hint = getBoardByRegistryId(hintBoardId);
    if (hint) {
      const db = openBoardDb(hint);
      if (db.prepare(probe).get(rowId)) return { board: hint, db };
    }
  }
  for (const row of listBoards()) {
    if (hintBoardId && row.id === hintBoardId) continue;
    const db = openBoardDb(row);
    if (db.prepare(probe).get(rowId)) return { board: row, db };
  }
  return null;
}

export const findBoardForTicket = (ticketId, hintBoardId = null) =>
  findBoardForRow("tickets", ticketId, hintBoardId);
export const findBoardForState = (stateId, hintBoardId = null) =>
  findBoardForRow("states", stateId, hintBoardId);
export const findBoardForBoardEntry = (entryId, hintBoardId = null) =>
  findBoardForRow("board_entries", entryId, hintBoardId);
export const findBoardForRelation = (relationId, hintBoardId = null) =>
  findBoardForRow("relations", relationId, hintBoardId);

/** Sync a per-board DB's single boards-row into the registry. Idempotent. */
export function syncRegistryFromBoardDb(boardRow, db) {
  const b = db.prepare("SELECT * FROM boards LIMIT 1").get();
  if (!b) return;

  const reg = getRegistry();
  const t = now();
  const existing = reg.prepare("SELECT id FROM boards WHERE id = ?").get(b.id);
  if (existing) {
    reg
      .prepare(
        `UPDATE boards SET slug = ?, name = ?, db_path = ?, repo_url = ?, default_branch = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(b.slug, b.name, boardRow.db_path, b.repo_url || "", b.default_branch || "main", t, b.id);
    return;
  }

  const existingPath = reg.prepare("SELECT id FROM boards WHERE db_path = ?").get(boardRow.db_path);
  if (existingPath) {
    reg
      .prepare(
        `UPDATE boards SET id = ?, slug = ?, name = ?, repo_path = ?, db_path = ?, repo_url = ?, default_branch = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        b.id,
        b.slug,
        b.name,
        boardRow.repo_path,
        boardRow.db_path,
        b.repo_url || "",
        b.default_branch || "main",
        t,
        existingPath.id
      );
    return;
  }

  insertBoard({
    id: b.id,
    slug: b.slug,
    name: b.name,
    repo_path: boardRow.repo_path,
    db_path: boardRow.db_path,
    repo_url: b.repo_url || "",
    default_branch: b.default_branch || "main",
    last_active_at: t,
    created_at: t,
    updated_at: t
  });
}
