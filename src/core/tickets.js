import {
  addComment,
  boardById,
  defaultStateId,
  ensureLabel,
  ticketById
} from "./queries.js";
import { requireBoardAccess, requirePermission } from "./auth.js";
import { tx } from "./db.js";
import { recordEvent } from "./events.js";
import {
  httpError,
  id,
  now,
  normalizePriority,
  normalizeTicketType,
  requiredString
} from "./util.js";

/**
 * Bump a ticket's `updated_at` without recording an event or touching other
 * fields. Used to roll child activity up to the parent epic so the column sort
 * (ORDER BY updated_at DESC) keeps the epic group near recent activity even
 * when only its children changed. Pass `null`/undefined to no-op.
 */
export function bumpTicketUpdatedAt(db, ticketId, time) {
  if (!ticketId) return;
  db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(time, ticketId);
}

export function createTicket(body, ctx) {
  const { db, board, actor } = ctx;
  // The router resolves `ctx.board` from path/body/query before we get here.
  // If the caller also sent `body.board_id`, it must agree with ctx.board.
  if (body.board_id && body.board_id !== board.id) {
    throw httpError(400, "board_id_mismatch");
  }
  const boardId = board.id;
  const innerBoard = boardById(db, boardId);
  if (!innerBoard) throw httpError(404, "board_not_found");
  requireBoardAccess(actor, innerBoard);
  requirePermission(actor, "write");

  const title = requiredString(body.title, "title");
  const stateId = body.state_id || defaultStateId(db, boardId);
  const state = db.prepare("SELECT * FROM states WHERE id = ? AND board_id = ?").get(stateId, boardId);
  if (!state) throw httpError(400, "invalid_state");

  const ticketType = normalizeTicketType(body.type || (body.parent_ticket_id ? "feature" : "task"));
  const parentTicketId = normalizeParentTicketId(db, body.parent_ticket_id, boardId, ticketType);
  const ticketId = id();
  const time = now();

  return tx(db, () => {
    // MAX(number)+1 must be read and consumed inside the transaction: BEGIN
    // IMMEDIATE holds the write lock so a concurrent process (e.g. an MCP
    // agent creating a ticket) can't pick the same number and trip the
    // UNIQUE(board_id, number) constraint.
    const nextNumber =
      (db.prepare("SELECT MAX(number) AS value FROM tickets WHERE board_id = ?").get(boardId).value || 0) + 1;

    db.prepare(
      `INSERT INTO tickets
       (id, board_id, number, title, description, type, parent_ticket_id, ai_plan,
        implementation_summary, implementation_updates, state_id, priority, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      ticketId,
      boardId,
      nextNumber,
      title,
      body.description || "",
      ticketType,
      parentTicketId,
      body.ai_plan || "",
      body.implementation_summary || "",
      body.implementation_updates || "",
      stateId,
      normalizePriority(body.priority),
      actor.name,
      time,
      time
    );

    for (const labelName of body.labels || []) {
      const label = ensureLabel(db, boardId, labelName);
      db.prepare("INSERT OR IGNORE INTO ticket_labels (ticket_id, label_id) VALUES (?, ?)").run(ticketId, label.id);
    }

    recordEvent(db, boardId, "ticket_created", ticketId, actor.name, {
      title,
      type: ticketType,
      parent_ticket_id: parentTicketId
    });
    reindexTicket(db, ticketId);
    bumpTicketUpdatedAt(db, parentTicketId, time);
    return ticketById(db, ticketId);
  });
}

export function updateTicket(ticketId, body, ctx) {
  const { db, board, actor } = ctx;
  const before = ticketById(db, ticketId);
  if (!before) throw httpError(404, "ticket_not_found");
  if (before.board_id !== board.id) throw httpError(404, "ticket_not_found");
  const innerBoard = boardById(db, before.board_id);
  requireBoardAccess(actor, innerBoard);
  requirePermission(actor, "write");

  const allowed = [
    "title",
    "description",
    "type",
    "parent_ticket_id",
    "ai_plan",
    "implementation_summary",
    "implementation_updates",
    "state_id",
    "priority"
  ];

  const nextType = body.type !== undefined ? normalizeTicketType(body.type) : before.type;

  // Resolve every requested field to the value that will actually be written,
  // without mutating the caller's request body. The same resolved map drives
  // both the UPDATE and the audit event, so history reflects what was stored
  // (normalized priority/type, validated parent) rather than raw input.
  const applied = {};
  for (const field of allowed) {
    if (body[field] === undefined) continue;
    if (field === "type") applied.type = nextType;
    else if (field === "priority") applied.priority = normalizePriority(body.priority);
    else if (field === "parent_ticket_id") {
      applied.parent_ticket_id = normalizeParentTicketId(db, body.parent_ticket_id, before.board_id, nextType, before.id);
    } else applied[field] = body[field];
  }
  // Promoting a ticket to epic clears any parent, even if the caller didn't
  // mention parent_ticket_id (epics cannot have parents).
  if (nextType === "epic" && applied.parent_ticket_id === undefined) {
    applied.parent_ticket_id = null;
  }

  const labelSync = Array.isArray(body.labels);
  const fields = Object.keys(applied);

  if (fields.length === 0 && !labelSync) return before;

  if (applied.state_id) {
    const state = db.prepare("SELECT * FROM states WHERE id = ? AND board_id = ?").get(applied.state_id, before.board_id);
    if (!state) throw httpError(400, "invalid_state");
  }

  return tx(db, () => {
    const time = now();
    if (fields.length > 0) {
      const sets = fields.map((field) => `${field} = ?`);
      const values = fields.map((field) => applied[field]);
      sets.push("updated_at = ?");
      values.push(time, ticketId);
      db.prepare(`UPDATE tickets SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }

    // Replace ticket labels when `labels` is sent (array of names). Labels are board-scoped.
    if (labelSync) {
      const boardScopeId = before.board_id;
      db.prepare("DELETE FROM ticket_labels WHERE ticket_id = ?").run(ticketId);
      for (const labelName of body.labels) {
        const clean = String(labelName ?? "")
          .trim()
          .replace(/\s+/g, " ");
        if (!clean) continue;
        const label = ensureLabel(db, boardScopeId, clean);
        db.prepare("INSERT OR IGNORE INTO ticket_labels (ticket_id, label_id) VALUES (?, ?)").run(ticketId, label.id);
      }
      if (fields.length === 0) {
        db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(time, ticketId);
      }
    }

    const after = ticketById(db, ticketId);
    if (before.state_id !== after.state_id) {
      // Done lane is the auto-resolver for blocker relations. When a ticket
      // lands in a role='done' lane, every relation that names this ticket as a
      // blocker (`blocks` from this ticket, `blocked_by` toward this ticket)
      // becomes meaningless — the relation row is the SSOT, so we delete it.
      if (after.state_role === "done" && before.state_role !== "done") {
        db.prepare(
          `DELETE FROM relations
           WHERE (source_ticket_id = ? AND type = 'blocks')
              OR (target_ticket_id = ? AND type = 'blocked_by')`
        ).run(ticketId, ticketId);
      }
      recordEvent(db, before.board_id, "state_changed", ticketId, actor.name, {
        from: before.state_name,
        to: after.state_name,
        actor_type: actor.type,
        actor_id: actor.id
      });
    } else {
      const eventPayload = { ...applied };
      if (labelSync) eventPayload.labels = body.labels;
      if (Object.keys(eventPayload).length > 0) {
        recordEvent(db, before.board_id, "ticket_updated", ticketId, actor.name, eventPayload);
      }
    }
    reindexTicket(db, ticketId);
    // Roll activity up to the parent epic so the column sort keeps the epic
    // group near recent child activity. On reparent, bump both old and new
    // parent — both views changed (one lost a child, the other gained one).
    bumpTicketUpdatedAt(db, before.parent_ticket_id, time);
    if (after.parent_ticket_id && after.parent_ticket_id !== before.parent_ticket_id) {
      bumpTicketUpdatedAt(db, after.parent_ticket_id, time);
    }
    return after;
  });
}

export function archiveTicket(ticketId, ctx) {
  const { db, board, actor } = ctx;
  const ticket = ticketById(db, ticketId);
  if (!ticket || ticket.board_id !== board.id) throw httpError(404, "ticket_not_found");
  requireBoardAccess(actor, boardById(db, ticket.board_id));
  requirePermission(actor, "write");

  if (ticket.archived_at) return ticket;

  return tx(db, () => {
    const time = now();
    db.prepare("UPDATE tickets SET archived_at = ?, updated_at = ? WHERE id = ?").run(time, time, ticketId);
    recordEvent(db, ticket.board_id, "ticket_archived", ticketId, actor.name, { title: ticket.title });
    bumpTicketUpdatedAt(db, ticket.parent_ticket_id, time);
    return ticketById(db, ticketId);
  });
}

export function restoreTicket(ticketId, ctx) {
  const { db, board, actor } = ctx;
  const ticket = ticketById(db, ticketId);
  if (!ticket || ticket.board_id !== board.id) throw httpError(404, "ticket_not_found");
  requireBoardAccess(actor, boardById(db, ticket.board_id));
  requirePermission(actor, "write");

  if (!ticket.archived_at) return ticket;

  return tx(db, () => {
    const time = now();
    db.prepare("UPDATE tickets SET archived_at = NULL, updated_at = ? WHERE id = ?").run(time, ticketId);
    recordEvent(db, ticket.board_id, "ticket_restored", ticketId, actor.name, { title: ticket.title });
    bumpTicketUpdatedAt(db, ticket.parent_ticket_id, time);
    return ticketById(db, ticketId);
  });
}

export function deleteTicket(ticketId, ctx) {
  const { db, board, actor } = ctx;
  const ticket = ticketById(db, ticketId);
  if (!ticket || ticket.board_id !== board.id) throw httpError(404, "ticket_not_found");
  requireBoardAccess(actor, boardById(db, ticket.board_id));
  requirePermission(actor, "write");

  if (!ticket.archived_at) throw httpError(409, "ticket_not_archived");

  return tx(db, () => {
    recordEvent(db, ticket.board_id, "ticket_deleted", ticketId, actor.name, {
      title: ticket.title,
      type: ticket.type,
      board_id: ticket.board_id
    });
    db.prepare("DELETE FROM ticket_fts WHERE ticket_id = ?").run(ticketId);
    db.prepare("DELETE FROM tickets WHERE id = ?").run(ticketId);
    bumpTicketUpdatedAt(db, ticket.parent_ticket_id, now());
    return { ok: true, deleted_id: ticketId };
  });
}

export function createComment(ticketId, body, ctx) {
  const { db, board, actor } = ctx;
  const ticket = ticketById(db, ticketId);
  if (!ticket || ticket.board_id !== board.id) throw httpError(404, "ticket_not_found");
  requireBoardAccess(actor, boardById(db, ticket.board_id));
  requirePermission(actor, "write");

  const commentBody = requiredString(body.body, "body");
  const author = body.author || actor.name;
  const kind = body.kind || (actor.type === "agent" ? "agent_note" : "human_comment");

  return tx(db, () => {
    const time = now();
    const comment = addComment(db, ticketId, author, kind, commentBody);
    db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(time, ticketId);
    recordEvent(db, ticket.board_id, "comment_created", ticketId, actor.name, { kind: comment.kind });
    reindexTicket(db, ticketId);
    bumpTicketUpdatedAt(db, ticket.parent_ticket_id, time);
    return comment;
  });
}

export function getTicketStatusHistory(ticketId, ctx) {
  const { db, board, actor } = ctx;
  const ticket = ticketById(db, ticketId);
  if (!ticket || ticket.board_id !== board.id) throw httpError(404, "ticket_not_found");
  requireBoardAccess(actor, boardById(db, ticket.board_id));

  return db
    .prepare(
      `SELECT * FROM events
       WHERE ticket_id = ? AND type IN ('state_changed', 'checkpoint_requested', 'agent_completed')
       ORDER BY created_at ASC`
    )
    .all(ticketId)
    .map((e) => ({ ...e, body: JSON.parse(e.body_json) }));
}

export function normalizeParentTicketId(db, value, boardId, ticketType, currentTicketId = "") {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (ticketType === "epic") throw httpError(400, "epic_cannot_have_parent");
  if (value === currentTicketId) throw httpError(400, "ticket_cannot_parent_itself");

  const parent = ticketById(db, value);
  if (!parent || parent.board_id !== boardId) throw httpError(400, "invalid_parent_ticket");

  // Walk the full ancestor chain, not just one hop: parenting onto `parent`
  // must not make `currentTicketId` its own ancestor (A→B→C→A). The depth cap
  // also stops a pre-existing corrupt cycle from looping forever here.
  const seen = new Set();
  let ancestor = parent;
  let guard = 0;
  while (ancestor) {
    if (currentTicketId && ancestor.id === currentTicketId) {
      throw httpError(400, "ticket_parent_cycle");
    }
    if (!ancestor.parent_ticket_id || seen.has(ancestor.parent_ticket_id) || guard++ > 1000) break;
    seen.add(ancestor.parent_ticket_id);
    ancestor = ticketById(db, ancestor.parent_ticket_id);
  }
  return parent.id;
}

export function reindexTicket(db, ticketId) {
  const ticket = db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticketId);
  if (!ticket) return;
  const comments = db
    .prepare("SELECT body FROM comments WHERE ticket_id = ? ORDER BY created_at ASC")
    .all(ticketId)
    .map((comment) => comment.body)
    .join("\n");
  const implementationText = [
    `Type: ${ticket.type}`,
    ticket.ai_plan,
    ticket.implementation_summary,
    ticket.implementation_updates
  ]
    .filter(Boolean)
    .join("\n");
  db.prepare("DELETE FROM ticket_fts WHERE ticket_id = ?").run(ticketId);
  db.prepare("INSERT INTO ticket_fts (ticket_id, title, description, comments) VALUES (?, ?, ?, ?)").run(
    ticketId,
    ticket.title,
    ticket.description,
    [implementationText, comments].filter(Boolean).join("\n")
  );
}

export function reindexAllTickets(db) {
  const rows = db.prepare("SELECT id FROM tickets").all();
  for (const row of rows) reindexTicket(db, row.id);
}
