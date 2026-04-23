// Read/write helpers that all take an explicit `db` connection. No hidden
// "active board" state — callers pass in the connection for the board they
// resolved at the request boundary.

import { httpError, id, now, requiredString } from "./util.js";

export function ticketByNumber(db, boardId, number) {
  return db
    .prepare(
      `SELECT t.*, s.name AS state_name, s.role AS state_role,
              b.slug AS board_slug, b.name AS board_name
       FROM tickets t
       JOIN states s ON s.id = t.state_id
       JOIN boards b ON b.id = t.board_id
       WHERE t.board_id = ? AND t.number = ?`
    )
    .get(boardId, number);
}

export function ticketByTitle(db, boardId, title) {
  return db
    .prepare(
      `SELECT t.*, s.name AS state_name, s.role AS state_role,
              b.slug AS board_slug, b.name AS board_name
       FROM tickets t
       JOIN states s ON s.id = t.state_id
       JOIN boards b ON b.id = t.board_id
       WHERE t.board_id = ? AND lower(t.title) = lower(?)
       ORDER BY t.archived_at IS NULL DESC, t.number DESC
       LIMIT 1`
    )
    .get(boardId, title);
}

export function ticketById(db, ticketId) {
  return db
    .prepare(
      `SELECT t.*, s.name AS state_name, s.role AS state_role,
              b.slug AS board_slug, b.name AS board_name
       FROM tickets t
       JOIN states s ON s.id = t.state_id
       JOIN boards b ON b.id = t.board_id
       WHERE t.id = ?`
    )
    .get(ticketId);
}

export function boardById(db, boardId) {
  return db.prepare("SELECT * FROM boards WHERE id = ?").get(boardId);
}

export function stateByName(db, boardId, name) {
  return db.prepare("SELECT * FROM states WHERE board_id = ? AND name = ?").get(boardId, name);
}

export function stateByRole(db, boardId, role) {
  return db
    .prepare("SELECT * FROM states WHERE board_id = ? AND role = ? ORDER BY position LIMIT 1")
    .get(boardId, role);
}

export function stateById(db, stateId) {
  return db.prepare("SELECT * FROM states WHERE id = ?").get(stateId);
}

export function defaultStateId(db, boardId) {
  const state =
    db.prepare("SELECT id FROM states WHERE board_id = ? AND is_default = 1").get(boardId) ||
    db.prepare("SELECT id FROM states WHERE board_id = ? ORDER BY position LIMIT 1").get(boardId);
  if (!state) throw httpError(400, "board_has_no_states");
  return state.id;
}

export function compactStatePositions(db, boardId) {
  const states = db.prepare("SELECT id FROM states WHERE board_id = ? ORDER BY position").all(boardId);
  states.forEach((state, position) => {
    db.prepare("UPDATE states SET position = ? WHERE id = ?").run(position, state.id);
  });
}

export function labelsForTicket(db, ticketId) {
  return db
    .prepare(
      `SELECT l.*
       FROM ticket_labels tl
       JOIN labels l ON l.id = tl.label_id
       WHERE tl.ticket_id = ?
       ORDER BY l.name`
    )
    .all(ticketId);
}

export function childTicketsFor(db, ticketId) {
  return db
    .prepare(
      `SELECT t.*, s.name AS state_name, s.role AS state_role,
              b.slug AS board_slug, b.name AS board_name
       FROM tickets t
       JOIN states s ON s.id = t.state_id
       JOIN boards b ON b.id = t.board_id
       WHERE t.parent_ticket_id = ? AND t.archived_at IS NULL
       ORDER BY t.number ASC`
    )
    .all(ticketId);
}

export function archivedTicketsForBoard(db, boardId) {
  return db
    .prepare(
      `SELECT t.*, s.name AS state_name, s.role AS state_role,
              b.slug AS board_slug, b.name AS board_name
       FROM tickets t
       JOIN states s ON s.id = t.state_id
       JOIN boards b ON b.id = t.board_id
       WHERE t.board_id = ? AND t.archived_at IS NOT NULL
       ORDER BY t.archived_at DESC`
    )
    .all(boardId);
}

export function compactTicket(ticket) {
  if (!ticket) return null;
  return {
    id: ticket.id,
    board_id: ticket.board_id,
    board_slug: ticket.board_slug,
    number: ticket.number,
    title: ticket.title,
    type: ticket.type,
    state_name: ticket.state_name,
    state_role: ticket.state_role,
    priority: ticket.priority
  };
}

export function uniqueTickets(tickets) {
  const seen = new Set();
  const result = [];
  for (const ticket of tickets) {
    if (!ticket || seen.has(ticket.id)) continue;
    seen.add(ticket.id);
    result.push(ticket);
  }
  return result;
}

export function relationRows(db, ticketId) {
  const rows = db
    .prepare(
      `SELECT r.*,
              source.title AS source_title,
              source.number AS source_number,
              source.board_id AS source_board_id,
              target.title AS target_title,
              target.number AS target_number,
              target.board_id AS target_board_id
       FROM relations r
       JOIN tickets source ON source.id = r.source_ticket_id
       JOIN tickets target ON target.id = r.target_ticket_id
       WHERE (r.source_ticket_id = ? OR r.target_ticket_id = ?)
         AND source.archived_at IS NULL AND target.archived_at IS NULL
       ORDER BY r.created_at ASC`
    )
    .all(ticketId, ticketId);

  return rows.map((row) => {
    const isSource = row.source_ticket_id === ticketId;
    const otherId = isSource ? row.target_ticket_id : row.source_ticket_id;
    const other = ticketById(db, otherId);
    return {
      id: row.id,
      type: row.type,
      direction: isSource ? "outgoing" : "incoming",
      other_ticket: other
    };
  });
}

// Returns the set of tickets currently blocking `ticketId`. The relation row
// IS the source of truth: a `blocked_by` row exists iff the target is still
// blocking. Cleanup happens at state-change time (tickets.js auto-deletes
// blocks/blocked_by rows when a ticket moves to a role='done' lane) or when
// the user removes the relation manually in the UI. So this resolver doesn't
// re-check lane state — it just returns the unarchived rows. Exception: epic
// targets expand to their children, since the epic itself isn't what gets
// "done"; each open child (state role != 'done', not archived) is a blocker
// and carries via_epic_id so callers can explain the dependency.
export function unresolvedBlockers(db, ticketId) {
  const direct = db
    .prepare(
      `SELECT target.*, s.name AS state_name, s.role AS state_role
       FROM relations r
       JOIN tickets target ON target.id = r.target_ticket_id
       JOIN states s ON s.id = target.state_id
       WHERE r.source_ticket_id = ? AND r.type = 'blocked_by' AND target.archived_at IS NULL`
    )
    .all(ticketId);

  const expandEpicChildren = db.prepare(
    `SELECT t.*, s.name AS state_name, s.role AS state_role
     FROM tickets t
     JOIN states s ON s.id = t.state_id
     WHERE t.parent_ticket_id = ? AND t.archived_at IS NULL AND (s.role IS NULL OR s.role != 'done')`
  );

  const seen = new Set();
  const blockers = [];
  for (const row of direct) {
    if (row.type === "epic") {
      const children = expandEpicChildren.all(row.id);
      for (const child of children) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        blockers.push({ ...child, via_epic_id: row.id });
      }
      continue;
    }
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    blockers.push(row);
  }
  return blockers;
}

export function ensureLabel(db, boardId, name, color = "#64748b") {
  const cleanName = requiredString(name, "label").trim();
  const existing = db.prepare("SELECT * FROM labels WHERE board_id = ? AND name = ?").get(boardId, cleanName);
  if (existing) return existing;
  const labelId = id();
  db.prepare("INSERT INTO labels (id, board_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)").run(
    labelId,
    boardId,
    cleanName,
    color,
    now()
  );
  return db.prepare("SELECT * FROM labels WHERE id = ?").get(labelId);
}

export function addComment(db, ticketId, author, kind, body) {
  const commentId = id();
  db.prepare(
    "INSERT INTO comments (id, ticket_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(commentId, ticketId, author, kind, body, now());
  return db.prepare("SELECT * FROM comments WHERE id = ?").get(commentId);
}
