import { existsSync, rmSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { removeOrbitAgentsSection } from "./agents-md.js";
import { requireBoardAccess } from "./auth.js";
import { backupBoardDatabase, backupRegistry, cancelAutomaticBoardBackup } from "./backups.js";
import { closeConnection } from "./db.js";
import { deleteBoard, listBoards, openBoardDb } from "./registry.js";
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

function isLastBoardForRepo(boardRow) {
  const repoRoot = normalizePath(boardRow.repo_path || "");
  return !listBoards().some((row) => row.id !== boardRow.id && normalizePath(row.repo_path || "") === repoRoot);
}

function repoArtifactTargets(boardRow) {
  const repoRoot = normalizePath(boardRow.repo_path || "");
  const dbPath = normalizePath(boardRow.db_path || "");
  const orbitRoot = normalizePath(join(repoRoot, ".orbit"));
  if (!repoRoot || !dbPath || !isInside(orbitRoot, dbPath) || basename(dbPath) !== "board.db") {
    throw httpError(409, "unsafe_board_db_path");
  }
  return {
    orbitRoot,
    skillMd: join(repoRoot, "SKILL-ORBIT.md")
  };
}

function removeOptions(recursive = false) {
  const options = { force: true };
  if (recursive) options.recursive = true;
  if (process.platform === "win32") {
    options.maxRetries = 10;
    options.retryDelay = 100;
  }
  return options;
}

function isBusyFilesystemError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    ["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code) ||
    (error?.code === "ERR_SQLITE_ERROR" && (message.includes("locked") || message.includes("busy")))
  );
}

function boardFilesBusyError(error, boardRow) {
  if (!isBusyFilesystemError(error)) return error;
  const wrapped = new Error(
    [
      `Orbit could not remove local board files for "${boardRow.slug}".`,
      "On Windows this usually means an Orbit web server, MCP helper, AI client, editor, or terminal still has .orbit/board.db open.",
      "Close those processes, then retry the delete from Settings or run orbit reset --cwd <repo>.",
      `Original error: ${error.message}`
    ].join("\n")
  );
  wrapped.status = 409;
  wrapped.code = "board_files_busy";
  wrapped.cause = error;
  return wrapped;
}

export function deleteRegisteredBoard(boardRow, body, actor) {
  requireBoardAccess(actor, { slug: boardRow.slug });

  const confirmation = String(body?.confirm_slug || "").trim();
  if (confirmation !== boardRow.slug) throw httpError(400, "board_slug_confirmation_required");

  const deleteFiles = body?.delete_files !== false;
  const removeRepoArtifacts = deleteFiles && isLastBoardForRepo(boardRow);
  const repoArtifacts = removeRepoArtifacts ? repoArtifactTargets(boardRow) : null;
  const targets = deleteFiles
    ? removeRepoArtifacts
      ? [repoArtifacts.orbitRoot]
      : boardDbDeleteTargets(boardRow)
    : [];
  const artifactResults = [];
  cancelAutomaticBoardBackup(boardRow.id);
  if (deleteFiles) {
    try {
      backupBoardDatabase(boardRow, openBoardDb(boardRow), "pre-board-delete");
    } catch (error) {
      throw boardFilesBusyError(error, boardRow);
    } finally {
      closeConnection(boardRow.db_path);
    }
  }
  backupRegistry("pre-board-delete");
  closeConnection(boardRow.db_path);

  try {
    for (const target of targets) {
      if (existsSync(target)) {
        rmSync(target, removeOptions(true));
        artifactResults.push({ path: target, removed: true });
      }
    }
    if (repoArtifacts?.skillMd && existsSync(repoArtifacts.skillMd)) {
      rmSync(repoArtifacts.skillMd, removeOptions(false));
      artifactResults.push({ path: repoArtifacts.skillMd, removed: true });
    }
  } catch (error) {
    throw boardFilesBusyError(error, boardRow);
  }
  if (removeRepoArtifacts) {
    const agentsCleanup = removeOrbitAgentsSection(boardRow.repo_path);
    artifactResults.push({
      path: agentsCleanup.path,
      removed: agentsCleanup.removed,
      ok: agentsCleanup.ok,
      reason: agentsCleanup.reason
    });
  }

  deleteBoard(boardRow.id);
  return {
    ok: true,
    deleted_board_id: boardRow.id,
    deleted_board_slug: boardRow.slug,
    deleted_files: deleteFiles,
    deleted_repo_artifacts: removeRepoArtifacts,
    artifacts: artifactResults
  };
}
