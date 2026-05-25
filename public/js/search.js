// Topbar search. Debounced via the input handler in main.js; queries the
// /api/search endpoint and renders a small results dropdown that navigates
// to the chosen ticket on click.

import { searchInput, searchResults } from "./dom.js";
import { state, currentBoard } from "./state.js";
import { api } from "./api.js";
import { navigate } from "./router.js";
import { escapeHtml, stateClassFor, ticketLabel } from "./format.js";
import { closeCreateFlyout } from "./create-card.js";

export async function runSearch() {
  const query = searchInput.value.trim();
  if (query.length < 2) {
    hideSearch();
    return;
  }
  const board = currentBoard();
  if (!board) return;
  const result = await api(`/api/search?q=${encodeURIComponent(query)}&board=${encodeURIComponent(board.slug)}`);
  if (result.results.length === 0) {
    searchResults.hidden = false;
    searchResults.innerHTML = `<div class="search-hit">No results</div>`;
    return;
  }
  searchResults.hidden = false;
  searchResults.innerHTML = result.results
    .map(
      (ticket) => `
        <div class="search-hit" data-ticket-id="${ticket.id}">
          <span class="search-hit-main">
            <strong>${escapeHtml(ticketLabel(ticket))}</strong>
            <span class="search-hit-title">${escapeHtml(ticket.title)}</span>
          </span>
          <span class="search-hit-state state-pill-${escapeHtml(stateClassFor(ticket))}">${escapeHtml(ticket.state_name || "State")}</span>
        </div>
      `
    )
    .join("");
  searchResults.querySelectorAll("[data-ticket-id]").forEach((hit) => {
    hit.addEventListener("click", async () => {
      closeCreateFlyout();
      hideSearch();
      navigate({
        boardId: state.boardId,
        view: "ticket",
        ticketId: hit.dataset.ticketId
      });
    });
  });
}

export function hideSearch() {
  searchResults.hidden = true;
  searchResults.innerHTML = "";
}
