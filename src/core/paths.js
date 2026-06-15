import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = resolve(__dirname, "..", "..");

const _distFull = join(ROOT_DIR, "dist", "full");
const _publicDir = join(ROOT_DIR, "public");

/** Where static assets (HTML/JS/CSS) are served from.
 *
 *  public/  — editable source; `pnpm dev` bundles @starlove/ui imports on the fly.
 *  dist/full — prebuilt, hashed bundles from `pnpm build`; what Docker/npm ship.
 *
 *  Auto (default): public/ when it exists, else dist/full. Repo dev therefore
 *  always sees live CSS/JS edits. Docker and other dist-only installs fall back
 *  to the bundle without needing an env var.
 *
 *  Override: ORBIT_USE_DIST=1 force dist/full, ORBIT_USE_DIST=0 force public/. */
function resolvePublicDir() {
    const distExists = existsSync(_distFull);
    const publicExists = existsSync(_publicDir);
    const pref = process.env.ORBIT_USE_DIST;

    if (pref === "1" && distExists) return _distFull;
    if (pref === "0" && publicExists) return _publicDir;
    if (publicExists) return _publicDir;
    if (distExists) return _distFull;
    return _publicDir;
}

export const PUBLIC_DIR = resolvePublicDir();
export const MCP_SERVER_PATH = join(ROOT_DIR, "src", "mcp-server.js");
/** Repo root for default board placement; cwd unless PROJECT_ROOT is set. */
export const PROJECT_ROOT = process.env.PROJECT_ROOT ? resolve(process.env.PROJECT_ROOT) : resolve(process.cwd());
// Store registry + exports in ~/.orbit so global installs don't write into the package dir.
export const DATA_DIR = process.env.DATA_DIR || join(homedir(), ".orbit");
/** Central registry of all boards (metadata + paths to per-board SQLite files). */
export const REGISTRY_DB_PATH = join(DATA_DIR, "registry.db");
/** Central directory where every board's SQLite file lives: DATA_DIR/boards/<slug>/board.db */
export const BOARDS_DIR = join(DATA_DIR, "boards");
export const EXPORT_DIR = join(DATA_DIR, "exports");
export const BACKUP_DIR = join(DATA_DIR, "backups");
/** Central directory for dispatch run artifacts: DATA_DIR/dispatch-runs/<board-slug>/<run-id>/ */
export const DISPATCH_RUNS_DIR = join(DATA_DIR, "dispatch-runs");
export const PORT = Number(process.env.PORT || 13701);

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(BOARDS_DIR, { recursive: true });
mkdirSync(EXPORT_DIR, { recursive: true });
mkdirSync(BACKUP_DIR, { recursive: true });
mkdirSync(DISPATCH_RUNS_DIR, { recursive: true });
