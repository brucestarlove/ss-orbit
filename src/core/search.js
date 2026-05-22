import { labelsForTicket } from "./queries.js";
import { canAccessBoard } from "./auth.js";
import { toFtsQuery } from "./util.js";

/**
 * Search tickets on the resolved board only. The router/MCP layer is
 * responsible for resolving which board to search (slug in URL, body, or
 * session board); this function never crosses board boundaries or mutates
 * shared state.
 */
export function searchTickets(args, ctx) {
  const { db, board, actor } = ctx;
  const q = String(args.q || "").trim();
  const limit = Math.min(Number(args.limit || 20), 50);

  if (!q) return { query: q, results: [] };
  if (!canAccessBoard(actor, board)) return { query: q, results: [] };

  const ticketNumber = ticketNumberQuery(q);
  const fts = toFtsQuery(q);
  let rows = [];

  if (ticketNumber !== null) {
    rows = db
      .prepare(
        `SELECT t.*, s.name AS state_name, b.slug AS board_slug, -1 AS rank
         FROM tickets t
         JOIN states s ON s.id = t.state_id
         JOIN boards b ON b.id = t.board_id
         WHERE t.board_id = ? AND t.number = ? AND t.archived_at IS NULL
         LIMIT ?`
      )
      .all(board.id, ticketNumber, limit);
  }

  try {
    rows = rows.concat(
      db
        .prepare(
          `SELECT t.*, s.name AS state_name, b.slug AS board_slug,
                  bm25(ticket_fts) AS rank
           FROM ticket_fts
           JOIN tickets t ON t.id = ticket_fts.ticket_id
           JOIN states s ON s.id = t.state_id
           JOIN boards b ON b.id = t.board_id
           WHERE ticket_fts MATCH ? AND t.board_id = ? AND t.archived_at IS NULL
           ORDER BY rank
           LIMIT ?`
        )
        .all(fts, board.id, limit)
    );
  } catch {
    const like = `%${q}%`;
    const numberRank = ticketNumber !== null ? "CASE WHEN t.number = ? THEN -1 ELSE 0 END" : "0";
    const numberPredicate = ticketNumber !== null ? "OR t.number = ?" : "";
    const fallbackArgs = ticketNumber !== null ? [ticketNumber, board.id] : [board.id];
    fallbackArgs.push(like, like, like, like, like, like);
    if (ticketNumber !== null) fallbackArgs.push(ticketNumber);
    fallbackArgs.push(limit);

    rows = rows.concat(
      db
        .prepare(
          `SELECT DISTINCT t.*, s.name AS state_name, b.slug AS board_slug, ${numberRank} AS rank
           FROM tickets t
           JOIN states s ON s.id = t.state_id
           JOIN boards b ON b.id = t.board_id
           LEFT JOIN comments c ON c.ticket_id = t.id
           WHERE t.board_id = ? AND t.archived_at IS NULL
             AND (t.title LIKE ? OR t.description LIKE ? OR t.ai_plan LIKE ?
              OR t.implementation_summary LIKE ? OR t.implementation_updates LIKE ? OR c.body LIKE ?
              ${numberPredicate})
           ORDER BY t.updated_at DESC, t.id ASC
           LIMIT ?`
        )
        .all(...fallbackArgs)
    );
  }

  rows.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const byTime = String(b.updated_at).localeCompare(String(a.updated_at));
    if (byTime !== 0) return byTime;
    return String(a.id).localeCompare(String(b.id));
  });

  const seen = new Set();
  const deduped = [];
  for (const ticket of rows) {
    if (seen.has(ticket.id)) continue;
    seen.add(ticket.id);
    deduped.push(ticket);
    if (deduped.length >= limit) break;
  }

  const results = deduped.map((ticket) => ({
    ...ticket,
    labels: labelsForTicket(db, ticket.id)
  }));

  return { query: q, results };
}

function ticketNumberQuery(q) {
  const match = String(q).trim().match(/^#?(\d+)$/);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : null;
}
