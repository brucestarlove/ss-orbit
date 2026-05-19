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
  if (!state.boardId || !boards.some((b) => b.id === state.boardId)) {
    state.boardId = boards[0]?.id || "";
  }
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
