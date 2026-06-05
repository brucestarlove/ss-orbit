import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { boardById, ticketById } from "./queries.js";
import { requireBoardAccess } from "./auth.js";
import { DISPATCH_RUNS_DIR } from "./paths.js";
import { httpError } from "./util.js";

const MAX_MARKDOWN_ARTIFACT_BYTES = 512 * 1024;
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

function cleanPath(value) {
  const text = String(value || "").trim();
  if (!text || text.includes("\0")) throw httpError(400, "artifact_path_required");
  return text.replace(/\\/g, "/");
}

function ensureInside(path, root) {
  if (!root) return false;
  const normalizedRoot = normalize(root + sep);
  const normalizedPath = normalize(path);
  return normalizedPath === normalize(root) || normalizedPath.startsWith(normalizedRoot);
}

function pathAliases(path) {
  const aliases = new Set([path]);
  const mntDrive = path.match(/^\/mnt\/([a-z])\/(.+)$/i);
  if (mntDrive) {
    const drive = mntDrive[1].toLowerCase();
    aliases.add(`/${drive}/${mntDrive[2]}`);
    aliases.add(`${drive.toUpperCase()}:/${mntDrive[2]}`);
  }
  const slashDrive = path.match(/^\/([a-z])\/(.+)$/i);
  if (slashDrive) {
    const drive = slashDrive[1].toLowerCase();
    aliases.add(`/mnt/${drive}/${slashDrive[2]}`);
    aliases.add(`${drive.toUpperCase()}:/${slashDrive[2]}`);
  }
  const winDrive = path.match(/^([a-z]):\/(.+)$/i);
  if (winDrive) {
    const drive = winDrive[1].toLowerCase();
    aliases.add(`/mnt/${drive}/${winDrive[2]}`);
    aliases.add(`/${drive}/${winDrive[2]}`);
  }
  return [...aliases];
}

function isAbsoluteArtifactPath(path) {
  return isAbsolute(path) || /^[a-z]:\//i.test(path);
}

function artifactRoots(ctx) {
  const roots = [];
  const repoRoot = ctx.board.repo_path || ctx.board.system_path || ctx.board.project_root || "";
  if (repoRoot) roots.push(normalize(repoRoot));
  roots.push(normalize(DISPATCH_RUNS_DIR));
  if (ctx.board.db_path) {
    roots.push(normalize(join(dirname(ctx.board.db_path), "artifacts")));
    roots.push(normalize(join(dirname(ctx.board.db_path), "dispatch-runs")));
  }
  return [...new Set(roots.filter(Boolean))];
}

function resolveArtifactPath(ctx, requestedPath) {
  const raw = cleanPath(requestedPath);
  const roots = artifactRoots(ctx);
  if (roots.length === 0) throw httpError(400, "artifact_root_unavailable");

  const variants = pathAliases(raw);
  const absoluteVariants = variants.filter(isAbsoluteArtifactPath);
  const candidates = (absoluteVariants.length > 0
    ? absoluteVariants
    : roots.flatMap((root) => variants.map((variant) => join(root, variant))))
    .map((candidate) => normalize(candidate));

  const allowed = candidates.filter((candidate) => roots.some((root) => ensureInside(candidate, root)));
  const path = allowed.find((candidate) => existsSync(candidate)) || allowed[0];
  if (!path) throw httpError(400, "artifact_path_outside_allowed_roots");
  return { path, roots };
}

function safeArtifactFileName(value, fallback = "artifact.md") {
  const raw = cleanPath(value || fallback);
  const name = basename(raw).replace(/[^A-Za-z0-9._-]+/g, "-") || fallback;
  const ext = extname(name).toLowerCase();
  if (!MARKDOWN_EXTENSIONS.has(ext)) throw httpError(415, "unsupported_artifact_type");
  return name;
}

function boardArtifactRoot(ctx) {
  if (!ctx.board.db_path) throw httpError(400, "artifact_root_unavailable");
  return normalize(join(dirname(ctx.board.db_path), "artifacts"));
}

export function storeTicketMarkdownArtifact(ticketId, body, ctx) {
  const ticket = ticketById(ctx.db, ticketId);
  if (!ticket || ticket.board_id !== ctx.board.id) throw httpError(404, "ticket_not_found");
  requireBoardAccess(ctx.actor, boardById(ctx.db, ticket.board_id));

  const content = String(body?.content || "");
  const size = Buffer.byteLength(content, "utf8");
  if (size > MAX_MARKDOWN_ARTIFACT_BYTES) throw httpError(413, "artifact_too_large");

  const fileName = safeArtifactFileName(body?.filename || body?.path || "artifact.md");
  const root = boardArtifactRoot(ctx);
  const relativePath = `tickets/${ticket.id}/${fileName}`;
  const absolutePath = normalize(join(root, relativePath));
  if (!ensureInside(absolutePath, root)) throw httpError(400, "artifact_path_outside_allowed_roots");

  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");

  return {
    ticket_id: ticket.id,
    path: relativePath,
    absolute_path: absolutePath,
    size_bytes: size
  };
}

function displayPathFor(path, roots) {
  const root = roots
    .filter((candidate) => ensureInside(path, candidate))
    .sort((a, b) => normalize(b).length - normalize(a).length)[0];
  if (!root) return path;
  const rel = relative(root, path).replace(/\\/g, "/");
  return rel || path;
}

export function getTicketMarkdownArtifact(ticketId, requestedPath, ctx) {
  const ticket = ticketById(ctx.db, ticketId);
  if (!ticket || ticket.board_id !== ctx.board.id) throw httpError(404, "ticket_not_found");
  requireBoardAccess(ctx.actor, boardById(ctx.db, ticket.board_id));

  const { path, roots } = resolveArtifactPath(ctx, requestedPath);
  const ext = extname(path).toLowerCase();
  if (!MARKDOWN_EXTENSIONS.has(ext)) throw httpError(415, "unsupported_artifact_type");
  if (!existsSync(path)) throw httpError(404, "artifact_not_found");
  const stat = statSync(path);
  if (!stat.isFile()) throw httpError(400, "artifact_not_file");
  if (stat.size > MAX_MARKDOWN_ARTIFACT_BYTES) throw httpError(413, "artifact_too_large");

  return {
    ticket_id: ticket.id,
    path: displayPathFor(path, roots),
    absolute_path: path,
    size_bytes: stat.size,
    content: readFileSync(path, "utf8")
  };
}
