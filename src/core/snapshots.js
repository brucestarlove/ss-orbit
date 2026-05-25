import { resetBoard, tx } from "./db.js";
import { backupBoardDatabase } from "./backups.js";
import { boardById, labelsForTicket } from "./queries.js";
import { requireBoardAccess } from "./auth.js";
import { recordEvent } from "./events.js";
import { syncRegistryFromBoardDb } from "./registry.js";
import {
  httpError,
  normalizePriority,
  normalizeProjectEntryType,
  normalizeTicketType,
  now,
  requiredString
} from "./util.js";
import { reindexAllTickets } from "./tickets.js";
import {
  attachmentRowsForBoard,
  importAttachmentRows,
  serializeAttachmentForExport
} from "./attachments.js";

export function exportBoard(boardId, ctx, options = {}) {
  const { db, board, actor } = ctx;
  if (boardId !== board.id) throw httpError(404, "board_not_found");
  const innerBoard = boardById(db, boardId);
  if (!innerBoard) throw httpError(404, "board_not_found");
  requireBoardAccess(actor, innerBoard);

  const states = db.prepare("SELECT * FROM states WHERE board_id = ? ORDER BY position").all(boardId);
  const tickets = db
    .prepare("SELECT * FROM tickets WHERE board_id = ? ORDER BY number ASC")
    .all(boardId)
    .map((ticket) => ({ ...ticket, labels: labelsForTicket(db, ticket.id) }));
  const ticketIds = tickets.map((ticket) => ticket.id);
  const comments = ticketIds.length
    ? db
        .prepare("SELECT * FROM comments WHERE ticket_id IN (SELECT id FROM tickets WHERE board_id = ?) ORDER BY created_at ASC")
        .all(boardId)
    : [];
  const relations = ticketIds.length
    ? db
        .prepare(
          `SELECT *
           FROM relations
           WHERE source_ticket_id IN (SELECT id FROM tickets WHERE board_id = ?)
              OR target_ticket_id IN (SELECT id FROM tickets WHERE board_id = ?)
           ORDER BY created_at ASC`
        )
        .all(boardId, boardId)
    : [];
  const entries = db
    .prepare("SELECT * FROM board_entries WHERE board_id = ? ORDER BY created_at ASC")
    .all(boardId);
  const labels = db.prepare("SELECT * FROM labels WHERE board_id = ? ORDER BY name ASC").all(boardId);
  const events = db
    .prepare(
      `SELECT *
       FROM events
       WHERE ticket_id IS NULL
          OR ticket_id IN (SELECT id FROM tickets WHERE board_id = ?)
       ORDER BY created_at ASC`
    )
    .all(boardId);
  const attachments = attachmentRowsForBoard(db, boardId).map((row) =>
    serializeAttachmentForExport(board, row, Boolean(options.includeAttachments))
  );

  return {
    format: "orbit-board-export",
    version: 6,
    exported_at: now(),
    include_attachments: Boolean(options.includeAttachments),
    board: { ...innerBoard },
    states,
    labels,
    tickets,
    comments,
    relations,
    attachments,
    board_entries: entries,
    events
  };
}

export function importBoardSnapshot(body, ctx) {
  const { db, actor, board } = ctx;
  const snapshot = body?.snapshot || body;
  const format = snapshot?.format;
  if (!snapshot || format !== "orbit-board-export") throw httpError(400, "invalid_import_snapshot");
  if (!snapshot.board) throw httpError(400, "snapshot_missing_board");

  const replaceExisting = Boolean(body?.replace_existing);
  const existingCount = db.prepare("SELECT COUNT(*) AS count FROM boards").get().count;
  if (existingCount > 0 && !replaceExisting) {
    throw httpError(409, "import_requires_empty_board_or_replace_existing");
  }

  // Snapshot the existing DB file before a destructive replace, outside the
  // transaction (it copies the file on disk, not rows).
  if (existingCount > 0 && replaceExisting) {
    backupBoardDatabase(ctx.board, db, "pre-import-replace");
  }

  const targetBoardId = board.id;
  const importedBoard = {
    ...snapshot.board,
    id: targetBoardId
  };

  const result = tx(db, () => {
    if (existingCount > 0 && replaceExisting) resetBoard(db);

    db.prepare(
      `INSERT INTO boards
       (id, slug, name, repo_url, system_path, default_branch,
        project_notes, agent_instructions, ai_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      importedBoard.id,
      importedBoard.slug,
      importedBoard.name,
      importedBoard.repo_url || "",
      importedBoard.system_path || "",
      importedBoard.default_branch || "main",
      importedBoard.project_notes || "",
      importedBoard.agent_instructions || "",
      importedBoard.ai_enabled === 0 ? 0 : 1,
      importedBoard.created_at || now(),
      importedBoard.updated_at || now()
    );

    for (const state of snapshot.states || []) {
      db.prepare(
        `INSERT INTO states
         (id, board_id, name, position, is_default, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        state.id,
        targetBoardId,
        state.name,
        state.position,
        state.is_default || 0,
        state.role || null,
        state.created_at || now()
      );
    }

    for (const label of snapshot.labels || []) {
      db.prepare("INSERT INTO labels (id, board_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)").run(
        label.id,
        targetBoardId,
        label.name,
        label.color || "#64748b",
        label.created_at || now()
      );
    }

    for (const ticket of snapshot.tickets || []) {
      db.prepare(
        `INSERT INTO tickets
         (id, board_id, number, title, description, type, parent_ticket_id, ai_plan,
          implementation_summary, implementation_updates, state_id, priority,
          created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        ticket.id,
        targetBoardId,
        ticket.number,
        ticket.title,
        ticket.description || "",
        normalizeTicketType(ticket.type || "task"),
        ticket.parent_ticket_id || null,
        ticket.ai_plan || "",
        ticket.implementation_summary || "",
        ticket.implementation_updates || "",
        ticket.state_id,
        normalizePriority(ticket.priority),
        ticket.created_by || "import",
        ticket.created_at || now(),
        ticket.updated_at || now()
      );

      for (const label of ticket.labels || []) {
        db.prepare("INSERT OR IGNORE INTO ticket_labels (ticket_id, label_id) VALUES (?, ?)").run(ticket.id, label.id);
      }
    }

    for (const comment of snapshot.comments || []) {
      db.prepare(
        "INSERT INTO comments (id, ticket_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        comment.id,
        comment.ticket_id,
        comment.author || "import",
        comment.kind || "comment",
        comment.body || "",
        comment.created_at || now()
      );
    }

    for (const relation of snapshot.relations || []) {
      db.prepare(
        "INSERT OR IGNORE INTO relations (id, source_ticket_id, target_ticket_id, type, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(
        relation.id,
        relation.source_ticket_id,
        relation.target_ticket_id,
        relation.type || "relates_to",
        relation.created_at || now()
      );
    }

    importAttachmentRows(snapshot, ctx, targetBoardId);

    for (const entry of snapshot.board_entries || []) {
      db.prepare(
        `INSERT INTO board_entries
         (id, board_id, type, title, body, ticket_id, created_by, created_at, updated_at, struck_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entry.id,
        targetBoardId,
        normalizeProjectEntryType(entry.type),
        requiredString(entry.title, "entry_title"),
        entry.body || "",
        entry.ticket_id || null,
        entry.created_by || "import",
        entry.created_at || now(),
        entry.updated_at || now(),
        entry.struck_at || null
      );
    }

    for (const event of snapshot.events || []) {
      db.prepare(
        "INSERT INTO events (id, ticket_id, actor, type, body_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        event.id,
        event.ticket_id || null,
        event.actor || "import",
        event.type || "imported_event",
        event.body_json || "{}",
        event.created_at || now()
      );
    }

    // Reindex inside the transaction: a committed import must never leave the
    // FTS table empty/stale (previously this ran after COMMIT and a throw here
    // left search broken on otherwise-imported data).
    reindexAllTickets(db);
    recordEvent(db, targetBoardId, "board_imported", null, actor.name, {
      board_id: targetBoardId,
      replace_existing: replaceExisting
    });
    return {
      ok: true,
      imported_board_id: targetBoardId,
      imported_board_slug: importedBoard.slug,
      replace_existing: replaceExisting
    };
  });

  // Registry sync writes the separate registry DB (a different connection), so
  // it runs after the board-DB transaction commits, not inside it.
  syncRegistryFromBoardDb(board, db);
  return result;
}
