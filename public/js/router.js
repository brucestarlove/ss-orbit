// Hash router. Copy/share URLs use board slugs, such as
// `#/b/<boardSlug>`, `#/b/<boardSlug>/t/<ticketId>`, and
// `#/b/<boardSlug>/settings/<tab>`. Keeping routing in the hash lets the
// preview app keep working when mounted under `/app/` or opened as static HTML.

import { currentBoard, state } from "./state.js";
import { normalizeSettingsTab } from "./settings-tabs.js";
import { closeMenuFlyouts } from "./board-menu.js";
import { closeCreateFlyout } from "./create-card.js";
import {
  buildRoute,
  hasRoute,
  isCanonicalRouteUrl,
  parseRoute
} from "./url-routes.js";

export { buildRoute, hasRoute, parseRoute } from "./url-routes.js";

function boardBySlugOrId(value) {
  if (!value) return null;
  const boards = state.data?.boards || [];
  return boards.find((b) => b.slug === value) || boards.find((b) => b.id === value) || null;
}

function routeBoardSlug(routeObj = {}) {
  if (routeObj.boardSlug) return routeObj.boardSlug;
  if (routeObj.boardId) return boardBySlugOrId(routeObj.boardId)?.slug || routeObj.boardId;
  return currentBoard()?.slug || state.boardSlug || "";
}

function normalizeRouteForUrl(routeObj = {}) {
  return {
    ...routeObj,
    boardSlug: routeBoardSlug(routeObj)
  };
}

function routeFromState() {
  let view = "board";
  if (state.detailMode === "ticket" && state.selectedTicketId) view = "ticket";
  else if (state.detailMode === "settings") view = "settings";
  return {
    boardSlug: currentBoard()?.slug || state.boardSlug,
    view,
    ticketId: state.selectedTicketId,
    tab: view === "settings" ? normalizeSettingsTab(state.settingsTab) : ""
  };
}

let routerReady = false;

export function setRouterReady(value) {
  routerReady = value;
}

export function currentRoute() {
  return parseRoute(location);
}

export async function navigate(routeObj, { replace = false } = {}) {
  const route = normalizeRouteForUrl(routeObj);
  const url = buildRoute(route);
  if (isCanonicalRouteUrl(location, route)) {
    if (routerReady) await applyRoute();
    return;
  }
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  if (routerReady) await applyRoute();
}

// Push or replace the URL to match the current `state` without re-rendering.
// Used after flows that already mutated state and called load()/render()
// (e.g. ticket/board creation).
export function syncUrlFromState({ replace = false } = {}) {
  const route = routeFromState();
  const url = buildRoute(route);
  if (isCanonicalRouteUrl(location, route)) return;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
}

export async function applyRoute() {
  const { load, renderDetailOnly } = await import("./app.js");
  const r = currentRoute();
  const urlHadRoute = hasRoute(location);
  const prevBoardId = state.boardId;
  const routeBoard = boardBySlugOrId(r.boardSlug);
  const fallbackBoard = routeBoard || (r.boardSlug ? currentBoard() : null);

  if (fallbackBoard) {
    state.boardId = fallbackBoard.id;
    state.boardSlug = fallbackBoard.slug;
  } else if (r.boardSlug) {
    state.boardSlug = r.boardSlug;
  }

  const canonicalRoute = fallbackBoard ? { ...r, boardSlug: fallbackBoard.slug } : r;
  if (urlHadRoute && !isCanonicalRouteUrl(location, canonicalRoute)) {
    history.replaceState(null, "", buildRoute(canonicalRoute));
  }

  if (r.view === "ticket") {
    state.selectedTicketId = r.ticketId || "";
    state.detailMode = r.ticketId ? "ticket" : "empty";
  } else if (r.view === "settings") {
    state.selectedTicketId = "";
    state.detailMode = "settings";
    if (r.tab) {
      state.settingsTab = r.tab;
      try {
        localStorage.setItem("mab_settings_tab", r.tab);
      } catch {
        /* ignore */
      }
    }
  } else {
    state.selectedTicketId = "";
    state.detailMode = "empty";
  }

  closeMenuFlyouts();
  closeCreateFlyout();

  if (state.boardId && state.boardId !== prevBoardId) {
    await load();
    return;
  }
  await renderDetailOnly();
}

window.addEventListener("popstate", () => {
  if (routerReady) void applyRoute();
});
