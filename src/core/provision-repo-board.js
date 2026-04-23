// Side-effect-free workspace provisioning for CLI and server startup.
// Do not import board.js from here (that module runs full startup at import time).

import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createBoardSchema, openConnection } from "./db.js";
import {
  computeNewBoardDbPath,
  getBoardByRepoPath,
  insertBoard,
  syncRegistryFromBoardDb
} from "./registry.js";
import { seedIfEmpty } from "./seed.js";
import { normalizePath, now, slugify } from "./util.js";

/**
 * Create or repair the **first** Orbit board for a repo root: `.orbit/board.db`,
 * full seed when empty, and a matching registry row.
 *
 * Idempotent when a registry row already exists for `repo_path`.
 *
 * @param {string} repoPathRaw Absolute or normalized repo directory
 * @returns {{ ok: true, status: "skipped"|"created"|"repaired", registryRow: object|null, message?: string }}
 */
export function provisionRepoBoard(repoPathRaw, options = {}) {
  const repoRoot = normalizePath(repoPathRaw);
  const existingReg = getBoardByRepoPath(repoRoot);
  if (existingReg) {
    return {
      ok: true,
      status: "skipped",
      registryRow: existingReg,
      message: "A board is already registered for this repo path."
    };
  }

  const slugHint = slugify(basename(repoRoot) || "board");
  const dbPath = computeNewBoardDbPath(repoRoot, slugHint);
  mkdirSync(dirname(dbPath), { recursive: true });

  const hadExistingFile = existsSync(dbPath);
  if (hadExistingFile) {
    return provisionExistingDbFile(repoRoot, dbPath, options);
  }

  const db = openConnection(dbPath);
  createBoardSchema(db);
  const seeded = seedIfEmpty(db, repoRoot, { includeExamples: options.includeExamples });
  if (!seeded) {
    const boardMeta = readBoardMetaFromSqlite(db);
    if (!boardMeta) {
      throw new Error("provisionRepoBoard: database file exists but contains no board row.");
    }
    return registerOrphanBoardDb(repoRoot, dbPath, db, boardMeta);
  }

  return insertAfterSeed(repoRoot, dbPath, db, seeded, "created");
}

function provisionExistingDbFile(repoRoot, dbPath, options = {}) {
  const db = openConnection(dbPath);
  createBoardSchema(db);
  const seeded = seedIfEmpty(db, repoRoot, { includeExamples: options.includeExamples });
  if (seeded) {
    return insertAfterSeed(repoRoot, dbPath, db, seeded, "repaired");
  }

  const boardMeta = readBoardMetaFromSqlite(db);
  if (!boardMeta) {
    throw new Error(
      "provisionRepoBoard: .orbit/board.db exists but has no board row — remove or repair the file manually."
    );
  }
  return registerOrphanBoardDb(repoRoot, dbPath, db, boardMeta);
}

function readBoardMetaFromSqlite(db) {
  return db.prepare("SELECT * FROM boards LIMIT 1").get() || null;
}

/**
 * @param {"created"|"repaired"} outcome
 */
function insertAfterSeed(repoRoot, dbPath, db, seeded, outcome) {
  const t = now();
  insertBoard({
    id: seeded.id,
    slug: seeded.slug,
    name: seeded.name,
    repo_path: repoRoot,
    db_path: dbPath,
    repo_url: seeded.repo_url || "",
    default_branch: seeded.default_branch || "main",
    last_active_at: t,
    created_at: t,
    updated_at: t
  });
  const fresh = getBoardByRepoPath(repoRoot);
  if (fresh) syncRegistryFromBoardDb(fresh, db);
  return { ok: true, status: outcome, registryRow: fresh, message: undefined };
}

function registerOrphanBoardDb(repoRoot, dbPath, db, b) {
  const boardRow = { id: b.id, repo_path: repoRoot, db_path: dbPath };
  syncRegistryFromBoardDb(boardRow, db);
  const fresh = getBoardByRepoPath(repoRoot);
  return {
    ok: true,
    status: "repaired",
    registryRow: fresh,
    message: "Registered existing .orbit/board.db with the registry."
  };
}
