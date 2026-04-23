import { existsSync, rmSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { requireBoardAccess } from "./auth.js";
import { backupBoardDatabase, backupRegistry, cancelAutomaticBoardBackup } from "./backups.js";
import { closeConnection } from "./db.js";
import { deleteBoard, openBoardDb } from "./registry.js";
import { httpError, normalizePath } from "./util.js";

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel && !rel.startsWith("..") && !rel.startsWith("/") && rel !== "..";
}

function boardDbDeleteTargets(boardRow) {
  const repoRoot = normalizePath(boardRow.repo_path || "");
  const dbPath = normalizePath(boardRow.db_path || "");
  const orbitRoot = normalizePath(join(repoRoot, ".orbit"));
  if (!repoRoot || !dbPath || !isInside(orbitRoot, dbPath) || basename(dbPath) !== "board.db") {
    throw httpError(409, "unsafe_board_db_path");
  }

  const boardDir = dirname(dbPath);
  const boardsRoot = normalizePath(join(orbitRoot, "boards"));
  const removeBoardDir = isInside(boardsRoot, boardDir);
  if (removeBoardDir) return [boardDir];
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`];
}

export function deleteRegisteredBoard(boardRow, body, actor) {
  requireBoardAccess(actor, { slug: boardRow.slug });

  const confirmation = String(body?.confirm_slug || "").trim();
  if (confirmation !== boardRow.slug) throw httpError(400, "board_slug_confirmation_required");

  const deleteFiles = body?.delete_files !== false;
  const targets = deleteFiles ? boardDbDeleteTargets(boardRow) : [];
  cancelAutomaticBoardBackup(boardRow.id);
  if (deleteFiles) backupBoardDatabase(boardRow, openBoardDb(boardRow), "pre-board-delete");
  backupRegistry("pre-board-delete");
  closeConnection(boardRow.db_path);

  for (const target of targets) {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }

  deleteBoard(boardRow.id);
  return {
    ok: true,
    deleted_board_id: boardRow.id,
    deleted_board_slug: boardRow.slug,
    deleted_files: deleteFiles
  };
}
