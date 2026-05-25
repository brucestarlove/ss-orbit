// Bootstrap reload + top-level render. Extracted from main.js so feature
// modules can import `load` / `render` without pulling in the entry-point
// init wiring (which would create import cycles).

import { state, syncBoardSelection } from "./state.js";
import { api, bootstrapPath } from "./api.js";
import { renderBoard, renderBoardSelection } from "./kanban.js";
import { renderDetail } from "./ticket-detail.js";
import { closeMenuFlyouts, updateTopbarChips } from "./board-menu.js";
import { connectEventStream } from "./sse.js";
import { seedReadIfNeeded } from "./unread.js";
import { features } from "./config.js";

let sseBoardId = null;

export async function load() {
  closeMenuFlyouts();
  state.data = await api(bootstrapPath());
  syncBoardSelection();
  // First-time-per-board seed so existing cards don't all flash unread.
  // No-op once the seed flag is set for this board.
  seedReadIfNeeded(state.boardId, state.data?.tickets || []);
  await render();
  if (features.sse && state.boardId !== sseBoardId) {
    sseBoardId = state.boardId;
    connectEventStream();
  }
}

export async function render() {
  syncBoardSelection();
  updateTopbarChips();
  renderBoard();
  await renderDetail();
}

export async function renderDetailOnly() {
  syncBoardSelection();
  updateTopbarChips();
  renderBoardSelection();
  await renderDetail();
}
