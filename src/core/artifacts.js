import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, relative, sep } from "node:path";
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

  const candidates = isAbsolute(raw)
    ? [normalize(raw)]
    : roots.map((root) => normalize(join(root, raw)));

  const path = candidates.find((candidate) => roots.some((root) => ensureInside(candidate, root)));
  if (!path) throw httpError(400, "artifact_path_outside_allowed_roots");
  return { path, roots };
}

function displayPathFor(path, roots) {
  const root = roots.find((candidate) => ensureInside(path, candidate));
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
