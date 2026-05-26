// HTTP router. Every request resolves its own per-call `ctx = {actor, board,
// db}` from the request itself — there is intentionally no module-level
// "active board" pointer that could race across concurrent requests. If a
// request reaches a board-scoped route without enough information to pick a
// board, it is rejected with 400 board_id_required rather than silently
// inheriting some other caller's recent state.

import { actorFromHttpRequest } from "./auth.js";
import { scheduleAutomaticBoardBackup } from "./backups.js";
import { readJson, readRaw, sendFile, sendJson, setCors } from "./http.js";
import {
  findBoardForBoardEntry,
  findBoardForRelation,
  findBoardForState,
  findBoardForTicket,
  getBoardByRegistryId,
  getBoardBySlug,
  listBoards,
  openBoardDb,
  touchBoardActive
} from "./registry.js";
import { getBootstrap } from "./bootstrap.js";
import { deleteRegisteredBoard } from "./delete-board.js";
import {
  createBoard,
  createBoardEntry,
  getBoardContext,
  updateBoard,
  updateBoardEntry
} from "./boards.js";
import { exportBoard, importBoardSnapshot } from "./snapshots.js";
import {
  createState,
  deleteState,
  reorderStates,
  updateState
} from "./states.js";
import {
  archiveTicket,
  createComment,
  createTicket,
  deleteTicket,
  getTicketStatusHistory,
  restoreTicket,
  updateTicket
} from "./tickets.js";
import { archivedTicketsForBoard } from "./queries.js";
import { httpError } from "./util.js";
import { pickFolder } from "./system-picker.js";
import {
  createRelation,
  deleteRelation,
  getTicketBlockers,
  getTicketRelations
} from "./relations.js";
import { searchTickets } from "./search.js";
import {
  createTicketAttachment,
  deleteTicketAttachment,
  getTicketAttachmentContent,
  listTicketAttachments,
  MAX_IMAGE_ATTACHMENT_BYTES
} from "./attachments.js";
import {
  checkpointTicket,
  claimNext,
  completeTicket,
  getAgentDispatchPacket,
  getContextPack,
  getContextPackFull,
  readComments,
  readTicket
} from "./agent.js";
import { createReviewVerdict, getReviewVerdict, listReviewVerdicts } from "./review-verdicts.js";

/** Build a ctx for an already-resolved registry row + actor. */
function ctxFromBoardRow(boardRow, actor) {
  return { actor, board: boardRow, db: openBoardDb(boardRow) };
}

function sendMutationJson(res, status, body, ctx) {
  sendJson(res, status, body);
  scheduleAutomaticBoardBackup(ctx.board, ctx.db);
}

/** Resolve a board from a hint (id or slug) or null. Throws 404 if a hint
 *  was given but no board matches. */
function resolveBoardFromHint(idHint, slugHint) {
  if (idHint) {
    const row = getBoardByRegistryId(idHint);
    if (!row) throw httpError(404, "board_not_found");
    return row;
  }
  if (slugHint) {
    const row = getBoardBySlug(slugHint);
    if (!row) throw httpError(404, "board_not_found");
    return row;
  }
  return null;
}

/** Read board hints from query string (or null). */
function boardHintsFromQuery(url) {
  return {
    boardId: url.searchParams.get("board_id"),
    boardSlug: url.searchParams.get("board")
  };
}

function agentContextOptions(url) {
  return {
    max_chars_per_field: url.searchParams.get("max_chars_per_field"),
    comment_limit: url.searchParams.get("comment_limit"),
    include_parent_full: url.searchParams.get("include_parent_full") === "true",
    include_related_full: url.searchParams.get("include_related_full") === "true"
  };
}

export async function handleApi(req, res, url) {
  setCors(res);

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  const actor = actorFromHttpRequest(req);

  // Bootstrap: read-only registry + one chosen board. No global state mutated.
  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    sendJson(res, 200, getBootstrap(actor, url.searchParams.get("board_id"), url.searchParams.get("board")));
    return;
  }

  /** Registry-only board list (small JSON). For tickets/lanes/labels use `GET /api/bootstrap` or open a board context route. */
  if (req.method === "GET" && url.pathname === "/api/boards") {
    sendJson(res, 200, {
      boards: listBoards().map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        repo_path: row.repo_path,
        repo_url: row.repo_url,
        default_branch: row.default_branch,
        db_path: row.db_path,
        last_active_at: row.last_active_at ?? null
      }))
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/system/pick-folder") {
    const result = await pickFolder();
    if (result.unsupported) throw httpError(501, "folder_picker_unavailable");
    sendJson(res, 200, result);
    return;
  }

  // Board CRUD that doesn't take a per-board ctx.
  if (req.method === "POST" && url.pathname === "/api/boards") {
    const body = await readJson(req);
    const created = createBoard(body, { actor });
    const row = getBoardByRegistryId(created.id);
    if (row) scheduleAutomaticBoardBackup(row, openBoardDb(row));
    sendJson(res, 201, created);
    return;
  }

  // Path-prefixed board routes: /api/boards/:slugOrId/...
  const boardPrefix = url.pathname.match(/^\/api\/boards\/([^/]+)(?:\/(.*))?$/);
  if (boardPrefix) {
    const ident = decodeURIComponent(boardPrefix[1]);
    const sub = boardPrefix[2] || "";
    const row = getBoardByRegistryId(ident) || getBoardBySlug(ident);
    if (!row) throw httpError(404, "board_not_found");

    if (sub === "" && req.method === "DELETE") {
      const body = await readJson(req);
      sendJson(res, 200, deleteRegisteredBoard(row, body, actor));
      return;
    }

    const ctx = ctxFromBoardRow(row, actor);
    touchBoardActive(row.id);

    if (sub === "" && req.method === "PATCH") {
      const body = await readJson(req);
      sendMutationJson(res, 200, updateBoard(row.id, body, ctx), ctx);
      return;
    }
    if (sub === "context" && req.method === "GET") {
      sendJson(res, 200, getBoardContext(row.id, ctx, {
        includeStruck: url.searchParams.get("include_struck") === "true"
      }));
      return;
    }
    if (sub === "archive" && req.method === "GET") {
      sendJson(res, 200, { tickets: archivedTicketsForBoard(ctx.db, row.id) });
      return;
    }
    if (sub === "entries" && req.method === "POST") {
      const body = await readJson(req);
      sendMutationJson(res, 201, createBoardEntry(row.id, body, ctx), ctx);
      return;
    }
    if (sub === "export" && req.method === "GET") {
      sendJson(res, 200, exportBoard(row.id, ctx, {
        includeAttachments: url.searchParams.get("include_attachments") === "true" || url.searchParams.get("include_images") === "true"
      }));
      return;
    }
    if (sub === "states" && req.method === "POST") {
      const body = await readJson(req);
      sendMutationJson(res, 201, createState(row.id, body, ctx), ctx);
      return;
    }
    if (sub === "states" && req.method === "PATCH") {
      const body = await readJson(req);
      sendMutationJson(res, 200, reorderStates(row.id, body, ctx), ctx);
      return;
    }
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  // /api/tickets POST — body.board_id required.
  if (req.method === "POST" && url.pathname === "/api/tickets") {
    const body = await readJson(req);
    const hintId = body.board_id || url.searchParams.get("board_id");
    const hintSlug = body.board || url.searchParams.get("board");
    const row = resolveBoardFromHint(hintId, hintSlug);
    if (!row) throw httpError(400, "board_id_required");
    const ctx = ctxFromBoardRow(row, actor);
    sendMutationJson(res, 201, createTicket(body, ctx), ctx);
    return;
  }

  // /api/tickets/lookup GET — exact lightweight lookup by number or title.
  if (req.method === "GET" && url.pathname === "/api/tickets/lookup") {
    const { boardId, boardSlug } = boardHintsFromQuery(url);
    const row = resolveBoardFromHint(boardId, boardSlug);
    if (!row) throw httpError(400, "board_id_required");
    const lookup = {};
    if (url.searchParams.has("number")) lookup.number = url.searchParams.get("number");
    if (url.searchParams.has("title")) lookup.title = url.searchParams.get("title");
    sendJson(res, 200, readTicket(lookup, ctxFromBoardRow(row, actor)));
    return;
  }

  // /api/tickets/:id/... — board resolved from query hint or via lookup.
  const ticketPath = url.pathname.match(/^\/api\/tickets\/([^/]+)(?:\/(.*))?$/);
  if (ticketPath) {
    const ticketId = decodeURIComponent(ticketPath[1]);
    const sub = ticketPath[2] || "";
    const { boardId, boardSlug } = boardHintsFromQuery(url);
    const hintRow = resolveBoardFromHint(boardId, boardSlug);
    const found = findBoardForTicket(ticketId, hintRow?.id || null);
    if (!found) throw httpError(404, "ticket_not_found");
    const ctx = ctxFromBoardRow(found.board, actor);

    if (sub === "" && req.method === "GET") {
      sendJson(res, 200, readTicket(ticketId, ctx));
      return;
    }
    if (sub === "" && req.method === "PATCH") {
      const body = await readJson(req);
      sendMutationJson(res, 200, updateTicket(ticketId, body, ctx), ctx);
      return;
    }
    if (sub === "" && req.method === "DELETE") {
      sendMutationJson(res, 200, deleteTicket(ticketId, ctx), ctx);
      return;
    }
    if (sub === "archive" && req.method === "POST") {
      sendMutationJson(res, 200, archiveTicket(ticketId, ctx), ctx);
      return;
    }
    if (sub === "restore" && req.method === "POST") {
      sendMutationJson(res, 200, restoreTicket(ticketId, ctx), ctx);
      return;
    }
    if (sub === "context" && req.method === "GET") {
      const depth = Number(url.searchParams.get("depth") || 1);
      sendJson(res, 200, getContextPack(ticketId, ctx, depth, agentContextOptions(url)));
      return;
    }
    if (sub === "context/full" && req.method === "GET") {
      const depth = Number(url.searchParams.get("depth") || 1);
      sendJson(res, 200, getContextPackFull(ticketId, ctx, depth, agentContextOptions(url)));
      return;
    }
    if ((sub === "dispatch-packet" || sub === "agent-dispatch-packet") && req.method === "GET") {
      sendJson(res, 200, getAgentDispatchPacket(ticketId, ctx, agentContextOptions(url)));
      return;
    }
    if (sub === "history" && req.method === "GET") {
      sendJson(res, 200, getTicketStatusHistory(ticketId, ctx));
      return;
    }
    if (sub === "relations" && req.method === "GET") {
      sendJson(res, 200, getTicketRelations(ticketId, ctx));
      return;
    }
    if (sub === "blockers" && req.method === "GET") {
      sendJson(res, 200, getTicketBlockers(ticketId, ctx));
      return;
    }
    if (sub === "comments" && req.method === "GET") {
      sendJson(res, 200, readComments(ticketId, ctx));
      return;
    }
    if (sub === "comments" && req.method === "POST") {
      const body = await readJson(req);
      sendMutationJson(res, 201, createComment(ticketId, body, ctx), ctx);
      return;
    }
    if (sub === "review-verdicts" && req.method === "GET") {
      sendJson(res, 200, { review_verdicts: listReviewVerdicts(ticketId, ctx, { limit: url.searchParams.get("limit") }) });
      return;
    }
    if (sub === "review-verdicts" && req.method === "POST") {
      const body = await readJson(req);
      sendMutationJson(res, 201, createReviewVerdict(ticketId, body, ctx), ctx);
      return;
    }
    if (sub === "attachments" && req.method === "GET") {
      sendJson(res, 200, listTicketAttachments(ticketId, ctx));
      return;
    }
    if (sub === "attachments" && req.method === "POST") {
      const bytes = await readRaw(req, MAX_IMAGE_ATTACHMENT_BYTES);
      const attachment = createTicketAttachment(ticketId, {
        bytes,
        mime_type: req.headers["content-type"],
        original_name: req.headers["x-file-name"] || url.searchParams.get("filename") || "image"
      }, ctx);
      sendMutationJson(res, 201, attachment, ctx);
      return;
    }
    const attachmentContentPath = sub.match(/^attachments\/([^/]+)\/content$/);
    if (attachmentContentPath && req.method === "GET") {
      const result = getTicketAttachmentContent(ticketId, decodeURIComponent(attachmentContentPath[1]), ctx);
      sendFile(res, result.filePath, result.row.mime_type);
      return;
    }
    const attachmentPath = sub.match(/^attachments\/([^/]+)$/);
    if (attachmentPath && req.method === "DELETE") {
      sendMutationJson(res, 200, deleteTicketAttachment(ticketId, decodeURIComponent(attachmentPath[1]), ctx), ctx);
      return;
    }
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  const reviewVerdictPath = url.pathname.match(/^\/api\/review-verdicts\/([^/]+)$/);
  if (reviewVerdictPath && req.method === "GET") {
    const reviewId = decodeURIComponent(reviewVerdictPath[1]);
    const { boardId, boardSlug } = boardHintsFromQuery(url);
    const row = resolveBoardFromHint(boardId, boardSlug);
    if (!row) throw httpError(400, "board_id_required");
    sendJson(res, 200, getReviewVerdict(reviewId, ctxFromBoardRow(row, actor)));
    return;
  }

  // /api/states/:id PATCH/DELETE — board resolved from query hint or scan.
  const statePath = url.pathname.match(/^\/api\/states\/([^/]+)$/);
  if (statePath) {
    const stateId = decodeURIComponent(statePath[1]);
    const { boardId, boardSlug } = boardHintsFromQuery(url);
    const hintRow = resolveBoardFromHint(boardId, boardSlug);
    const found = findBoardForState(stateId, hintRow?.id || null);
    if (!found) throw httpError(404, "state_not_found");
    const ctx = ctxFromBoardRow(found.board, actor);
    if (req.method === "PATCH") {
      const body = await readJson(req);
      sendMutationJson(res, 200, updateState(stateId, body, ctx), ctx);
      return;
    }
    if (req.method === "DELETE") {
      sendMutationJson(res, 200, deleteState(stateId, ctx), ctx);
      return;
    }
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  // /api/board-entries/:id PATCH — board resolved from query hint or scan.
  const entryPath = url.pathname.match(/^\/api\/board-entries\/([^/]+)$/);
  if (entryPath && req.method === "PATCH") {
    const entryId = decodeURIComponent(entryPath[1]);
    const { boardId, boardSlug } = boardHintsFromQuery(url);
    const hintRow = resolveBoardFromHint(boardId, boardSlug);
    const found = findBoardForBoardEntry(entryId, hintRow?.id || null);
    if (!found) throw httpError(404, "board_entry_not_found");
    const body = await readJson(req);
    const ctx = ctxFromBoardRow(found.board, actor);
    sendMutationJson(res, 200, updateBoardEntry(entryId, body, ctx), ctx);
    return;
  }

  // /api/relations POST — board resolved from source_ticket_id (cross-board
  // relations are explicitly not supported; the resolved source's board IS
  // the relation's board).
  if (req.method === "POST" && url.pathname === "/api/relations") {
    const body = await readJson(req);
    const hintId = body.board_id || url.searchParams.get("board_id");
    const hintSlug = body.board || url.searchParams.get("board");
    const explicit = resolveBoardFromHint(hintId, hintSlug);
    let row = explicit;
    if (!row && body.source_ticket_id) {
      const found = findBoardForTicket(body.source_ticket_id);
      if (!found) throw httpError(404, "ticket_not_found");
      row = found.board;
    }
    if (!row) throw httpError(400, "board_id_required");
    const ctx = ctxFromBoardRow(row, actor);
    sendMutationJson(res, 201, createRelation(body, ctx), ctx);
    return;
  }

  // /api/relations/:id DELETE — board resolved from query hint or scan.
  const relationPath = url.pathname.match(/^\/api\/relations\/([^/]+)$/);
  if (relationPath && req.method === "DELETE") {
    const relationId = decodeURIComponent(relationPath[1]);
    const { boardId, boardSlug } = boardHintsFromQuery(url);
    const hintRow = resolveBoardFromHint(boardId, boardSlug);
    const found = findBoardForRelation(relationId, hintRow?.id || null);
    if (!found) throw httpError(404, "relation_not_found");
    const ctx = ctxFromBoardRow(found.board, actor);
    deleteRelation(relationId, ctx);
    sendMutationJson(res, 200, { ok: true }, ctx);
    return;
  }

  // /api/search — board required (slug or id).
  if (req.method === "GET" && url.pathname === "/api/search") {
    const { boardId, boardSlug } = boardHintsFromQuery(url);
    const row = resolveBoardFromHint(boardId, boardSlug);
    if (!row) throw httpError(400, "board_id_required");
    const args = {
      q: url.searchParams.get("q") || "",
      limit: url.searchParams.get("limit"),
      mode: url.searchParams.get("mode"),
      include_full: url.searchParams.get("include_full") === "true" ? true : undefined,
      fields: url.searchParams.get("fields"),
      max_chars_per_field: url.searchParams.get("max_chars_per_field")
    };
    sendJson(res, 200, searchTickets(args, ctxFromBoardRow(row, actor)));
    return;
  }

  // Agent routes — board explicitly required to prevent cross-board claim.
  if (req.method === "POST" && url.pathname === "/api/agent/claim-next") {
    const body = await readJson(req);
    const hintId = body.board_id || url.searchParams.get("board_id");
    const hintSlug = body.board || url.searchParams.get("board");
    const row = resolveBoardFromHint(hintId, hintSlug);
    if (!row) throw httpError(400, "board_id_required");
    const ctx = ctxFromBoardRow(row, actor);
    sendMutationJson(res, 200, claimNext(body, ctx), ctx);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/checkpoint") {
    const body = await readJson(req);
    const tid = body.ticket_id;
    const hintId = body.board_id || url.searchParams.get("board_id");
    const hintSlug = body.board || url.searchParams.get("board");
    const explicit = resolveBoardFromHint(hintId, hintSlug);
    let row = explicit;
    if (!row && tid) {
      const found = findBoardForTicket(tid);
      if (!found) throw httpError(404, "ticket_not_found");
      row = found.board;
    }
    if (!row) throw httpError(400, "board_id_required");
    const ctx = ctxFromBoardRow(row, actor);
    sendMutationJson(res, 200, checkpointTicket(body, ctx), ctx);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/complete") {
    const body = await readJson(req);
    const tid = body.ticket_id;
    const hintId = body.board_id || url.searchParams.get("board_id");
    const hintSlug = body.board || url.searchParams.get("board");
    const explicit = resolveBoardFromHint(hintId, hintSlug);
    let row = explicit;
    if (!row && tid) {
      const found = findBoardForTicket(tid);
      if (!found) throw httpError(404, "ticket_not_found");
      row = found.board;
    }
    if (!row) throw httpError(400, "board_id_required");
    const ctx = ctxFromBoardRow(row, actor);
    sendMutationJson(res, 200, completeTicket(body, ctx), ctx);
    return;
  }

  // /api/admin/import — body.board_id required so we know which DB to import
  // into. Imports replace within one board's DB only.
  if (req.method === "POST" && url.pathname === "/api/admin/import") {
    const body = await readJson(req);
    const hintId = body.board_id || url.searchParams.get("board_id");
    const hintSlug = body.board || url.searchParams.get("board");
    const row = resolveBoardFromHint(hintId, hintSlug);
    if (!row) throw httpError(400, "board_id_required");
    const ctx = ctxFromBoardRow(row, actor);
    sendMutationJson(res, 201, importBoardSnapshot(body, ctx), ctx);
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}
