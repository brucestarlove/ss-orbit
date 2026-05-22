import { compactTicket, ticketById } from "./queries.js";
import { canAccessBoard, publicActor } from "./auth.js";
import { EXPORT_DIR } from "./paths.js";
import {
  getBoardByRegistryId,
  listBoards,
  openBoardDb,
  pickDefaultBoard,
  touchBoardActive
} from "./registry.js";

function boardSummaryFromRegistry(r) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    repo_url: r.repo_url,
    default_branch: r.default_branch,
    repo_path: r.repo_path,
    system_path: r.repo_path,
    project_notes: "",
    agent_instructions: "",
    ai_enabled: 0,
    created_at: r.created_at,
    updated_at: r.updated_at
  };
}

/**
 * Build the bootstrap payload for one board (or just registry metadata if the
 * actor has no accessible boards). No global state is mutated; the chosen
 * board's last_active_at is bumped so subsequent default-pick prefers it.
 *
 * @param actor authenticated actor
 * @param requestedBoardId optional board id from `?board_id=` (or null)
 * @param requestedBoardSlug optional board slug from `?board=` (or null)
 */
export function getBootstrap(actor, requestedBoardId = null, requestedBoardSlug = null) {
  const registryRows = listBoards();
  const accessible = registryRows.filter((row) => canAccessBoard(actor, { slug: row.slug }));

  if (accessible.length === 0) {
    return {
      actor: publicActor(actor),
      meta: {
        db_path: null,
        export_dir: EXPORT_DIR
      },
      boards: [],
      board_entries: [],
      states: [],
      labels: [],
      tickets: []
    };
  }

  let chosen = null;
  if (requestedBoardId) {
    chosen = accessible.find((row) => row.id === requestedBoardId) || null;
  }
  if (!chosen && requestedBoardSlug) {
    chosen = accessible.find((row) => row.slug === requestedBoardSlug) || null;
  }
  if (!chosen) {
    const defaultRow = pickDefaultBoard();
    if (defaultRow && accessible.some((row) => row.id === defaultRow.id)) {
      chosen = defaultRow;
    }
  }
  if (!chosen) {
    const sorted = [...accessible].sort(
      (a, b) =>
        String(b.last_active_at || "").localeCompare(String(a.last_active_at || "")) ||
        String(a.name).localeCompare(String(b.name))
    );
    chosen = sorted[0];
  }

  // Re-fetch in case the chosen row came from pickDefaultBoard before the
  // accessible filter. Either way, this is the row we open.
  const chosenRow = getBoardByRegistryId(chosen.id);
  touchBoardActive(chosenRow.id);
  const db = openBoardDb(chosenRow);
  const innerBoard = db.prepare("SELECT * FROM boards LIMIT 1").get();

  const boards = accessible.map((r) => {
    if (innerBoard && r.id === innerBoard.id) {
      return {
        ...innerBoard,
        repo_path: r.repo_path,
        system_path: innerBoard.system_path || r.repo_path
      };
    }
    return boardSummaryFromRegistry(r);
  });

  const boardIds = new Set(innerBoard ? [innerBoard.id] : []);

  const states = db
    .prepare("SELECT * FROM states ORDER BY position")
    .all()
    .filter((state) => boardIds.has(state.board_id));

  const tickets = db
    .prepare(
      `SELECT t.*, s.name AS state_name, s.role AS state_role,
              b.slug AS board_slug, b.name AS board_name
       FROM tickets t
       JOIN states s ON s.id = t.state_id
       JOIN boards b ON b.id = t.board_id
       WHERE t.archived_at IS NULL
       ORDER BY t.updated_at DESC, t.id ASC`
    )
    .all()
    .filter((ticket) => boardIds.has(ticket.board_id));

  const labels = db
    .prepare("SELECT * FROM labels ORDER BY name")
    .all()
    .filter((label) => boardIds.has(label.board_id));

  const ticketLabels = db
    .prepare(
      `SELECT tl.ticket_id, l.id, l.name, l.color
       FROM ticket_labels tl
       JOIN labels l ON l.id = tl.label_id`
    )
    .all()
    .filter((label) => tickets.some((ticket) => ticket.id === label.ticket_id));

  const commentCounts = db
    .prepare("SELECT ticket_id, COUNT(*) AS count FROM comments GROUP BY ticket_id")
    .all()
    .filter((row) => tickets.some((ticket) => ticket.id === row.ticket_id));

  const childCounts = db
    .prepare(
      "SELECT parent_ticket_id AS ticket_id, COUNT(*) AS count FROM tickets WHERE parent_ticket_id IS NOT NULL AND archived_at IS NULL GROUP BY parent_ticket_id"
    )
    .all()
    .filter((row) => tickets.some((ticket) => ticket.id === row.ticket_id));

  const boardEntries = db
    .prepare("SELECT * FROM board_entries ORDER BY created_at DESC")
    .all()
    .filter((entry) => boardIds.has(entry.board_id));

  return {
    actor: publicActor(actor),
    // The server may choose a default board that is not first in the registry's
    // alphabetic board list. Expose that choice explicitly so first-page load
    // selects the same board whose lanes/tickets are included below.
    active_board_id: chosenRow.id,
    meta: {
      db_path: chosenRow.db_path,
      export_dir: EXPORT_DIR
    },
    boards,
    board_entries: boardEntries,
    states,
    labels,
    tickets: tickets.map((ticket) => ({
      ...ticket,
      labels: ticketLabels.filter((label) => label.ticket_id === ticket.id),
      comment_count: commentCounts.find((row) => row.ticket_id === ticket.id)?.count || 0,
      child_count: childCounts.find((row) => row.ticket_id === ticket.id)?.count || 0,
      parent_ticket: ticket.parent_ticket_id ? compactTicket(ticketById(db, ticket.parent_ticket_id)) : null
    }))
  };
}
