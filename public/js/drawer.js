// Right-side overlay drawer used for ticket detail and project settings.
// Owns the open/close transition state and the shared header layout
// (eyebrow, title, subtitle, tabs, archive/close buttons). Bodies are
// rendered by the feature modules that call `renderDrawerShell`.

import { drawer, drawerInner, drawerBackdrop } from "./dom.js";
import { state } from "./state.js";
import { escapeHtml } from "./format.js";

/** Bumps on each open/close so a stale `transitionend` from an old close cannot clear a newly opened drawer. */
let drawerToken = 0;

/** Aborts scroll/resize observers when tabs are re-rendered or the drawer closes. */
let drawerTabsScrollAbort = null;

/** Toggle edge-fade classes on the tab shell when the strip can scroll further left/right. */
function syncDrawerTabsScrollState(tabsEl) {
  const shellEl = document.getElementById("drawerTabsShell");
  if (!tabsEl || !shellEl) return;

  const maxScroll = tabsEl.scrollWidth - tabsEl.clientWidth;
  if (maxScroll <= 1) {
    shellEl.classList.remove("can-scroll-left", "can-scroll-right");
    return;
  }

  shellEl.classList.toggle("can-scroll-left", tabsEl.scrollLeft > 1);
  shellEl.classList.toggle("can-scroll-right", tabsEl.scrollLeft < maxScroll - 1);
}

/** Keep the active settings tab visible when the strip overflows horizontally. */
function scrollActiveDrawerTabIntoView(tabsEl) {
  tabsEl
    ?.querySelector(".drawer-tab.is-active")
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function teardownDrawerTabsScroll() {
  drawerTabsScrollAbort?.abort();
  drawerTabsScrollAbort = null;
  const shellEl = document.getElementById("drawerTabsShell");
  const tabsEl = document.getElementById("drawerTabs");
  shellEl?.classList.remove("can-scroll-left", "can-scroll-right");
  tabsEl?.classList.remove("is-grabbing");
}

function bindDrawerTabsScroll(tabsEl) {
  teardownDrawerTabsScroll();
  if (!tabsEl) return;

  const controller = new AbortController();
  drawerTabsScrollAbort = controller;
  const { signal } = controller;

  const onScrollChange = () => syncDrawerTabsScrollState(tabsEl);
  tabsEl.addEventListener("scroll", onScrollChange, { passive: true, signal });

  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(onScrollChange);
    observer.observe(tabsEl);
    signal.addEventListener("abort", () => observer.disconnect(), { once: true });
  }

  // Vertical wheel over the tab strip pans horizontally (no Shift required).
  const LINE_SCROLL_PX = 16;
  const wheelPixels = (value, mode) => {
    if (mode === WheelEvent.DOM_DELTA_LINE) return value * LINE_SCROLL_PX;
    if (mode === WheelEvent.DOM_DELTA_PAGE) return value * Math.max(tabsEl.clientWidth, 1);
    return value;
  };

  tabsEl.addEventListener(
    "wheel",
    (event) => {
      if (event.defaultPrevented || event.ctrlKey) return;
      if (tabsEl.scrollWidth <= tabsEl.clientWidth) return;

      const horizontalDelta = event.deltaX || event.deltaY;
      if (!horizontalDelta) return;

      event.preventDefault();
      tabsEl.scrollLeft += wheelPixels(horizontalDelta, event.deltaMode);
    },
    { passive: false, signal }
  );

  // Click-and-drag horizontal panning; threshold keeps tab clicks intact.
  const DRAG_THRESHOLD = 4;
  let dragActive = false;
  let dragged = false;
  let startX = 0;
  let startScroll = 0;
  let pointerId = 0;

  tabsEl.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0) return;
      if (tabsEl.scrollWidth <= tabsEl.clientWidth) return;
      dragged = false;
      dragActive = true;
      pointerId = event.pointerId;
      startX = event.clientX;
      startScroll = tabsEl.scrollLeft;
    },
    { signal }
  );

  tabsEl.addEventListener(
    "pointermove",
    (event) => {
      if (!dragActive || event.pointerId !== pointerId) return;
      const delta = event.clientX - startX;
      if (!dragged && Math.abs(delta) > DRAG_THRESHOLD) {
        dragged = true;
        try {
          tabsEl.setPointerCapture(pointerId);
        } catch {
          /* no-op: some browsers can't capture here */
        }
        tabsEl.classList.add("is-grabbing");
      }
      if (dragged) {
        event.preventDefault();
        tabsEl.scrollLeft = startScroll - delta;
      }
    },
    { signal }
  );

  const endDrag = (event) => {
    if (!dragActive || (event && event.pointerId !== pointerId)) return;
    dragActive = false;
    tabsEl.classList.remove("is-grabbing");
    try {
      tabsEl.releasePointerCapture(pointerId);
    } catch {
      /* no-op */
    }
  };

  tabsEl.addEventListener("pointerup", endDrag, { signal });
  tabsEl.addEventListener("pointercancel", endDrag, { signal });
  tabsEl.addEventListener("pointerleave", endDrag, { signal });

  tabsEl.addEventListener(
    "click",
    (event) => {
      if (dragged) {
        event.stopPropagation();
        event.preventDefault();
        dragged = false;
      }
    },
    { capture: true, signal }
  );

  requestAnimationFrame(() => {
    if (signal.aborted) return;
    onScrollChange();
    scrollActiveDrawerTabIntoView(tabsEl);
  });
}

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
    const tabsShellEl = document.getElementById("drawerTabsShell");
    if (titleBlockEl) titleBlockEl.innerHTML = "";
    if (tabsEl) tabsEl.innerHTML = "";
    if (tabsShellEl) tabsShellEl.hidden = true;
    teardownDrawerTabsScroll();
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
  const tabsShellEl = document.getElementById("drawerTabsShell");

  // Rebuild the eyebrow / title / subtitle wholesale each render. Like
  // drawerInner.innerHTML below, this means any listeners the caller attached
  // last render (e.g. the inline title editor's click handler) die with the
  // old nodes, instead of stacking on persistent shell elements.
  const extraTitleClass = titleAttrs?.class ? ` ${titleAttrs.class}` : "";
  let titleAttrHtml = ` class="drawer-title drawer-title-text${extraTitleClass}"`;
  for (const [key, value] of Object.entries(titleAttrs || {})) {
    if (key === "class") continue;
    titleAttrHtml += ` ${key}="${escapeHtml(String(value))}"`;
  }
  const segments = [];
  if (eyebrow) segments.push(`<span class="drawer-eyebrow">${escapeHtml(eyebrow)}</span>`);
  if (title != null && String(title).trim() !== "") {
    segments.push(`<h2${titleAttrHtml}>${escapeHtml(title)}</h2>`);
  }
  if (subtitleHtml) segments.push(`<div class="drawer-subtitle">${subtitleHtml}</div>`);
  titleBlockEl.innerHTML = segments.join("");

  if (tabs && tabs.length) {
    if (tabsShellEl) tabsShellEl.hidden = false;
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
    bindDrawerTabsScroll(tabsEl);
  } else {
    if (tabsShellEl) tabsShellEl.hidden = true;
    tabsEl.innerHTML = "";
    teardownDrawerTabsScroll();
  }

  const archiveBtn = document.getElementById("drawerArchiveBtn");
  if (archiveBtn) archiveBtn.hidden = state.detailMode !== "ticket";

  drawerInner.innerHTML = body ?? "";
}
