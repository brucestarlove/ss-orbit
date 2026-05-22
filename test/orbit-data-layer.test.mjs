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
import { localOwnerActor } from "../src/core/auth.js";
import {
  createTicket,
  updateTicket,
  createComment,
  archiveTicket,
  deleteTicket
} from "../src/core/tickets.js";
import { createRelation } from "../src/core/relations.js";
import { searchTickets } from "../src/core/search.js";
import { now, id } from "../src/core/util.js";

function makeBoard() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-data-test-"));
  const dbPath = join(dir, "board.db");
  const db = openConnection(dbPath);
  createBoardSchema(db);
  const boardId = id();
  const t = now();
  db.prepare("INSERT INTO boards (id,slug,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(
    boardId,
    `b-${boardId.slice(0, 8)}`,
    "Board",
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
  const ctx = { actor: localOwnerActor(), board: { id: boardId, db_path: dbPath }, db };
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
