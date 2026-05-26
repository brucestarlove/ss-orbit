import { boardById, ticketById } from "./queries.js";
import { requireBoardAccess, requirePermission } from "./auth.js";
import { tx } from "./db.js";
import { recordEvent } from "./events.js";
import { bumpTicketUpdatedAt } from "./tickets.js";
import { httpError, id, now, requiredString } from "./util.js";

const VERDICTS = new Set(["PASS", "BLOCK", "QUESTION"]);
const JSON_ARRAY_FIELDS = ["blocking_findings", "optional_findings", "evidence_commands"];

export function normalizeReviewVerdict(value) {
  const verdict = String(value || "").trim().toUpperCase();
  if (!VERDICTS.has(verdict)) throw httpError(400, "invalid_review_verdict");
  return verdict;
}

function normalizeJsonArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw httpError(400, `invalid_${field}`);
  return value;
}

function optionalString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function hydrateReviewVerdict(row) {
  if (!row) return null;
  const hydrated = { ...row };
  for (const field of JSON_ARRAY_FIELDS) {
    const jsonField = `${field}_json`;
    hydrated[field] = JSON.parse(row[jsonField] || "[]");
    delete hydrated[jsonField];
  }
  hydrated.supersedes_prior_review_id = hydrated.supersedes_prior_review_id || null;
  return hydrated;
}

function reviewVerdictById(db, reviewId) {
  return hydrateReviewVerdict(db.prepare("SELECT * FROM review_verdicts WHERE id = ?").get(reviewId));
}

function requireTicketForReview(ticketId, ctx) {
  const { db, board, actor } = ctx;
  const ticket = ticketById(db, ticketId);
  if (!ticket || ticket.board_id !== board.id) throw httpError(404, "ticket_not_found");
  requireBoardAccess(actor, boardById(db, ticket.board_id));
  return ticket;
}

export function createReviewVerdict(ticketId, body = {}, ctx) {
  const { db, actor } = ctx;
  const ticket = requireTicketForReview(ticketId, ctx);
  requirePermission(actor, "write");

  const verdict = normalizeReviewVerdict(requiredString(body.verdict, "verdict"));
  const blockingFindings = normalizeJsonArray(body.blocking_findings, "blocking_findings");
  const optionalFindings = normalizeJsonArray(body.optional_findings, "optional_findings");
  const evidenceCommands = normalizeJsonArray(body.evidence_commands, "evidence_commands");
  const supersedesPriorReviewId = optionalString(body.supersedes_prior_review_id) || null;

  if (supersedesPriorReviewId) {
    const prior = reviewVerdictById(db, supersedesPriorReviewId);
    if (!prior) throw httpError(400, "invalid_supersedes_prior_review_id");
    if (prior.ticket_id !== ticket.id) throw httpError(400, "superseded_review_ticket_mismatch");
  }

  const reviewId = id();
  return tx(db, () => {
    const time = now();
    db.prepare(
      `INSERT INTO review_verdicts
       (id, ticket_id, verdict, blocking_findings_json, optional_findings_json,
        evidence_commands_json, reviewer_profile, reviewer_session_id,
        reviewed_commit_sha, dispatch_run_id, supersedes_prior_review_id,
        created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      reviewId,
      ticket.id,
      verdict,
      JSON.stringify(blockingFindings),
      JSON.stringify(optionalFindings),
      JSON.stringify(evidenceCommands),
      optionalString(body.reviewer_profile),
      optionalString(body.reviewer_session_id),
      optionalString(body.reviewed_commit_sha),
      optionalString(body.dispatch_run_id),
      supersedesPriorReviewId,
      actor.name,
      time
    );
    db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(time, ticket.id);
    recordEvent(db, ticket.board_id, "review_verdict_created", ticket.id, actor.name, {
      review_id: reviewId,
      verdict,
      supersedes_prior_review_id: supersedesPriorReviewId,
      reviewed_commit_sha: optionalString(body.reviewed_commit_sha),
      dispatch_run_id: optionalString(body.dispatch_run_id),
      actor_type: actor.type,
      actor_id: actor.id
    });
    bumpTicketUpdatedAt(db, ticket.parent_ticket_id, time);
    return getReviewVerdict(reviewId, ctx);
  });
}

export function getReviewVerdict(reviewId, ctx) {
  const { db, board, actor } = ctx;
  const review = reviewVerdictById(db, reviewId);
  if (!review) throw httpError(404, "review_verdict_not_found");
  const ticket = ticketById(db, review.ticket_id);
  if (!ticket || ticket.board_id !== board.id) throw httpError(404, "review_verdict_not_found");
  requireBoardAccess(actor, boardById(db, ticket.board_id));
  return review;
}

export function listReviewVerdicts(ticketId, ctx, options = {}) {
  const { db } = ctx;
  const ticket = requireTicketForReview(ticketId, ctx);
  const limit = normalizeLimit(options.limit);
  return db
    .prepare(
      `SELECT * FROM review_verdicts
       WHERE ticket_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`
    )
    .all(ticket.id, limit)
    .map(hydrateReviewVerdict);
}

function normalizeLimit(value) {
  const n = Number(value ?? 50);
  if (!Number.isInteger(n) || n <= 0) return 50;
  return Math.min(n, 200);
}
