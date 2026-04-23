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

  const fts = toFtsQuery(q);
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT t.*, s.name AS state_name, b.slug AS board_slug,
                bm25(ticket_fts) AS rank
         FROM ticket_fts
         JOIN tickets t ON t.id = ticket_fts.ticket_id
         JOIN states s ON s.id = t.state_id
         JOIN boards b ON b.id = t.board_id
         WHERE ticket_fts MATCH ? AND t.archived_at IS NULL
         ORDER BY rank
         LIMIT ?`
      )
      .all(fts, limit);
  } catch {
    const like = `%${q}%`;
    rows = db
      .prepare(
        `SELECT DISTINCT t.*, s.name AS state_name, b.slug AS board_slug, 0 AS rank
         FROM tickets t
         JOIN states s ON s.id = t.state_id
         JOIN boards b ON b.id = t.board_id
         LEFT JOIN comments c ON c.ticket_id = t.id
         WHERE t.archived_at IS NULL
           AND (t.title LIKE ? OR t.description LIKE ? OR t.ai_plan LIKE ?
            OR t.implementation_summary LIKE ? OR t.implementation_updates LIKE ? OR c.body LIKE ?)
         ORDER BY t.updated_at DESC
         LIMIT ?`
      )
      .all(like, like, like, like, like, like, limit);
  }

  rows.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : String(b.updated_at).localeCompare(String(a.updated_at))));

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
