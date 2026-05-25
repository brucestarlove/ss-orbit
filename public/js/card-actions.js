// Shared card action menu data, mutations, and desktop context-menu presentation.
// Mobile can reuse buildCardActionMenu() + createCardActionHandlers() and render
// the same model as a bottom sheet without duplicating mutation logic.
//
// Submenus are reparented to document.body on open so they escape the menu's
// backdrop-filter containing block (otherwise position: fixed coords would be
// interpreted relative to the menu instead of the viewport).

import { api, withBoardQuery } from "./api.js";
import { state, visibleStatesForProject } from "./state.js";
import { canonicalTicketType, escapeHtml, priorityLabel, typeLabel } from "./format.js";
import { toast } from "./toast.js";

const CARD_TYPES = ["epic", "feature", "task", "bug"];
const PRIORITIES = [0, 1, 2, 3, 4];
const MENU_MARGIN = 8;
const SUBMENU_GAP = 6;
const HOVER_CLOSE_DELAY = 180;

let openMenu = null;
let dragInFlight = false;
let dismissController = null;
let lastFocusedElement = null;
const submenuByItem = new WeakMap();
const itemBySubmenu = new WeakMap();
const openSubmenus = new Set();
let pendingCloseTimer = null;

export function buildCardActionMenu(ticket, lanes = visibleStatesForProject()) {
  if (!ticket) return [];
  return [
    {
      id: "move",
      label: "Move to",
      children: lanes.map((lane) => ({
        id: `move:${lane.id}`,
        label: lane.name,
        action: "move",
        value: lane.id,
        checked: lane.id === ticket.state_id,
        disabled: lane.id === ticket.state_id
      }))
    },
    {
      id: "priority",
      label: "Priority",
      children: PRIORITIES.map((priority) => ({
        id: `priority:${priority}`,
        label: priorityLabel(priority),
        action: "priority",
        value: priority,
        checked: Number(ticket.priority) === priority,
        disabled: Number(ticket.priority) === priority
      }))
    },
    {
      id: "type",
      label: "Type",
      children: CARD_TYPES.map((type) => ({
        id: `type:${type}`,
        label: typeLabel(type),
        action: "type",
        value: type,
        checked: canonicalTicketType(ticket.type) === type,
        disabled: canonicalTicketType(ticket.type) === type
      }))
    },
    { id: "open", label: "Open", action: "open" },
    { id: "archive", label: "Archive", action: "archive", danger: true }
  ];
}

export function calculateMenuPosition({ x, y, menuWidth, menuHeight, viewportWidth, viewportHeight, margin = MENU_MARGIN }) {
  const maxLeft = Math.max(margin, viewportWidth - menuWidth - margin);
  const maxTop = Math.max(margin, viewportHeight - menuHeight - margin);
  const preferredLeft = x + menuWidth + margin > viewportWidth ? x - menuWidth : x;
  const preferredTop = y + menuHeight + margin > viewportHeight ? y - menuHeight : y;
  return {
    left: Math.min(Math.max(margin, preferredLeft), maxLeft),
    top: Math.min(Math.max(margin, preferredTop), maxTop)
  };
}

export function calculateSubmenuPosition({
  triggerRect,
  submenuWidth,
  submenuHeight,
  viewportWidth,
  viewportHeight,
  margin = MENU_MARGIN,
  gap = SUBMENU_GAP
}) {
  const maxLeft = Math.max(margin, viewportWidth - submenuWidth - margin);
  const rightLeft = triggerRect.right + gap;
  const leftLeft = triggerRect.left - submenuWidth - gap;
  const fitsRight = rightLeft + submenuWidth + margin <= viewportWidth;
  const fitsLeft = leftLeft >= margin;
  const preferredLeft = fitsRight || !fitsLeft ? rightLeft : leftLeft;
  const maxHeight = Math.max(0, viewportHeight - margin * 2);
  const boundedHeight = Math.min(submenuHeight, maxHeight);
  const maxTop = Math.max(margin, viewportHeight - boundedHeight - margin);
  const preferredTop = triggerRect.top - gap;

  return {
    left: Math.min(Math.max(margin, preferredLeft), maxLeft),
    top: Math.min(Math.max(margin, preferredTop), maxTop),
    maxHeight
  };
}

export function createCardActionHandlers({ apiClient = api, navigator = null, confirmer = globalThis.confirm } = {}) {
  async function patchTicket(ticket, body) {
    await apiClient(withBoardQuery(`/api/tickets/${encodeURIComponent(ticket.id)}`), {
      method: "PATCH",
      body
    });
  }

  return {
    async open(ticket) {
      if (navigator) return navigator({ boardId: state.boardId, view: "ticket", ticketId: ticket.id });
      return null;
    },
    async move(ticket, stateId) {
      await patchTicket(ticket, { state_id: stateId });
    },
    async priority(ticket, priority) {
      await patchTicket(ticket, { priority });
    },
    async type(ticket, type) {
      await patchTicket(ticket, { type });
    },
    async archive(ticket) {
      if (typeof confirmer === "function" && !confirmer(`Archive "${ticket.title || "card"}"? You can restore it from Settings → Card Archive.`)) return false;
      await apiClient(withBoardQuery(`/api/tickets/${encodeURIComponent(ticket.id)}/archive`), { method: "POST" });
      toast.error(`Archived: ${ticket.title || "card"}`);
      return true;
    }
  };
}

export function setCardActionDragInFlight(value) {
  dragInFlight = Boolean(value);
}

export function closeCardActionMenu({ restoreFocus = false } = {}) {
  cancelPendingClose();
  if (dismissController) {
    dismissController.abort();
    dismissController = null;
  }
  for (const submenu of openSubmenus) {
    if (submenu.isConnected) submenu.remove();
  }
  openSubmenus.clear();
  if (openMenu) {
    openMenu.querySelectorAll(".card-action-menu-item.has-submenu").forEach((item) => {
      const submenu = submenuByItem.get(item);
      if (submenu?.isConnected) submenu.remove();
      submenuByItem.delete(item);
    });
    openMenu.remove();
    openMenu = null;
  }
  if (restoreFocus && lastFocusedElement?.isConnected) {
    lastFocusedElement.focus({ preventScroll: true });
  }
  lastFocusedElement = null;
}

export function openCardActionMenu({ ticket, anchor, x, y, handlers = createCardActionHandlers(), onBeforeOpen = null }) {
  closeCardActionMenu();
  if (!ticket || dragInFlight) return null;

  if (typeof onBeforeOpen === "function") onBeforeOpen();
  lastFocusedElement = anchor || document.activeElement;

  const menu = document.createElement("div");
  menu.className = "card-action-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `Actions for #${ticket.number || ""} ${ticket.title || "card"}`.trim());
  menu.dataset.ticketId = ticket.id;
  menu.innerHTML = renderMenuItems(buildCardActionMenu(ticket));
  document.body.append(menu);
  openMenu = menu;

  // Detach each submenu from its <li> and reparent to document.body. The menu's
  // backdrop-filter creates a containing block, so a nested position:fixed
  // submenu would be positioned relative to the menu, not the viewport.
  menu.querySelectorAll(".card-action-menu-item.has-submenu").forEach((item) => {
    const submenu = item.querySelector(":scope > .card-action-submenu");
    if (!submenu) return;
    submenu.remove();
    document.body.append(submenu);
    submenuByItem.set(item, submenu);
    itemBySubmenu.set(submenu, item);
    wireSubmenu(submenu, ticket, handlers);
  });

  const rect = menu.getBoundingClientRect();
  const position = calculateMenuPosition({
    x,
    y,
    menuWidth: rect.width,
    menuHeight: rect.height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight
  });
  menu.style.left = `${position.left}px`;
  menu.style.top = `${position.top}px`;

  wireMenu(menu, ticket, handlers);
  const first = firstEnabledItem(menu);
  first?.focus({ preventScroll: true });

  dismissController = new AbortController();
  const signal = dismissController.signal;
  requestAnimationFrame(() => {
    document.addEventListener("pointerdown", dismissOnOutsidePointer, { signal, capture: true });
  });
  document.addEventListener("keydown", dismissOnEscape, { signal, capture: true });
  document.addEventListener("scroll", dismissOnScroll, { signal, capture: true, passive: true });
  window.addEventListener("resize", () => closeCardActionMenu(), { signal, passive: true });
  window.addEventListener("blur", () => closeCardActionMenu(), { signal });

  return menu;
}

export function bindCardContextMenu(card, ticket, { handlers = createCardActionHandlers(), onBeforeOpen = null } = {}) {
  card.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (dragInFlight) {
      closeCardActionMenu();
      return;
    }
    openCardActionMenu({
      ticket,
      anchor: card,
      x: event.clientX,
      y: event.clientY,
      handlers,
      onBeforeOpen
    });
  });
}

function renderMenuItems(items) {
  return `<ul class="card-action-menu-list" role="none">${items.map(renderMenuItem).join("")}</ul>`;
}

function renderMenuItem(item) {
  const hasChildren = Boolean(item.children?.length);
  const classes = ["card-action-menu-item"];
  if (hasChildren) classes.push("has-submenu");
  if (item.danger) classes.push("is-danger");
  const check = item.checked ? `<span class="card-action-check" aria-hidden="true">✓</span>` : `<span class="card-action-check" aria-hidden="true"></span>`;
  const suffix = hasChildren ? `<span class="card-action-arrow" aria-hidden="true">›</span>` : "";
  return `
    <li class="${classes.join(" ")}" role="none">
      <button type="button"
        class="card-action-button"
        role="menuitem${item.checked ? "checkbox" : ""}"
        data-action="${escapeHtml(item.action || "")}" data-value="${escapeHtml(item.value ?? "")}" data-menu-id="${escapeHtml(item.id)}"
        ${item.disabled ? "disabled" : ""}
        ${item.checked ? 'aria-checked="true"' : ""}
        ${hasChildren ? 'aria-haspopup="menu" aria-expanded="false"' : ""}>
        ${hasChildren ? "" : check}
        <span class="card-action-label">${escapeHtml(item.label)}</span>
        ${suffix}
      </button>
      ${hasChildren ? `<div class="card-action-submenu" role="menu">${renderMenuItems(item.children)}</div>` : ""}
    </li>
  `;
}

function wireMenu(menu, ticket, handlers) {
  menu.addEventListener("pointerover", (event) => {
    const item = event.target instanceof Element ? event.target.closest(".card-action-menu-item") : null;
    if (!item || !menu.contains(item)) return;
    if (item.classList.contains("has-submenu")) {
      cancelPendingClose();
      openSubmenu(item);
    } else {
      scheduleCloseOtherSubmenus(menu);
    }
  }, true);

  menu.addEventListener("focusin", (event) => {
    const item = event.target instanceof Element ? event.target.closest(".card-action-menu-item") : null;
    if (!item || !menu.contains(item)) return;
    if (item.classList.contains("has-submenu")) {
      cancelPendingClose();
      openSubmenu(item);
    } else {
      cancelPendingClose();
      closeOpenSubmenus(menu);
    }
  });

  menu.addEventListener("click", (event) => handleItemClick(event, menu, ticket, handlers));
  menu.addEventListener("keydown", (event) => handleMenuKeydown(event, menu));
}

function wireSubmenu(submenu, ticket, handlers) {
  // Keep the submenu open while the pointer is inside it.
  submenu.addEventListener("pointerenter", cancelPendingClose);
  submenu.addEventListener("pointerover", (event) => {
    if (event.target instanceof Element && submenu.contains(event.target)) {
      cancelPendingClose();
    }
  }, true);

  submenu.addEventListener("click", (event) => {
    if (!openMenu) return;
    handleItemClick(event, openMenu, ticket, handlers, submenu);
  });
  submenu.addEventListener("keydown", (event) => {
    if (!openMenu) return;
    handleMenuKeydown(event, openMenu);
  });
}

function handleItemClick(event, rootMenu, ticket, handlers, container = rootMenu) {
  const button = event.target instanceof Element ? event.target.closest("button.card-action-button") : null;
  if (!button || !container.contains(button) || button.disabled) return;
  event.preventDefault();
  event.stopPropagation();

  const parent = button.closest(".card-action-menu-item");
  if (parent?.classList.contains("has-submenu")) {
    cancelPendingClose();
    openSubmenu(parent);
    firstEnabledItem(submenuByItem.get(parent))?.focus({ preventScroll: true });
    return;
  }

  const action = button.dataset.action;
  const value = button.dataset.value;
  closeCardActionMenu();
  if (action === "open") return handlers.open(ticket);
  if (action === "move") return handlers.move(ticket, value);
  if (action === "priority") return handlers.priority(ticket, Number(value));
  if (action === "type") return handlers.type(ticket, value);
  if (action === "archive") return handlers.archive(ticket);
}

function handleMenuKeydown(event, rootMenu) {
  const button = event.target instanceof Element ? event.target.closest("button.card-action-button") : null;
  if (!button) return;
  const submenu = button.closest(".card-action-submenu");
  const inRoot = rootMenu.contains(button);
  if (!inRoot && !submenu) return;

  const currentMenu = button.closest(".card-action-menu-list");
  const item = button.closest(".card-action-menu-item");

  if (event.key === "Escape") {
    event.preventDefault();
    if (submenu) {
      const parentItem = itemBySubmenu.get(submenu);
      const parentButton = parentItem?.querySelector(":scope > .card-action-button");
      closeSubmenu(parentItem);
      parentButton?.focus({ preventScroll: true });
    } else {
      closeCardActionMenu({ restoreFocus: true });
    }
    return;
  }

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveFocus(currentMenu, button, event.key === "ArrowDown" ? 1 : -1);
    return;
  }

  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    const enabled = enabledItems(currentMenu);
    enabled[event.key === "Home" ? 0 : enabled.length - 1]?.focus({ preventScroll: true });
    return;
  }

  if (event.key === "ArrowRight" && item?.classList.contains("has-submenu")) {
    event.preventDefault();
    cancelPendingClose();
    openSubmenu(item);
    firstEnabledItem(submenuByItem.get(item))?.focus({ preventScroll: true });
    return;
  }

  if (event.key === "ArrowLeft" && submenu) {
    const parentItem = itemBySubmenu.get(submenu);
    const parentButton = parentItem?.querySelector(":scope > .card-action-button");
    if (parentButton) {
      event.preventDefault();
      closeSubmenu(parentItem);
      parentButton.focus({ preventScroll: true });
    }
  }
}

function dismissOnOutsidePointer(event) {
  if (!openMenu) return;
  if (isEventInsideAnyMenu(event)) return;
  closeCardActionMenu();
}

function dismissOnEscape(event) {
  if (event.key === "Escape" && openMenu) {
    event.preventDefault();
    closeCardActionMenu({ restoreFocus: true });
  }
}

function dismissOnScroll(event) {
  if (!openMenu) return;
  if (isEventInsideAnyMenu(event)) return;
  closeCardActionMenu();
}

function isEventInsideAnyMenu(event) {
  const target = event.target;
  if (!(target instanceof Node)) return false;
  if (openMenu?.contains(target)) return true;
  for (const submenu of openSubmenus) {
    if (submenu.contains(target)) return true;
  }
  return false;
}

function openSubmenu(item) {
  const siblings = item.parentElement?.children || [];
  for (const sibling of siblings) {
    if (sibling !== item && sibling.classList?.contains("has-submenu") && sibling.classList.contains("is-open")) {
      closeSubmenu(sibling);
    }
  }
  const submenu = submenuByItem.get(item);
  if (!submenu) return;
  if (item.classList.contains("is-open")) {
    positionSubmenu(item, submenu);
    return;
  }
  item.classList.add("is-open");
  item.querySelector(":scope > .card-action-button")?.setAttribute("aria-expanded", "true");
  submenu.classList.add("is-open");
  openSubmenus.add(submenu);
  positionSubmenu(item, submenu);
}

function closeSubmenu(item) {
  if (!item) return;
  item.classList.remove("is-open");
  item.querySelector(":scope > .card-action-button")?.setAttribute("aria-expanded", "false");
  const submenu = submenuByItem.get(item);
  if (!submenu) return;
  submenu.classList.remove("is-open");
  submenu.style.removeProperty("left");
  submenu.style.removeProperty("top");
  submenu.style.removeProperty("max-height");
  openSubmenus.delete(submenu);
}

function closeOpenSubmenus(scope) {
  scope.querySelectorAll(".card-action-menu-item.has-submenu.is-open").forEach(closeSubmenu);
}

function scheduleCloseOtherSubmenus(rootMenu) {
  cancelPendingClose();
  pendingCloseTimer = setTimeout(() => {
    pendingCloseTimer = null;
    if (openMenu === rootMenu) closeOpenSubmenus(rootMenu);
  }, HOVER_CLOSE_DELAY);
}

function cancelPendingClose() {
  if (pendingCloseTimer != null) {
    clearTimeout(pendingCloseTimer);
    pendingCloseTimer = null;
  }
}

function positionSubmenu(item, submenu) {
  const trigger = item.querySelector(":scope > .card-action-button");
  if (!submenu || !trigger) return;

  const availableHeight = Math.max(0, window.innerHeight - MENU_MARGIN * 2);
  submenu.style.maxHeight = `${availableHeight}px`;
  submenu.style.left = "0px";
  submenu.style.top = "0px";

  const submenuRect = submenu.getBoundingClientRect();
  const position = calculateSubmenuPosition({
    triggerRect: trigger.getBoundingClientRect(),
    submenuWidth: submenuRect.width,
    submenuHeight: submenuRect.height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight
  });

  submenu.style.left = `${position.left}px`;
  submenu.style.top = `${position.top}px`;
  submenu.style.maxHeight = `${position.maxHeight}px`;
}

function enabledItems(scope) {
  if (!scope) return [];
  const list = scope.classList?.contains("card-action-menu-list")
    ? scope
    : scope.querySelector(":scope > .card-action-menu-list");
  if (!list) return [];
  return [...list.querySelectorAll(":scope > .card-action-menu-item > .card-action-button")].filter((button) => !button.disabled);
}

function firstEnabledItem(scope) {
  return enabledItems(scope)[0] || null;
}

function moveFocus(scope, current, step) {
  const items = enabledItems(scope);
  if (!items.length) return;
  const index = items.indexOf(current);
  const nextIndex = index === -1 ? 0 : (index + step + items.length) % items.length;
  items[nextIndex].focus({ preventScroll: true });
}
