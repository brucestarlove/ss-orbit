import { boardById, childTicketsFor, relationRows, ticketById, unresolvedBlockers } from "./queries.js";
import { tx } from "./db.js";
import { requireBoardAccess, requirePermission } from "./auth.js";
import { recordEvent } from "./events.js";
import { httpError, id, now, requiredString } from "./util.js";

export function createRelation(body, ctx) {
  const { db, board, actor } = ctx;
  const sourceId = requiredString(body.source_ticket_id, "source_ticket_id");
  const source = ticketById(db, sourceId);
  if (!source || source.board_id !== board.id) throw httpError(404, "ticket_not_found");

  const target = ticketById(db, requiredString(body.target_ticket_id, "target_ticket_id"));
  // Relations are only meaningful within a single board's DB. Cross-board
  // relations are not supported by the schema (foreign keys live in this DB
  // only) and would invent silent invariants.
  if (!target || target.board_id !== board.id) throw httpError(404, "ticket_not_found");

  requireBoardAccess(actor, boardById(db, source.board_id));
  requirePermission(actor, "write");

  if (source.id === target.id) throw httpError(400, "relation_self");
  if (source.parent_ticket_id === target.id || target.parent_ticket_id === source.id) {
    throw httpError(400, "relation_redundant_with_parent");
  }

  const relationType = body.type || "relates_to";
  // Hierarchy is stored on the ticket row (parent_ticket_id), not in the
  // relations table. The `child_of` / `parent_of` types only appear as
  // read-only synthetic entries in getTicketRelations output — pointing
  // callers at the right write path keeps the two models disjoint.
  if (relationType === "child_of" || relationType === "parent_of") {
    throw httpError(400, "hierarchy_uses_parent_ticket_id");
  }
  // Blocker relations are meaningless against a target that's already in a
  // done lane — the row would be a stale blocker on creation. Reject so
  // callers fix the data instead of silently creating dead relations.
  if (relationType === "blocked_by" && target.state_role === "done") {
    throw httpError(400, "blocker_target_already_done");
  }
  if (relationType === "blocks" && source.state_role === "done") {
    throw httpError(400, "blocker_source_already_done");
  }
  const existing = db
    .prepare("SELECT * FROM relations WHERE source_ticket_id = ? AND target_ticket_id = ? AND type = ?")
    .get(source.id, target.id, relationType);
  // Don't silently 201 on a no-op: an INSERT OR IGNORE that hit the UNIQUE
  // constraint would have returned the pre-existing row, hiding from the
  // caller that nothing was created.
  if (existing) throw httpError(409, "relation_exists");

  const relationId = id();
  return tx(db, () => {
    db.prepare(
      "INSERT INTO relations (id, source_ticket_id, target_ticket_id, type, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(relationId, source.id, target.id, relationType, now());
    recordEvent(db, source.board_id, "relation_created", source.id, actor.name, {
      target_ticket_id: target.id,
      type: relationType
    });
    return db.prepare("SELECT * FROM relations WHERE id = ?").get(relationId);
  });
}

export function deleteRelation(relationId, ctx) {
  const { db, board, actor } = ctx;
  const row = db.prepare("SELECT * FROM relations WHERE id = ?").get(relationId);
  if (!row) throw httpError(404, "relation_not_found");
  const source = ticketById(db, row.source_ticket_id);
  const target = ticketById(db, row.target_ticket_id);
  // Relation must live in the resolved board (sanity check — same DB by
  // definition since router resolved this board, but keep the assertion).
  if (source && source.board_id !== board.id) throw httpError(404, "relation_not_found");
  if (source) requireBoardAccess(actor, boardById(db, source.board_id));
  if (target) requireBoardAccess(actor, boardById(db, target.board_id));
  requirePermission(actor, "write");
  return tx(db, () => {
    db.prepare("DELETE FROM relations WHERE id = ?").run(relationId);
    recordEvent(db, source?.board_id || board.id, "relation_deleted", row.source_ticket_id, actor.name, {
      target_ticket_id: row.target_ticket_id,
      type: row.type
    });
    return { ok: true };
  });
}

export function getTicketRelations(ticketId, ctx) {
  const { db, board, actor } = ctx;
  const ticket = ticketById(db, ticketId);
  if (!ticket || ticket.board_id !== board.id) throw httpError(404, "ticket_not_found");
  requireBoardAccess(actor, boardById(db, ticket.board_id));
  const compactOther = (other) => other && {
    id: other.id,
    number: other.number,
    title: other.title,
    type: other.type,
    state_id: other.state_id,
    state_name: other.state_name,
    state_role: other.state_role,
    parent_ticket_id: other.parent_ticket_id
  };

  const relations = relationRows(db, ticketId).map((row) => ({
    id: row.id,
    type: row.type,
    direction: row.direction,
    source: "relation",
    other_ticket: compactOther(row.other_ticket)
  }));

  // Hierarchy is the other relationship model in the system. We don't store
  // it in the `relations` table (parent_ticket_id is a column on the ticket
  // row, kept disjoint from peer relations), but agents asking "what's linked
  // to this ticket?" want a single answer. Synthesize read-only `child_of` /
  // `parent_of` entries here. Marked source='hierarchy' so callers know they
  // can't delete via DELETE /api/relations/:id; mutate via PATCH on the
  // ticket's parent_ticket_id instead.
  if (ticket.parent_ticket_id) {
    const parent = ticketById(db, ticket.parent_ticket_id);
    if (parent && !parent.archived_at) {
      relations.push({
        id: null,
        type: "child_of",
        direction: "outgoing",
        source: "hierarchy",
        other_ticket: compactOther(parent)
      });
    }
  }
  for (const child of childTicketsFor(db, ticketId)) {
    relations.push({
      id: null,
      type: "parent_of",
      direction: "outgoing",
      source: "hierarchy",
      other_ticket: compactOther(child)
    });
  }

  return { ticket_id: ticket.id, relations };
}

export function getTicketBlockers(ticketId, ctx) {
  const { db, board, actor } = ctx;
  const ticket = ticketById(db, ticketId);
  if (!ticket || ticket.board_id !== board.id) throw httpError(404, "ticket_not_found");
  requireBoardAccess(actor, boardById(db, ticket.board_id));
  const blockers = unresolvedBlockers(db, ticketId).map((row) => ({
    id: row.id,
    number: row.number,
    title: row.title,
    type: row.type,
    state_id: row.state_id,
    state_name: row.state_name,
    state_role: row.state_role,
    via_epic_id: row.via_epic_id || null
  }));
  return {
    ticket_id: ticket.id,
    can_start: blockers.length === 0,
    blockers
  };
}
