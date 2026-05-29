// Application entry point. Imports `starscape.js` for its side effects
// (canvas + theme toggle init), wires the topbar buttons and global
// keyboard/click listeners, and kicks off the bootstrap → router activation
// sequence. The reusable `load` / `render` helpers live in app.js so feature
// modules can import them without creating cycles back through this entry.

import "./starscape.js";

import {
  $,
  boardMenuBtn,
  boardFlyout,
  drawer,
  drawerBackdrop,
  createFlyoutBackdrop,
  searchInput
} from "./dom.js";
import { state } from "./state.js";
import { api, withBoardQuery } from "./api.js";
import { toast, debounce } from "./toast.js";
import {
  navigate,
  applyRoute,
  currentRoute,
  hasRoute,
  syncUrlFromState,
  setRouterReady
} from "./router.js";
import {
  openBoardFlyout,
  closeBoardFlyout,
  closeMenuFlyouts
} from "./board-menu.js";
import {
  openCreateFlyout,
  closeCreateFlyout,
  isCreateFlyoutOpen
} from "./create-card.js";
import { enableKanbanDragScroll, enableKanbanInteractions } from "./kanban.js";
import { runSearch, hideSearch } from "./search.js";
import { load } from "./app.js";
import { edition } from "./config.js";
import { openModal, wireModal } from "./modal.js";

async function init() {
  const welcomeDialog = document.getElementById("welcomeDialog");
  wireModal(welcomeDialog);
  if (edition === "preview") {
    openModal(welcomeDialog);
  }

  $("#settingsBtn").addEventListener("click", async () => {
    closeCreateFlyout();
    closeMenuFlyouts();
    navigate({
      boardId: state.boardId,
      view: "settings",
      tab: state.settingsTab || "lanes"
    });
  });

  boardMenuBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!boardFlyout.hidden) {
      closeBoardFlyout();
      return;
    }
    openBoardFlyout();
  });

  $("#newTicketBtn").addEventListener("click", () => {
    if (isCreateFlyoutOpen()) {
      closeCreateFlyout();
      return;
    }
    openCreateFlyout("");
  });

  createFlyoutBackdrop.addEventListener("click", () => {
    closeCreateFlyout();
  });

  $("#drawerCloseBtn").addEventListener("click", () => {
    navigate({
      boardId: state.boardId,
      view: "board"
    });
  });

  $("#drawerArchiveBtn").addEventListener("click", async () => {
    const ticketId = state.selectedTicketId;
    if (!ticketId || state.detailMode !== "ticket") return;
    const ticket = state.data?.tickets?.find((t) => t.id === ticketId);
    const titleForToast = ticket?.title || "card";
    await api(withBoardQuery(`/api/tickets/${encodeURIComponent(ticketId)}/archive`), { method: "POST" });
    toast.error(`Archived: ${titleForToast}`);
    await load();
    navigate({ boardId: state.boardId, view: "board" });
  });

  drawerBackdrop.addEventListener("click", () => {
    navigate({
      boardId: state.boardId,
      view: "board"
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!boardFlyout.hidden) {
      closeMenuFlyouts();
      return;
    }
    if (isCreateFlyoutOpen()) {
      closeCreateFlyout();
      return;
    }
    if (!drawer.classList.contains("is-open")) return;
    const el = document.activeElement;
    if (el?.classList?.contains("inline-title-editor") || el?.classList?.contains("inline-desc-editor")) return;
    navigate({
      boardId: state.boardId,
      view: "board"
    });
  });

  searchInput.addEventListener("input", debounce(runSearch, 220));
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#topbarSearch")) hideSearch();
    if (!event.target.closest(".topbar-menu")) closeMenuFlyouts();
  });

  enableKanbanDragScroll();
  enableKanbanInteractions();

  const initialRoute = currentRoute();
  if (initialRoute.boardSlug) state.boardSlug = initialRoute.boardSlug;
  await load();

  // Activate the router. If the page was loaded with a hash route, restore
  // that view; otherwise canonicalize the URL to reflect the current
  // state so the back button has a starting point.
  setRouterReady(true);
  if (hasRoute()) {
    await applyRoute();
  } else {
    syncUrlFromState({ replace: true });
  }
}

init();
