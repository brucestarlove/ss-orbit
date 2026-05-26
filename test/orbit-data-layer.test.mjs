// Data-layer regression coverage: transaction atomicity, sequential ticket
// numbering, FTS reindex, accurate audit payloads, deep parent-cycle
// rejection, duplicate-relation honesty, and tx() rollback. These exercise
// the core CRUD functions directly against a temp board DB (no HTTP server).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { openConnection, createBoardSchema, tx } from "../src/core/db.js";
import { localAgentActor, localOwnerActor } from "../src/core/auth.js";
import {
  createTicket,
  updateTicket,
  createComment,
  archiveTicket,
  deleteTicket
} from "../src/core/tickets.js";
import { createRelation } from "../src/core/relations.js";
import { getAgentDispatchPacket, getContextPack, readComments, readTicket } from "../src/core/agent.js";
import { searchTickets } from "../src/core/search.js";
import { now, id } from "../src/core/util.js";

function makeBoard() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-data-test-"));
  const dbPath = join(dir, "board.db");
  const db = openConnection(dbPath);
  createBoardSchema(db);
  const boardId = id();
  const t = now();
  const slug = `b-${boardId.slice(0, 8)}`;
  db.prepare("INSERT INTO boards (id,slug,name,system_path,default_branch,agent_instructions,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(
    boardId,
    slug,
    "Board",
    dir,
    "main",
    "Use Orbit carefully. Keep tickets lean for agents. This intentionally long second sentence should be capped in packets.",
    t,
    t
  );
  const todo = id();
  const done = id();
  db.prepare(
    "INSERT INTO states (id,board_id,name,position,is_default,role,created_at) VALUES (?,?,?,?,1,?,?)"
  ).run(todo, boardId, "Todo", 0, null, t);
  db.prepare(
    "INSERT INTO states (id,board_id,name,position,is_default,role,created_at) VALUES (?,?,?,?,0,?,?)"
  ).run(done, boardId, "Done", 1, "done", t);
  const ctx = { actor: localOwnerActor(), board: { id: boardId, slug, name: "Board", db_path: dbPath, system_path: dir, default_branch: "main" }, db };
  return { db, ctx, todo, done, boardId };
}

test("tickets get sequential per-board numbers", () => {
  const { ctx } = makeBoard();
  const a = createTicket({ title: "Alpha" }, ctx);
  const b = createTicket({ title: "Beta" }, ctx);
  assert.equal(a.number, 1);
  assert.equal(b.number, 2);
});

test("createTicket is atomic with its labels and FTS index", () => {
  const { db, ctx } = makeBoard();
  const a = createTicket({ title: "Indexed", labels: ["x"] }, ctx);
  const lbl = db
    .prepare("SELECT 1 FROM ticket_labels WHERE ticket_id = ?")
    .get(a.id);
  const fts = db.prepare("SELECT 1 FROM ticket_fts WHERE ticket_id = ?").get(a.id);
  assert.ok(lbl, "label row written");
  assert.ok(fts, "FTS row written");
});

test("updateTicket records applied (normalized) values, not raw input", () => {
  const { db, ctx, done } = makeBoard();
  const a = createTicket({ title: "Alpha" }, ctx);
  const moved = updateTicket(a.id, { state_id: done, priority: "9" }, ctx);
  assert.equal(moved.state_id, done);
  assert.equal(moved.priority, 4, "priority clamped to 4");
  const stateEvent = db
    .prepare("SELECT 1 FROM events WHERE ticket_id = ? AND type = 'state_changed'")
    .get(a.id);
  assert.ok(stateEvent, "state_changed event recorded");
});

test("updateTicket does not mutate the caller's request body", () => {
  const { ctx } = makeBoard();
  const epic = createTicket({ title: "Epic", type: "epic" }, ctx);
  const body = { type: "epic" };
  updateTicket(epic.id, body, ctx);
  assert.deepEqual(body, { type: "epic" }, "request body untouched");
});

test("comment is reindexed into FTS", () => {
  const { db, ctx } = makeBoard();
  const a = createTicket({ title: "Alpha" }, ctx);
  createComment(a.id, { body: "searchable-needle" }, ctx);
  const hit = db
    .prepare("SELECT 1 FROM ticket_fts WHERE ticket_id = ? AND comments LIKE '%searchable-needle%'")
    .get(a.id);
  assert.ok(hit, "comment body searchable");
});

test("named agent actor is stored on comments and status history", () => {
  const { db, ctx, done } = makeBoard();
  ctx.actor = { ...localAgentActor(), id: "codex-cli", name: "Codex" };
  const a = createTicket({ title: "Agent attribution" }, ctx);
  const comment = createComment(a.id, { body: "agent note" }, ctx);
  updateTicket(a.id, { state_id: done }, ctx);

  assert.equal(comment.author, "Codex");
  assert.equal(comment.kind, "agent_note");

  const event = db.prepare("SELECT actor, body_json FROM events WHERE ticket_id = ? AND type = 'state_changed'").get(a.id);
  assert.equal(event.actor, "Codex");
  assert.deepEqual(JSON.parse(event.body_json), {
    from: "Todo",
    to: "Done",
    actor_type: "agent",
    actor_id: "codex-cli"
  });
});

test("default agent context omits ticket and related comments", () => {
  const { ctx } = makeBoard();
  const a = createTicket({ title: "Alpha" }, ctx);
  const b = createTicket({ title: "Beta" }, ctx);
  createComment(a.id, { body: "private-ticket-thread" }, ctx);
  createComment(b.id, { body: "private-related-thread" }, ctx);
  createRelation({ source_ticket_id: a.id, target_ticket_id: b.id, type: "relates_to" }, ctx);

  const context = getContextPack(a.id, ctx, 1);
  const lightweight = readTicket(a.id, ctx);

  assert.equal(Object.hasOwn(context, "comments"), false);
  assert.equal(Object.hasOwn(context, "related_comments"), false);
  assert.equal(Object.hasOwn(lightweight, "comments"), false);
  assert.equal(JSON.stringify(context).includes("private-ticket-thread"), false);
  assert.equal(JSON.stringify(context).includes("private-related-thread"), false);
  assert.equal(JSON.stringify(lightweight).includes("private-ticket-thread"), false);
});

test("explicit comment retrieval remains available", () => {
  const { ctx } = makeBoard();
  const a = createTicket({ title: "Alpha" }, ctx);
  createComment(a.id, { body: "explicit-comment-thread" }, ctx);

  const result = readComments(a.id, ctx);

  assert.equal(result.ticket_id, a.id);
  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0].body, "explicit-comment-thread");
});

test("search matches ticket numbers", () => {
  const { ctx } = makeBoard();
  for (let i = 0; i < 37; i += 1) createTicket({ title: "Alpha" }, ctx);
  const target = createTicket({ title: "Comet" }, ctx);

  const result = searchTickets({ q: "38" }, ctx);

  assert.equal(target.number, 38);
  assert.equal(result.results[0]?.id, target.id);
});

test("search matches hash-prefixed ticket numbers", () => {
  const { ctx } = makeBoard();
  for (let i = 0; i < 37; i += 1) createTicket({ title: "Alpha" }, ctx);
  const target = createTicket({ title: "Comet" }, ctx);

  const result = searchTickets({ q: "#38" }, ctx);

  assert.equal(target.number, 38);
  assert.equal(result.results[0]?.id, target.id);
});

test("search results include stable state role metadata", () => {
  const { ctx, done } = makeBoard();
  const target = createTicket({ title: "Comet" }, ctx);
  updateTicket(target.id, { state_id: done }, ctx);

  const result = searchTickets({ q: "Comet" }, ctx);

  assert.equal(result.results[0]?.id, target.id);
  assert.equal(result.results[0]?.state_name, "Done");
  assert.equal(result.results[0]?.state_role, "done");
});

test("search defaults to lean summary results for agent consumers", () => {
  const { ctx } = makeBoard();
  const parent = createTicket({ title: "Parent Epic", type: "epic", description: "P".repeat(2000), implementation_updates: "U".repeat(2000) }, ctx);
  const target = createTicket({
    title: "Lean Search Target",
    description: "D".repeat(2000),
    parent_ticket_id: parent.id,
    ai_plan: "Plan".repeat(500),
    implementation_summary: "Summary".repeat(500),
    implementation_updates: "Updates".repeat(500),
    labels: ["agent", "lean"]
  }, ctx);

  const result = searchTickets({ q: "Lean Search Target" }, ctx);

  assert.equal(result.mode, "summary");
  assert.deepEqual(Object.keys(result.results[0]).sort(), [
    "id",
    "labels",
    "number",
    "parent_ticket_id",
    "priority",
    "rank",
    "snippet",
    "state_name",
    "state_role",
    "ticket_id",
    "title",
    "type"
  ]);
  assert.equal(result.results[0].ticket_id, target.id);
  assert.deepEqual(result.results[0].labels, ["agent", "lean"]);
  assert.equal(JSON.stringify(result).includes("D".repeat(500)), false);
  assert.equal(JSON.stringify(result).includes("U".repeat(100)), false);
});

test("search supports ids and full opt-in result modes", () => {
  const { ctx } = makeBoard();
  const target = createTicket({ title: "Mode Target", description: "full-description-visible", labels: ["full"] }, ctx);

  const ids = searchTickets({ q: "Mode Target", mode: "ids" }, ctx);
  const full = searchTickets({ q: "Mode Target", mode: "full" }, ctx);

  assert.equal(ids.mode, "ids");
  assert.deepEqual(Object.keys(ids.results[0]).sort(), ["id", "number", "rank", "ticket_id"]);
  assert.equal(ids.results[0].ticket_id, target.id);
  assert.equal(ids.results[0].number, target.number);
  assert.equal(full.mode, "full");
  assert.equal(full.results[0].description, "full-description-visible");
  assert.equal(full.results[0].labels[0].name, "full");
});

test("agent context caps fields and keeps parent and related tickets shallow by default", () => {
  const { ctx } = makeBoard();
  const parent = createTicket({ title: "Huge Epic", type: "epic", description: "parent-body-".repeat(100) }, ctx);
  const target = createTicket({ title: "Child", description: "target-body-".repeat(100), parent_ticket_id: parent.id }, ctx);
  const related = createTicket({ title: "Related", description: "related-body-".repeat(100) }, ctx);
  createRelation({ source_ticket_id: target.id, target_ticket_id: related.id, type: "relates_to" }, ctx);

  const context = getContextPack(target.id, ctx, 1, { maxCharsPerField: 40 });

  assert.equal(context.ticket.description.length, 40);
  assert.equal(Object.hasOwn(context.parent_ticket, "description"), false);
  assert.equal(Object.hasOwn(context.related_tickets[0], "description"), false);
  assert.equal(JSON.stringify(context).includes("parent-body-parent-body"), false);
  assert.equal(JSON.stringify(context).includes("related-body-related-body"), false);
});

test("agent context can opt into full parent and related bodies", () => {
  const { ctx } = makeBoard();
  const parent = createTicket({ title: "Full Epic", type: "epic", description: "parent full body" }, ctx);
  const target = createTicket({ title: "Child", parent_ticket_id: parent.id }, ctx);
  const related = createTicket({ title: "Related", description: "related full body" }, ctx);
  createRelation({ source_ticket_id: target.id, target_ticket_id: related.id, type: "relates_to" }, ctx);

  const context = getContextPack(target.id, ctx, 1, { includeParentFull: true, includeRelatedFull: true });

  assert.equal(context.parent_ticket.description, "parent full body");
  assert.equal(context.related_tickets[0].description, "related full body");
});

test("agent dispatch packet returns capped workflow context without hydrated epic bodies", () => {
  const { ctx, todo, done } = makeBoard();
  const parent = createTicket({ title: "Dispatch Epic", type: "epic", description: "epic-body-".repeat(100) }, ctx);
  const blocker = createTicket({ title: "Blocker" }, ctx);
  const target = createTicket({
    title: "Dispatch Target",
    description: "Ticket description\n\nAcceptance criteria:\n- ship lean packet\n- avoid giant parents",
    parent_ticket_id: parent.id,
    ai_plan: "packet-plan-".repeat(20),
    labels: ["dispatch"]
  }, ctx);
  createRelation({ source_ticket_id: target.id, target_ticket_id: blocker.id, type: "blocked_by" }, ctx);
  createComment(target.id, { body: "first-comment-".repeat(20), kind: "human_comment" }, ctx);
  createComment(target.id, { body: "second-comment", kind: "agent_note" }, ctx);

  const packet = getAgentDispatchPacket(target.id, ctx, { maxCharsPerField: 60, commentLimit: 1 });

  assert.equal(packet.board.id, ctx.board.id);
  assert.equal(packet.board.slug, ctx.board.slug);
  assert.equal(packet.ticket.id, target.id);
  assert.equal(packet.ticket.acceptance.includes("ship lean packet"), true);
  assert.equal(packet.ticket.description.length <= 60, true);
  assert.equal(packet.ticket.ai_plan.length <= 60, true);
  assert.deepEqual(packet.ticket.labels, ["dispatch"]);
  assert.equal(packet.parent_ticket.title, "Dispatch Epic");
  assert.equal(Object.hasOwn(packet.parent_ticket, "description"), false);
  assert.equal(packet.blockers.can_start, false);
  assert.equal(packet.blockers.blockers[0].id, blocker.id);
  assert.equal(packet.relevant_state_ids.todo, todo);
  assert.equal(packet.relevant_state_ids.done, done);
  assert.equal(packet.recent_comments.length, 1);
  assert.equal(packet.recent_comments[0].body.length <= 60, true);
  assert.equal(JSON.stringify(packet).includes("epic-body-epic-body"), false);
});

test("duplicate relation is rejected instead of silently returning", () => {
  const { ctx } = makeBoard();
  const a = createTicket({ title: "Alpha" }, ctx);
  const b = createTicket({ title: "Beta" }, ctx);
  createRelation({ source_ticket_id: b.id, target_ticket_id: a.id, type: "relates_to" }, ctx);
  assert.throws(
    () => createRelation({ source_ticket_id: b.id, target_ticket_id: a.id, type: "relates_to" }, ctx),
    (e) => e.status === 409 && e.code === "relation_exists"
  );
});

test("deep parent cycle is detected across the ancestor chain", () => {
  const { ctx } = makeBoard();
  const a = createTicket({ title: "A" }, ctx);
  const b = createTicket({ title: "B" }, ctx);
  updateTicket(a.id, { parent_ticket_id: b.id }, ctx);
  assert.throws(
    () => updateTicket(b.id, { parent_ticket_id: a.id }, ctx),
    (e) => e.code === "ticket_parent_cycle"
  );
});

test("delete requires archive first, then removes the ticket", () => {
  const { db, ctx } = makeBoard();
  const a = createTicket({ title: "Alpha" }, ctx);
  assert.throws(
    () => deleteTicket(a.id, ctx),
    (e) => e.code === "ticket_not_archived"
  );
  archiveTicket(a.id, ctx);
  deleteTicket(a.id, ctx);
  assert.ok(!db.prepare("SELECT 1 FROM tickets WHERE id = ?").get(a.id));
});

test("tx() rolls back partial writes when the body throws", () => {
  const { db, ctx, todo, boardId } = makeBoard();
  createTicket({ title: "Keep" }, ctx);
  const before = db.prepare("SELECT COUNT(*) AS c FROM tickets").get().c;
  assert.throws(() =>
    tx(db, () => {
      db.prepare(
        "INSERT INTO tickets (id,board_id,number,title,state_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)"
      ).run(id(), boardId, 999, "Ghost", todo, now(), now());
      throw new Error("boom");
    })
  );
  const after = db.prepare("SELECT COUNT(*) AS c FROM tickets").get().c;
  assert.equal(after, before, "rolled back the partial insert");
});
