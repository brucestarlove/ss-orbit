import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

/** Normalize repo paths for registry lookup (trailing slashes, slashes, Windows case). */
export function normalizePath(raw) {
  if (raw === null || raw === undefined) return "";
  let s = String(raw).trim();
  if (!s) return "";
  try {
    s = resolve(s);
  } catch {
    return "";
  }
  s = s.replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32") s = s.toLowerCase();
  return s;
}

export function id() {
  return randomUUID();
}

export function now() {
  return new Date().toISOString();
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function titleize(value) {
  return String(value)
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function httpError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

export function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw httpError(400, `missing_${field}`);
  }
  return value.trim();
}

export function normalizePriority(value) {
  const number = Number(value ?? 2);
  if (!Number.isFinite(number)) return 2;
  return Math.max(0, Math.min(4, Math.round(number)));
}

export function normalizeTicketType(value) {
  const type = String(value || "task").toLowerCase().trim();
  const allowed = new Set(["epic", "feature", "task", "bug"]);
  if (!allowed.has(type)) throw httpError(400, "invalid_ticket_type");
  return type;
}

export function normalizeProjectEntryType(value) {
  const type = String(value || "").toLowerCase().trim();
  const allowed = new Set(["decision", "lesson"]);
  if (!allowed.has(type)) throw httpError(400, "invalid_project_entry_type");
  return type;
}

export function normalizeStateRole(value) {
  if (value === null || value === undefined || value === "") return null;
  const role = String(value).toLowerCase().trim();
  // `done` marks the terminal lane that auto-resolves blockers (relation-row
  // SSOT — see updateTicket / unresolvedBlockers). The agent-flow roles
  // (ai_ready/in_progress/review) are anchors the claim-next pipeline keys off.
  const allowed = new Set(["ai_ready", "in_progress", "review", "done"]);
  if (!allowed.has(role)) throw httpError(400, "invalid_state_role");
  return role;
}

export function appendFieldNote(existing, note, actorName) {
  const text = String(note || "").trim();
  if (!text) return existing || "";
  const entry = `## ${new Date().toISOString()} - ${actorName}\n\n${text}`;
  return [existing, entry].filter(Boolean).join("\n\n");
}

export function toFtsQuery(q) {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9_ -]/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `${part}*`)
    .join(" AND ");
}
