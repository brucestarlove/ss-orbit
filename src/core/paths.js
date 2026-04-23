import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = resolve(__dirname, "..", "..");
// Prefer the pre-built bundle (present in published package); fall back to raw source for dev.
const _distFull = join(ROOT_DIR, "dist", "full");
export const PUBLIC_DIR = existsSync(_distFull) ? _distFull : join(ROOT_DIR, "public");
export const MCP_SERVER_PATH = join(ROOT_DIR, "src", "mcp-server.js");
/** Repo root for default board placement; cwd unless PROJECT_ROOT is set. */
export const PROJECT_ROOT = process.env.PROJECT_ROOT ? resolve(process.env.PROJECT_ROOT) : resolve(process.cwd());
// Store registry + exports in ~/.orbit so global installs don't write into the package dir.
export const DATA_DIR = process.env.DATA_DIR || join(homedir(), ".orbit");
/** Central registry of all boards (metadata + paths to per-board SQLite files). */
export const REGISTRY_DB_PATH = join(DATA_DIR, "registry.db");
export const EXPORT_DIR = join(DATA_DIR, "exports");
export const BACKUP_DIR = join(DATA_DIR, "backups");
export const PORT = Number(process.env.PORT || 3337);

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(EXPORT_DIR, { recursive: true });
mkdirSync(BACKUP_DIR, { recursive: true });
