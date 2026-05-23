import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { closeConnection, getRegistry, hasConnection, openConnection } from "./db.js";
import { BACKUP_DIR, REGISTRY_DB_PATH } from "./paths.js";
import { now } from "./util.js";

const DEFAULT_RETENTION = 30;
const DEFAULT_AUTO_DELAY_MS = 120_000;
const scheduledBoardBackups = new Map();

function backupsEnabled() {
  return !["0", "false", "off"].includes(String(process.env.ORBIT_AUTO_BACKUPS || "1").toLowerCase());
}

function retentionLimit() {
  const parsed = Number(process.env.ORBIT_BACKUP_RETENTION || DEFAULT_RETENTION);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_RETENTION;
  return Math.floor(parsed);
}

function cleanSegment(value) {
  return String(value || "unknown")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}

function timestampForPath() {
  return now().replace(/[:.]/g, "-");
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function pruneBackups(dir, suffix) {
  if (!existsSync(dir)) return;
  const limit = retentionLimit();
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .reverse();
  for (const stale of files.slice(limit)) {
    unlinkSync(join(dir, stale));
    const manifest = join(dir, `${stale}.json`);
    if (existsSync(manifest)) unlinkSync(manifest);
  }
}

function latestBackupStartsWith(dir, prefix, suffix) {
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((name) => name.startsWith(prefix) && name.endsWith(suffix));
}

function writeBackup(db, targetPath) {
  mkdirSync(dirname(targetPath), { recursive: true });
  db.exec(`VACUUM INTO ${sqlLiteral(targetPath)};`);
}

function writeManifest(targetPath, payload) {
  writeFileSync(`${targetPath}.json`, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function automaticDelayMs() {
  const parsed = Number(process.env.ORBIT_AUTO_BACKUP_DELAY_MS || DEFAULT_AUTO_DELAY_MS);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_AUTO_DELAY_MS;
  return Math.floor(parsed);
}

export function backupBoardDatabase(boardRow, db, reason = "manual", options = {}) {
  if (!backupsEnabled()) return null;
  const boardId = cleanSegment(boardRow.id);
  const slug = cleanSegment(boardRow.slug);
  const dir = join(BACKUP_DIR, "boards", boardId);
  const dayPrefix = `${now().slice(0, 10)}T`;
  if (options.oncePerDay && latestBackupStartsWith(dir, dayPrefix, ".board.db")) return null;

  const filename = `${timestampForPath()}-${cleanSegment(reason)}-${slug}.board.db`;
  const targetPath = join(dir, filename);
  writeBackup(db, targetPath);
  writeManifest(targetPath, {
    kind: "board",
    reason,
    created_at: now(),
    board_id: boardRow.id,
    slug: boardRow.slug,
    name: boardRow.name,
    repo_path: boardRow.repo_path,
    db_path: boardRow.db_path
  });
  pruneBackups(dir, ".board.db");
  return { path: targetPath };
}

export function scheduleAutomaticBoardBackup(boardRow, db) {
  if (!backupsEnabled() || !boardRow?.id || !db) return;
  const existing = scheduledBoardBackups.get(boardRow.id);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    scheduledBoardBackups.delete(boardRow.id);
    const hadBoardConnection = hasConnection(boardRow.db_path);
    const hadRegistryConnection = hasConnection(REGISTRY_DB_PATH);
    const backupDb = openConnection(boardRow.db_path);
    try {
      backupBoardDatabase(boardRow, backupDb, "auto-write");
      backupRegistry("auto-write");
    } catch (error) {
      console.warn(`[orbit] Automatic write backup failed for "${boardRow.slug}": ${error.message}`);
    } finally {
      if (!hadBoardConnection) closeConnection(boardRow.db_path);
      if (!hadRegistryConnection) closeConnection(REGISTRY_DB_PATH);
    }
  }, automaticDelayMs());
  timer.unref?.();
  scheduledBoardBackups.set(boardRow.id, timer);
}

export function cancelAutomaticBoardBackup(boardId) {
  const existing = scheduledBoardBackups.get(boardId);
  if (!existing) return;
  clearTimeout(existing);
  scheduledBoardBackups.delete(boardId);
}

export function backupRegistry(reason = "manual", options = {}) {
  if (!backupsEnabled()) return null;
  const dir = join(BACKUP_DIR, "registry");
  const dayPrefix = `${now().slice(0, 10)}T`;
  if (options.oncePerDay && latestBackupStartsWith(dir, dayPrefix, ".registry.db")) return null;

  const targetPath = join(dir, `${timestampForPath()}-${cleanSegment(reason)}.registry.db`);
  writeBackup(getRegistry(), targetPath);
  writeManifest(targetPath, {
    kind: "registry",
    reason,
    created_at: now()
  });
  pruneBackups(dir, ".registry.db");
  return { path: targetPath };
}
