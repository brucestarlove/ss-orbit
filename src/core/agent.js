import {
  addComment,
  boardById,
  childTicketsFor,
  compactTicket,
  labelsForTicket,
  relationRows,
  stateByName,
  stateByRole,
  ticketById,
  ticketByNumber,
  ticketByTitle,
  uniqueTickets,
  unresolvedBlockers
} from "./queries.js";
import { canAccessBoard, requireBoardAccess } from "./auth.js";
import { tx } from "./db.js";
import { recordEvent } from "./events.js";
import {
  appendFieldNote,
  httpError,
  now,
  normalizeTicketType,
  requiredString
} from "./util.js";
import { boardManual } from "./boards.js";
import { bumpTicketUpdatedAt, reindexTicket } from "./tickets.js";

/**
 * Claim the next AI-ready ticket on the resolved board. The router/MCP layer
 * is responsible for picking which board this runs against (via path slug,
 * body field, or session board); this function never scans other boards or
 * mutates global state. If you want to claim from another board, the caller
 * resolves a different ctx and calls again.
 */
export function claimNext(body, ctx) {
  const { db, board, actor } = ctx;
  const filters = {
    type: body.type ? normalizeTicketType(body.type) : "",
    includeEpics: Boolean(body.include_epics)
  };

  const inner = boardById(db, board.id);
  if (!inner || !canAccessBoard(actor, inner)) {
    throw httpError(403, "forbidden");
  }

  const candidates = db
    .prepare(
      `SELECT t.*, b.slug AS board_slug
       FROM tickets t
       JOIN states s ON s.id = t.state_id
       JOIN boards b ON b.id = t.board_id
       WHERE (s.role = 'ai_ready' OR (s.role IS NULL AND s.name = 'AI Ready'))
         AND t.archived_at IS NULL
       ORDER BY t.priority DESC, t.created_at ASC`
    )
    .all();

  const filtered = candidates.filter((ticket) =>
    !filters.type ? filters.includeEpics || ticket.type !== "epic" : ticket.type === filters.type
  );

  for (const candidate of filtered) {
    const blockedBy = unresolvedBlockers(db, candidate.id);
    if (blockedBy.length > 0) continue;

    const inProgress =
      stateByRole(db, candidate.board_id, "in_progress") ||
      stateByName(db, candidate.board_id, "In Progress");
    if (!inProgress) throw httpError(400, "missing_in_progress_state");

    tx(db, () => {
      const time = now();
      db.prepare("UPDATE tickets SET state_id = ?, updated_at = ? WHERE id = ?").run(
        inProgress.id,
        time,
        candidate.id
      );
      addComment(db, candidate.id, actor.name, "agent_note", "Agent claimed this ticket and is starting work.");
      recordEvent(db, candidate.board_id, "agent_claimed", candidate.id, actor.name, { agent_id: actor.id });
      reindexTicket(db, candidate.id);
      bumpTicketUpdatedAt(db, candidate.parent_ticket_id, time);
    });

    return {
      claimed: true,
      ticket_id: candidate.id,
      context: readTicket(candidate.id, ctx)
    };
  }

  return { claimed: false, reason: "no_schedulable_ticket" };
}

function resolveTicketLookup(db, boardId, { ticket_id, number, title }) {
  if (ticket_id) return ticketById(db, ticket_id);
  if (number !== undefined && number !== null && number !== "") {
    const n = Number(number);
    if (!Number.isInteger(n)) throw httpError(400, "invalid_number");
    return ticketByNumber(db, boardId, n);
  }
  if (title) return ticketByTitle(db, boardId, String(title));
  throw httpError(400, "ticket_id_or_number_or_title_required");
}

export function readTicket(lookup, ctx) {
  const { db, board, actor } = ctx;
  const args = typeof lookup === "string" ? { ticket_id: lookup } : lookup || {};
  const ticket = resolveTicketLookup(db, board.id, args);
  if (!ticket || ticket.board_id !== board.id) throw httpError(404, "ticket_not_found");
  const innerBoard = boardById(db, ticket.board_id);
  requireBoardAccess(actor, innerBoard);

  const comments = db
    .prepare("SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at ASC")
    .all(ticket.id);
  const labels = labelsForTicket(db, ticket.id);

  return {
    ticket: {
      id: ticket.id,
      number: ticket.number,
      title: ticket.title,
      description: ticket.description,
      state_name: ticket.state_name,
      type: ticket.type,
      priority: ticket.priority,
      labels
    },
    comments,
    board_manual: boardManual(innerBoard.id, ctx)
  };
}

export function readComments(lookup, ctx) {
  const { db, board, actor } = ctx;
  const args = typeof lookup === "string" ? { ticket_id: lookup } : lookup || {};
  const ticket = resolveTicketLookup(db, board.id, args);
  if (!ticket || ticket.board_id !== board.id) throw httpError(404, "ticket_not_found");
  requireBoardAccess(actor, boardById(db, ticket.board_id));
  const comments = db
    .prepare("SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at ASC")
    .all(ticket.id);
  return { ticket_id: ticket.id, comments };
}

export function checkpointTicket(body, ctx) {
  const { db, board, actor } = ctx;
  const tid = requiredString(body.ticket_id, "ticket_id");
  const ticket = ticketById(db, tid);
  if (!ticket || ticket.board_id !== board.id) throw httpError(404, "ticket_not_found");
  requireBoardAccess(actor, boardById(db, ticket.board_id));

  // Same review lane as `complete`; distinguish mid-flight pause via checkpoint comment + event kind.
  const review =
    stateByRole(db, ticket.board_id, "review") ||
    stateByName(db, ticket.board_id, "Review");
  if (!review) throw httpError(400, "missing_review_state");
  const message = requiredString(body.message, "message");
  tx(db, () => {
    const time = now();
    db.prepare("UPDATE tickets SET state_id = ?, updated_at = ? WHERE id = ?").run(review.id, time, ticket.id);
    addComment(db, ticket.id, actor.name, "checkpoint", message);
    recordEvent(db, ticket.board_id, "checkpoint_requested", ticket.id, actor.name, {
      from: ticket.state_name,
      state: review.name,
      to: review.name,
      actor_type: actor.type,
      actor_id: actor.id
    });
    reindexTicket(db, ticket.id);
    bumpTicketUpdatedAt(db, ticket.parent_ticket_id, time);
  });
  return getContextPack(ticket.id, ctx, 1);
}

export function completeTicket(body, ctx) {
  const { db, board, actor } = ctx;
  const tid = requiredString(body.ticket_id, "ticket_id");
  const ticket = ticketById(db, tid);
  if (!ticket || ticket.board_id !== board.id) throw httpError(404, "ticket_not_found");
  requireBoardAccess(actor, boardById(db, ticket.board_id));

  // If the caller specified a next_state, honor that name verbatim. Otherwise
  // resolve the review lane by role so renaming the lane does not break this.
  const nextState = body.next_state
    ? stateByName(db, ticket.board_id, body.next_state)
    : stateByRole(db, ticket.board_id, "review") || stateByName(db, ticket.board_id, "Review");
  if (!nextState) throw httpError(400, "missing_next_state");

  const summary = requiredString(body.summary, "summary");
  const lines = [summary];
  if (body.pr_url) lines.push(`PR: ${body.pr_url}`);
  const updates = body.updates ? appendFieldNote(ticket.implementation_updates, body.updates, actor.name) : ticket.implementation_updates;
  tx(db, () => {
    const time = now();
    addComment(db, ticket.id, actor.name, "completion", lines.join("\n\n"));
    db.prepare(
      "UPDATE tickets SET state_id = ?, implementation_summary = ?, implementation_updates = ?, updated_at = ? WHERE id = ?"
    ).run(nextState.id, summary, updates, time, ticket.id);
    recordEvent(db, ticket.board_id, "agent_completed", ticket.id, actor.name, {
      from: ticket.state_name,
      next_state: nextState.name,
      to: nextState.name,
      pr_url: body.pr_url || "",
      actor_type: actor.type,
      actor_id: actor.id
    });
    reindexTicket(db, ticket.id);
    bumpTicketUpdatedAt(db, ticket.parent_ticket_id, time);
  });
  return getContextPack(ticket.id, ctx, 1);
}

export function getContextPack(ticketId, ctx, depth = 1) {
  const { db, board, actor } = ctx;
  const ticket = ticketById(db, ticketId);
  if (!ticket || ticket.board_id !== board.id) throw httpError(404, "ticket_not_found");
  const innerBoard = boardById(db, ticket.board_id);
  requireBoardAccess(actor, innerBoard);

  const comments = db.prepare("SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at ASC").all(ticketId);
  const labels = labelsForTicket(db, ticketId);
  const relations = relationRows(db, ticketId);
  const blockers = unresolvedBlockers(db, ticketId);
  const parentTicket = ticket.parent_ticket_id ? ticketById(db, ticket.parent_ticket_id) : null;
  const childTickets = childTicketsFor(db, ticketId).map((child) => ({
    ...child,
    labels: labelsForTicket(db, child.id),
    blockers: unresolvedBlockers(db, child.id)
  }));

  const relatedTickets = uniqueTickets([
    ...relations.map((relation) => relation.other_ticket),
    ...childTickets,
    ...(parentTicket ? [parentTicket] : [])
  ]);
  const relatedCommentRows =
    depth > 0
      ? relatedTickets.flatMap((related) =>
          db
            .prepare("SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 5")
            .all(related.id)
            .reverse()
            .map((comment) => ({ ...comment, ticket_id: related.id, ticket_title: related.title }))
        )
      : [];

  return {
    ticket: {
      ...ticket,
      labels
    },
    board: innerBoard,
    board_manual: boardManual(innerBoard.id, ctx),
    comments,
    parent_ticket: parentTicket ? compactTicket(parentTicket) : null,
    child_tickets: childTickets.map((child) => ({
      ...child,
      child_count: childTicketsFor(db, child.id).length
    })),
    relations,
    blockers,
    related_tickets: relatedTickets,
    related_comments: relatedCommentRows
  };
}
