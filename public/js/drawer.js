// Right-side overlay drawer used for ticket detail and project settings.
// Owns the open/close transition state and the shared header layout
// (eyebrow, title, subtitle, tabs, archive/close buttons). Bodies are
// rendered by the feature modules that call `renderDrawerShell`.

import { drawer, drawerInner, drawerBackdrop } from "./dom.js";
import { state } from "./state.js";
import { escapeHtml } from "./format.js";

/** Bumps on each open/close so a stale `transitionend` from an old close cannot clear a newly opened drawer. */
let drawerToken = 0;

/** Slide the right drawer in (ticket detail, project settings, or create form). */
export function openDrawer() {
  drawerToken += 1;
  drawer.hidden = false;
  drawerBackdrop.hidden = false;
  requestAnimationFrame(() => {
    drawer.classList.add("is-open");
    drawerBackdrop.classList.add("is-visible");
  });
}

/**
 * Close the drawer overlay. Uses transitionend with a timeout fallback for `hidden`.
 * `drawerToken` invalidates pending finish callbacks if the user opens the drawer again mid-animation.
 */
export function closeDrawer() {
  const finishToken = ++drawerToken;
  const wasOpen = drawer.classList.contains("is-open");
  drawer.classList.remove("is-open");
  drawerBackdrop.classList.remove("is-visible");

  const finish = () => {
    if (drawerToken !== finishToken) return;
    drawer.hidden = true;
    drawerBackdrop.hidden = true;
    drawerInner.innerHTML = "";
    const titleBlockEl = document.getElementById("drawerTitleBlock");
    const tabsEl = document.getElementById("drawerTabs");
    if (titleBlockEl) titleBlockEl.innerHTML = "";
    if (tabsEl) { tabsEl.innerHTML = ""; tabsEl.hidden = true; }
    drawer.classList.remove("is-wide");
  };

  if (!wasOpen) {
    finish();
    return;
  }

  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    finish();
  };

  drawer.addEventListener("transitionend", end, { once: true });
  setTimeout(end, 360);
}

/**
 * Fill the drawer's header + body slots. All drawer modes (ticket, project,
 * create) should route through this so the header/title/close/tabs stay
 * structurally consistent. `body` is an HTML string assigned to drawerInner.
 */
export function renderDrawerShell({ eyebrow, title, titleAttrs, subtitleHtml, tabs, activeTab, onTabSelect, body, mode }) {
  drawer.classList.toggle("is-settings", mode === "settings");
  drawer.classList.toggle("is-wide", mode === "ticket" || mode === "settings");
  const titleBlockEl = document.getElementById("drawerTitleBlock");
  const tabsEl = document.getElementById("drawerTabs");

  // Rebuild the eyebrow / title / subtitle wholesale each render. Like
  // drawerInner.innerHTML below, this means any listeners the caller attached
  // last render (e.g. the inline title editor's click handler) die with the
  // old nodes, instead of stacking on persistent shell elements.
  const extraTitleClass = titleAttrs?.class ? ` ${titleAttrs.class}` : "";
  let titleAttrHtml = ` class="drawer-title-text${extraTitleClass}"`;
  for (const [key, value] of Object.entries(titleAttrs || {})) {
    if (key === "class") continue;
    titleAttrHtml += ` ${key}="${escapeHtml(String(value))}"`;
  }
  const segments = [];
  if (eyebrow) segments.push(`<span class="drawer-eyebrow">${escapeHtml(eyebrow)}</span>`);
  segments.push(`<h2${titleAttrHtml}>${escapeHtml(title ?? "")}</h2>`);
  if (subtitleHtml) segments.push(`<div class="drawer-subtitle">${subtitleHtml}</div>`);
  titleBlockEl.innerHTML = segments.join("");

  if (tabs && tabs.length) {
    tabsEl.hidden = false;
    tabsEl.innerHTML = tabs
      .map(
        (t) =>
          `<button type="button" role="tab" class="drawer-tab ${
            t.id === activeTab ? "is-active" : ""
          }" data-drawer-tab="${escapeHtml(t.id)}" aria-selected="${t.id === activeTab}">${escapeHtml(t.label)}</button>`
      )
      .join("");
    if (typeof onTabSelect === "function") {
      tabsEl.querySelectorAll(".drawer-tab").forEach((btn) => {
        btn.addEventListener("click", () => onTabSelect(btn.dataset.drawerTab));
      });
    }
  } else {
    tabsEl.hidden = true;
    tabsEl.innerHTML = "";
  }

  const archiveBtn = document.getElementById("drawerArchiveBtn");
  if (archiveBtn) archiveBtn.hidden = state.detailMode !== "ticket";

  drawerInner.innerHTML = body ?? "";
}
