/**
 * migrate.js — one-time startup migration of per-board SQLite files from
 * in-repo .orbit/ directories into the central DATA_DIR/boards/<slug>/ store.
 *
 * Called during board.js startup, before ensureSchemaForEveryBoard, so that
 * by the time per-board connections are opened they are already at their
 * canonical central location.
 *
 * If a migration fails the registry row is NOT updated and Orbit continues
 * to serve from the old in-repo path. A structured warning with agent-actionable
 * manual instructions is printed to stderr.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { closeConnection, getRegistry, openConnection } from "./db.js";
import { BOARDS_DIR } from "./paths.js";
import { listBoards } from "./registry.js";

/** Normalize to forward slashes for consistent cross-platform prefix checks. */
const fwd = (p) => p.replace(/\\/g, "/");

/** True when db_path already lives inside the canonical BOARDS_DIR. */
function isCentral(dbPath) {
  return fwd(dbPath).startsWith(fwd(BOARDS_DIR) + "/");
}

/** Canonical central path for a given slug. */
function centralPathFor(slug) {
  return join(BOARDS_DIR, slug, "board.db");
}

/** Delete a file if it exists; silently ignore errors. */
function tryUnlink(p) {
  try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
}

/**
 * Walk upward from startDir, removing each directory that is now empty.
 * Stops at stopDir (inclusive) or the first non-empty directory.
 * This cleans up empty .orbit/ trees left behind after moving the db out.
 */
function pruneEmptyAncestors(startDir, stopDir) {
  const stopFwd = fwd(stopDir);
  let cur = fwd(startDir);
  while (cur.startsWith(stopFwd)) {
    try {
      if (!existsSync(cur)) {
        /* already gone, climb */
      } else if (readdirSync(cur).length > 0) {
        break; // non-empty — stop here
      } else {
        // rmSync({recursive:true, force:true}) works correctly for both files and
        // empty directories across Node versions and platforms.  We've already
        // confirmed the directory is empty so nothing is over-deleted.
        rmSync(cur, { recursive: true, force: true });
      }
    } catch {
      break;
    }
    if (cur === stopFwd) break; // reached the limit
    const parent = fwd(dirname(cur));
    if (parent === cur) break; // filesystem root
    cur = parent;
  }
}

/**
 * For a db path inside a repo's .orbit directory, return the .orbit parent.
 *   /repo/.orbit/board.db          → /repo/.orbit
 *   /repo/.orbit/boards/x/board.db → /repo/.orbit
 * Returns null if ".orbit" is not found in the path.
 */
function orbitParentDir(dbPath) {
  const parts = fwd(dbPath).split("/");
  const idx = parts.lastIndexOf(".orbit");
  if (idx < 0) return null;
  return parts.slice(0, idx + 1).join("/");
}

function sqlLiteral(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Attempt to migrate one board from in-repo storage to central storage.
 * Returns a result object with status: 'migrated' | 'failed' | 'missing_source'.
 */
function migrateOneBoard(boardRow) {
  const { id, slug, db_path: oldPath } = boardRow;

  if (!existsSync(oldPath)) {
    // Source file is gone; ensureSchemaForEveryBoard will prune the stale row.
    return { status: "missing_source", board: boardRow, oldPath };
  }

  const newPath = centralPathFor(slug);
  mkdirSync(dirname(newPath), { recursive: true });

  try {
    // Safety: if the target path is already registered to a *different* board id,
    // skip rather than overwrite live data (guards against corrupted registries with
    // duplicate slugs — cannot happen through normal API use but is defensive).
    const existingOwner = getRegistry().prepare("SELECT id FROM boards WHERE db_path = ?").get(newPath);
    if (existingOwner && existingOwner.id !== id) {
      return {
        status: "failed",
        board: boardRow,
        oldPath,
        newPath,
        error: new Error(
          `central path ${newPath} is already registered to board ${existingOwner.id} — skipping to avoid data loss`
        )
      };
    }

    // Remove any stale central copy left by a previous partial migration.
    if (existsSync(newPath)) tryUnlink(newPath);

    // VACUUM INTO creates a clean, WAL-flushed copy. It captures only committed
    // data and produces a single-file database (no -wal/-shm at the destination).
    const db = openConnection(oldPath);
    db.exec(`VACUUM INTO ${sqlLiteral(newPath)};`);
    closeConnection(oldPath);

    // Update the registry before deleting the source so the canonical pointer is
    // always valid: if the process dies between these two steps the old file still
    // exists and the next run will redo the migration cleanly.
    getRegistry()
      .prepare("UPDATE boards SET db_path = ?, updated_at = ? WHERE id = ?")
      .run(newPath, new Date().toISOString(), id);

    // Remove source files (main db + WAL + SHM + journal).
    tryUnlink(oldPath);
    tryUnlink(oldPath + "-wal");
    tryUnlink(oldPath + "-shm");
    tryUnlink(oldPath + "-journal");

    // Prune now-empty .orbit/ directories from the repo tree.
    const orbitDir = orbitParentDir(oldPath);
    if (orbitDir) pruneEmptyAncestors(dirname(oldPath), orbitDir);

    return { status: "migrated", board: boardRow, oldPath, newPath };
  } catch (error) {
    // Ensure no lingering open connection or partial central file on failure.
    try { closeConnection(oldPath); } catch { /* ignore */ }
    tryUnlink(newPath);
    return { status: "failed", board: boardRow, oldPath, newPath, error };
  }
}

/**
 * Migrate all boards whose db_path lives outside DATA_DIR into central storage.
 * Called at server/MCP startup before any per-board connections are opened.
 * Prints a concise summary for migrated boards; prints agent-actionable
 * instructions for any failures so a human or AI can complete the migration.
 */
export function migrateInRepoBoards() {
  const pending = listBoards().filter((row) => !isCentral(row.db_path));
  if (pending.length === 0) return;

  const results = pending.map(migrateOneBoard);
  const migrated = results.filter((r) => r.status === "migrated");
  const failed = results.filter((r) => r.status === "failed");

  if (migrated.length > 0) {
    const n = migrated.length;
    console.log(`[orbit] Migrated ${n} board${n > 1 ? "s" : ""} to central storage (${BOARDS_DIR}):`);
    for (const r of migrated) {
      console.log(`  ✓ ${r.board.slug}`);
      console.log(`    from: ${r.oldPath}`);
      console.log(`    to:   ${r.newPath}`);
    }
  }

  if (failed.length > 0) {
    const sep = "  │";
    const n = failed.length;
    console.error(`\n[orbit] ⚠ Could not auto-migrate ${n} board${n > 1 ? "s" : ""} to central storage.`);
    console.error(`${sep} These boards continue to work from their current paths.`);
    console.error(`${sep} To complete the migration manually, run the commands below and`);
    console.error(`${sep} restart orbit serve:\n`);
    for (const r of failed) {
      const slash = process.platform === "win32" ? "\\" : "/";
      const destDir = dirname(r.newPath).replace(/\//g, slash);
      const src = r.oldPath.replace(/\//g, slash);
      const dest = r.newPath.replace(/\//g, slash);
      console.error(`${sep} Board: ${r.board.slug}  (error: ${r.error?.message ?? r.error})`);
      if (process.platform === "win32") {
        console.error(`${sep}   md "${destDir}"`);
        console.error(`${sep}   copy "${src}" "${dest}"`);
      } else {
        console.error(`${sep}   mkdir -p '${destDir}'`);
        console.error(`${sep}   cp '${src}' '${dest}'`);
      }
      console.error(sep);
    }
  }
}
