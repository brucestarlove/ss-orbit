// Hash-based router. The URL hash is the source of truth for which view is
// shown. `navigate()` writes to it; the popstate listener replays it. The
// in-memory `state` object is still used for rendering — applyRoute() just
// mirrors the parsed hash into `state` before calling render().

import { state } from "./state.js";
import { SETTINGS_TAB_IDS, normalizeSettingsTab } from "./settings-tabs.js";
import { closeMenuFlyouts } from "./board-menu.js";
import { closeCreateFlyout } from "./create-card.js";

const Route = {
  parse(hash) {
    const cleaned = String(hash || "").replace(/^#/, "").replace(/^\/+/, "");
    const parts = cleaned ? cleaned.split("/") : [];
    const out = { boardId: "", view: "board", ticketId: "", tab: "" };
    let i = 0;
    if (parts[i] === "b" && parts[i + 1]) { out.boardId = decodeURIComponent(parts[i + 1]); i += 2; }
    if (parts[i] === "t" && parts[i + 1]) {
      out.view = "ticket";
      out.ticketId = decodeURIComponent(parts[i + 1]);
    } else if (parts[i] === "settings") {
      out.view = "settings";
      const t = parts[i + 1];
      if (t && SETTINGS_TAB_IDS.has(t)) out.tab = t;
    }
    return out;
  },
  build({ boardId = "", view = "board", ticketId = "", tab = "" } = {}) {
    const segs = [];
    if (boardId) segs.push("b", encodeURIComponent(boardId));
    if (view === "ticket" && ticketId) segs.push("t", encodeURIComponent(ticketId));
    else if (view === "settings") {
      segs.push("settings");
      if (tab && SETTINGS_TAB_IDS.has(tab)) segs.push(tab);
    }
    return "#/" + segs.join("/");
  },
  fromState() {
    let view = "board";
    if (state.detailMode === "ticket" && state.selectedTicketId) view = "ticket";
    else if (state.detailMode === "settings") view = "settings";
    return {
      boardId: state.boardId,
      view,
      ticketId: state.selectedTicketId,
      tab: view === "settings" ? normalizeSettingsTab(state.settingsTab) : ""
    };
  }
};

let routerReady = false;

export function setRouterReady(value) {
  routerReady = value;
}

export async function navigate(routeObj, { replace = false } = {}) {
  const hash = Route.build(routeObj);
  if (location.hash === hash) {
    if (routerReady) await applyRoute();
    return;
  }
  if (replace) history.replaceState(null, "", hash);
  else history.pushState(null, "", hash);
  if (routerReady) await applyRoute();
}

// Push or replace the URL to match the current `state` without re-rendering.
// Used after flows that already mutated state and called load()/render()
// (e.g. ticket/board creation).
export function syncUrlFromState({ replace = false } = {}) {
  const hash = Route.build(Route.fromState());
  if (location.hash === hash) return;
  if (replace) history.replaceState(null, "", hash);
  else history.pushState(null, "", hash);
}

export async function applyRoute() {
  const { load, render } = await import("./app.js");
  const r = Route.parse(location.hash);
  const prevBoardId = state.boardId;
  if (r.boardId) state.boardId = r.boardId;

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

  if (r.boardId && r.boardId !== prevBoardId) {
    await load();
  }
  await render();
}

window.addEventListener("popstate", () => {
  if (routerReady) void applyRoute();
});
