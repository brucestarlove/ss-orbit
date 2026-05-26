import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { openConnection, createBoardSchema, createRegistrySchema } from "../src/core/db.js";
import { localOwnerActor } from "../src/core/auth.js";
import { createTicket } from "../src/core/tickets.js";
import { createReviewVerdict, getReviewVerdict, listReviewVerdicts } from "../src/core/review-verdicts.js";
import { exportBoard, importBoardSnapshot } from "../src/core/snapshots.js";
import { deleteBoard } from "../src/core/registry.js";
import { id, now } from "../src/core/util.js";

function makeBoard() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-review-verdict-test-"));
  const dbPath = join(dir, "board.db");
  const db = openConnection(dbPath);
  createBoardSchema(db);
  const boardId = id();
  const t = now();
  const slug = `b-${boardId.slice(0, 8)}`;
  db.prepare("INSERT INTO boards (id,slug,name,system_path,default_branch,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(
    boardId,
    slug,
    "Board",
    dir,
    "main",
    t,
    t
  );
  const todo = id();
  db.prepare(
    "INSERT INTO states (id,board_id,name,position,is_default,role,created_at) VALUES (?,?,?,?,1,?,?)"
  ).run(todo, boardId, "Todo", 0, null, t);
  const ctx = { actor: localOwnerActor(), board: { id: boardId, slug, name: "Board", repo_path: dir, db_path: dbPath, system_path: dir, default_branch: "main" }, db };
  return { db, ctx };
}

test("createReviewVerdict stores structured verdict data for a ticket", () => {
  const { ctx } = makeBoard();
  const ticket = createTicket({ title: "Needs Sentinel" }, ctx);

  const verdict = createReviewVerdict(ticket.id, {
    verdict: "BLOCK",
    dispatch_run_id: "orbit-79-run",
    blocking_findings: [{ severity: "high", file: "src/core/foo.js", issue: "missing validation" }],
    optional_findings: [{ issue: "rename helper" }],
    evidence_commands: ["npm test", "git diff --check"],
    reviewer_profile: "sentinel",
    reviewer_session_id: "sentinel-session-1",
    reviewed_commit_sha: "0123456789abcdef0123456789abcdef01234567"
  }, ctx);

  assert.equal(verdict.ticket_id, ticket.id);
  assert.equal(verdict.verdict, "BLOCK");
  assert.equal(verdict.dispatch_run_id, "orbit-79-run");
  assert.deepEqual(verdict.blocking_findings, [{ severity: "high", file: "src/core/foo.js", issue: "missing validation" }]);
  assert.deepEqual(verdict.optional_findings, [{ issue: "rename helper" }]);
  assert.deepEqual(verdict.evidence_commands, ["npm test", "git diff --check"]);
  assert.equal(verdict.reviewer_profile, "sentinel");
  assert.equal(verdict.reviewer_session_id, "sentinel-session-1");
  assert.equal(verdict.reviewed_commit_sha, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(verdict.supersedes_prior_review_id, null);
});

test("review verdicts can be read and listed newest first", () => {
  const { ctx } = makeBoard();
  const ticket = createTicket({ title: "Reviewed" }, ctx);
  const first = createReviewVerdict(ticket.id, { verdict: "QUESTION", optional_findings: ["needs product answer"] }, ctx);
  const second = createReviewVerdict(ticket.id, { verdict: "PASS", evidence_commands: ["npm test"] }, ctx);

  assert.deepEqual(getReviewVerdict(first.id, ctx), first);
  assert.deepEqual(listReviewVerdicts(ticket.id, ctx).map((row) => row.id), [second.id, first.id]);
});

test("review verdict can supersede an earlier review on the same ticket", () => {
  const { ctx } = makeBoard();
  const ticket = createTicket({ title: "Repair loop seed" }, ctx);
  const blocked = createReviewVerdict(ticket.id, { verdict: "BLOCK", blocking_findings: ["test failed"] }, ctx);

  const pass = createReviewVerdict(ticket.id, {
    verdict: "PASS",
    supersedes_prior_review_id: blocked.id,
    evidence_commands: ["npm test"]
  }, ctx);

  assert.equal(pass.supersedes_prior_review_id, blocked.id);
});

test("review verdicts survive board export and import", () => {
  const source = makeBoard();
  const ticket = createTicket({ title: "Exported review" }, source.ctx);
  const review = createReviewVerdict(ticket.id, { verdict: "BLOCK", blocking_findings: ["regression"] }, source.ctx);

  const snapshot = exportBoard(source.ctx.board.id, source.ctx);
  assert.equal(snapshot.review_verdicts[0].id, review.id);

  const target = makeBoard();
  try {
    createRegistrySchema();
    importBoardSnapshot({ snapshot, replace_existing: true }, target.ctx);

    assert.equal(getReviewVerdict(review.id, target.ctx).verdict, "BLOCK");
    assert.deepEqual(listReviewVerdicts(ticket.id, target.ctx)[0].blocking_findings, ["regression"]);
  } finally {
    deleteBoard(target.ctx.board.id);
  }
});

test("review verdict validation rejects invalid verdict, malformed arrays, missing tickets, and cross-ticket supersedes", () => {
  const { ctx } = makeBoard();
  const ticket = createTicket({ title: "Target" }, ctx);
  const other = createTicket({ title: "Other" }, ctx);
  const otherReview = createReviewVerdict(other.id, { verdict: "PASS" }, ctx);

  assert.throws(() => createReviewVerdict(ticket.id, { verdict: "MAYBE" }, ctx), (e) => e.code === "invalid_review_verdict");
  assert.throws(() => createReviewVerdict(ticket.id, { verdict: "PASS", evidence_commands: "npm test" }, ctx), (e) => e.code === "invalid_evidence_commands");
  assert.throws(() => createReviewVerdict("missing", { verdict: "PASS" }, ctx), (e) => e.code === "ticket_not_found");
  assert.throws(() => createReviewVerdict(ticket.id, { verdict: "PASS", supersedes_prior_review_id: "missing" }, ctx), (e) => e.code === "invalid_supersedes_prior_review_id");
  assert.throws(() => createReviewVerdict(ticket.id, { verdict: "PASS", supersedes_prior_review_id: otherReview.id }, ctx), (e) => e.code === "superseded_review_ticket_mismatch");
});
