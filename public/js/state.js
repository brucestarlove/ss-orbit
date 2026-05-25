import { normalizeSettingsTab } from "./settings-tabs.js";

// Mutable application state plus board/ticket query helpers. The `state`
// object is the single source of truth for "what view is showing" and
// "what data did the bootstrap give us"; modules read it freely and mutate
// it in-place. The query helpers wrap the most common slices.

export const state = {
  data: null,
  /** Currently selected board id. Single-board UI; this points at the active
   *  board in `state.data.boards`. */
  boardId: "",
  /** URL-facing board identifier. Routes use slugs; API calls keep using ids. */
  boardSlug: "",
  selectedTicketId: "",
  expandedCardIds: new Set(),
  /** "empty" | "ticket" | "settings" — drives the main right overlay drawer (not the New flyout). */
  detailMode: "empty",
  /** "lanes" | "ai" | "repository" | "notes" | "journal" — which Settings tab is active. */
  settingsTab: normalizeSettingsTab(localStorage.getItem("mab_settings_tab")),
  /** Whether to render the priority pill on kanban / related cards. The detail
   *  drawer header always shows it. Default on; user can toggle it from the
   *  Lanes settings tab. */
  showPriority: localStorage.getItem("mab_show_priority") !== "false",
  eventSource: null
};

export function getSettingsTab() {
  return normalizeSettingsTab(state.settingsTab || localStorage.getItem("mab_settings_tab"));
}

export function syncBoardSelection() {
  if (!state.data) return;
  const boards = state.data.boards || [];
  let board = state.boardId ? boards.find((b) => b.id === state.boardId) : null;
  if (!board && state.boardSlug) {
    board = boards.find((b) => b.slug === state.boardSlug) || boards.find((b) => b.id === state.boardSlug);
  }
  if (!board) {
    const activeBoardId = state.data.active_board_id;
    board = boards.find((b) => b.id === activeBoardId) || boards[0] || null;
  }
  state.boardId = board?.id || "";
  state.boardSlug = board?.slug || "";
}

export function currentBoard() {
  return (state.data?.boards || []).find((b) => b.id === state.boardId);
}

/** Labels defined for the current board (from bootstrap), for autocomplete. */
export function boardLabelCatalog() {
  if (!state.boardId) return [];
  return (state.data?.labels || []).filter((label) => label.board_id === state.boardId);
}

export function statesForProject() {
  return state.data.states.filter((item) => item.board_id === state.boardId);
}

export function isAiReadyState(item) {
  return item?.role === "ai_ready" || item?.name === "AI Ready";
}

export function visibleStatesForProject() {
  const states = statesForProject();
  if (currentBoard()?.ai_enabled !== 0) return states;
  return states.filter((item) => !isAiReadyState(item));
}

export function selectableStatesForProject(currentStateId = "") {
  const states = statesForProject();
  if (currentBoard()?.ai_enabled !== 0) return states;
  return states.filter((item) => !isAiReadyState(item) || item.id === currentStateId);
}

export function ticketsForProject() {
  return state.data.tickets.filter((item) => item.board_id === state.boardId);
}

function compactTicketForBoard(ticket) {
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

function refreshBoardTicketDerivatives(boardId) {
  if (!state.data?.tickets) return;
  const boardTickets = state.data.tickets.filter((ticket) => ticket.board_id === boardId && !ticket.archived_at);
  const ticketById = new Map(boardTickets.map((ticket) => [ticket.id, ticket]));
  const childCountByParent = new Map();
  for (const ticket of boardTickets) {
    if (!ticket.parent_ticket_id) continue;
    childCountByParent.set(ticket.parent_ticket_id, (childCountByParent.get(ticket.parent_ticket_id) || 0) + 1);
  }
  for (const ticket of boardTickets) {
    ticket.parent_ticket = ticket.parent_ticket_id ? compactTicketForBoard(ticketById.get(ticket.parent_ticket_id)) : null;
    ticket.child_count = childCountByParent.get(ticket.id) || 0;
  }
}

/** Merge a ticket returned by a mutation/context endpoint into the bootstrap cache.
 * Keeps drawer edits responsive without paying for a full /api/bootstrap reload. */
export function upsertTicket(updatedTicket) {
  if (!state.data?.tickets || !updatedTicket?.id) return;
  const index = state.data.tickets.findIndex((ticket) => ticket.id === updatedTicket.id);
  const previous = index >= 0 ? state.data.tickets[index] : {};
  const merged = {
    ...previous,
    ...updatedTicket,
    labels: updatedTicket.labels || previous.labels || [],
    comment_count: updatedTicket.comment_count ?? previous.comment_count ?? 0,
    child_count: updatedTicket.child_count ?? previous.child_count ?? 0,
    parent_ticket: updatedTicket.parent_ticket || previous.parent_ticket || null
  };
  if (index >= 0) state.data.tickets.splice(index, 1, merged);
  else state.data.tickets.push(merged);
  state.data.tickets.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")) || String(a.id).localeCompare(String(b.id)));
  refreshBoardTicketDerivatives(merged.board_id || state.boardId);
}
