// Kanban board rendering plus the drag-to-pan interaction. `renderBoard()`
// rebuilds every column from current state and rewires drop zones, card
// click/drag handlers, and the per-column "+" button. Card detail is
// owned by ticket-detail.js.

import { kanban } from "./dom.js";
import { state, visibleStatesForProject, ticketsForProject } from "./state.js";
import {
  escapeHtml,
  ticketLabel,
  canonicalTicketType,
  typeLabel,
  priorityLabel,
  priorityKeyFor,
  renderLabels,
  renderMarkdown
} from "./format.js";
import { api, withBoardQuery } from "./api.js";
import { navigate } from "./router.js";
import { closeCreateFlyout, openCreateFlyout } from "./create-card.js";
import { load } from "./app.js";
import { bindCardContextMenuDelegated, closeCardActionMenu, createCardActionHandlers, setCardActionDragInFlight } from "./card-actions.js";
import { unreadCount } from "./unread.js";

// Lookup for the current board's tickets, keyed by id. Refreshed on every
// renderBoard() so the single, persistent set of delegated listeners can
// resolve a card's ticket in O(1) without re-binding anything per render.
let boardTicketsById = new Map();
// Created once (lazily) and reused — handlers are stateless w.r.t. a given card.
let cardActionHandlers = null;
// HTML5 DnD ends with a synthetic click on the drag source; this flag lets the
// delegated click handler swallow that one click so a drop doesn't also open
// the ticket drawer. Module-scoped because there's now one shared listener.
let suppressClickAfterDrag = false;

// renderBoard() is hot: it runs on every drag-drop, every SSE board event, and
// every settings toggle. Keep it to a single innerHTML write plus a Map refresh.
// All interaction wiring lives in enableKanbanInteractions(), attached ONCE to
// the persistent `kanban` element (see below), so re-rendering never re-binds
// per-card/column/button listeners or rescans the ticket list.
export function renderBoard() {
  const states = visibleStatesForProject();
  const tickets = ticketsForProject();
  boardTicketsById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  kanban.innerHTML = states.map((column) => renderColumn(column, tickets)).join("");
}

function toggleCardExpansion(card) {
  if (!card) return;
  const id = card.dataset.ticketId;
  const willExpand = !state.expandedCardIds.has(id);
  if (willExpand) {
    state.expandedCardIds.add(id);
    // Build the expandable body (markdown parse + labels + relations) the first
    // time a card opens. Collapsed cards — the overwhelming majority on render —
    // never pay this cost. Once built it stays cached in the DOM for re-toggles.
    if (!card.querySelector(".card-expandable")) {
      const ticket = boardTicketsById.get(id);
      const meta = card.querySelector(".card-meta");
      if (ticket && meta) meta.insertAdjacentHTML("afterend", renderCardExpandable(ticket));
    }
  } else {
    state.expandedCardIds.delete(id);
  }
  card.classList.toggle("is-expanded", willExpand);
  const toggleBtn = card.querySelector("button.card-expand-trigger");
  if (toggleBtn) toggleBtn.setAttribute("aria-expanded", willExpand ? "true" : "false");
}

// One-time setup: attach delegated listeners to the persistent board container.
// Because events bubble to `kanban`, these survive every innerHTML swap, so
// renderBoard() does zero listener work regardless of card count.
export function enableKanbanInteractions() {
  cardActionHandlers = cardActionHandlers || createCardActionHandlers({ navigator: navigate });

  // --- Drag & drop (HTML5 DnD events bubble, so one set covers all cards) ---
  let dragOverColumn = null;
  const setDragOverColumn = (column) => {
    if (dragOverColumn === column) return;
    if (dragOverColumn) dragOverColumn.classList.remove("drag-over");
    dragOverColumn = column;
    if (dragOverColumn) dragOverColumn.classList.add("drag-over");
  };

  kanban.addEventListener("dragstart", (event) => {
    const card = event.target instanceof Element ? event.target.closest(".card") : null;
    if (!card) return;
    closeCardActionMenu();
    setCardActionDragInFlight(true);
    event.dataTransfer.setData("text/plain", card.dataset.ticketId);
    event.dataTransfer.effectAllowed = "move";
  });

  kanban.addEventListener("dragover", (event) => {
    const column = event.target instanceof Element ? event.target.closest(".column") : null;
    if (!column) return;
    event.preventDefault();
    setDragOverColumn(column);
  });

  kanban.addEventListener("dragend", () => {
    setCardActionDragInFlight(false);
    setDragOverColumn(null);
    suppressClickAfterDrag = true;
    // If no synthetic click follows (e.g. drag cancelled oddly), don't eat the
    // next real click.
    setTimeout(() => {
      suppressClickAfterDrag = false;
    }, 0);
  });

  kanban.addEventListener("drop", async (event) => {
    const column = event.target instanceof Element ? event.target.closest(".column") : null;
    if (!column) return;
    event.preventDefault();
    setDragOverColumn(null);
    const ticketId = event.dataTransfer.getData("text/plain");
    if (!ticketId) return;
    closeCreateFlyout();
    await api(withBoardQuery(`/api/tickets/${ticketId}`), {
      method: "PATCH",
      body: { state_id: column.dataset.stateId }
    });
    // Refresh board only; do not open the ticket drawer (DnD also fires a
    // synthetic click on the card — suppressed by suppressClickAfterDrag).
    await load();
  });

  // --- Clicks (precedence: add-button > expand toggle > link > epic header > card) ---
  kanban.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target) return;

    const addBtn = target.closest("[data-add-to-state]");
    if (addBtn) {
      event.stopPropagation();
      openCreateFlyout(addBtn.dataset.addToState || "");
      return;
    }

    const toggle = target.closest("button.card-expand-trigger");
    if (toggle) {
      event.stopPropagation();
      event.preventDefault();
      toggleCardExpansion(toggle.closest(".card"));
      return;
    }

    // Anchors inside a card keep their native behavior.
    if (target.closest("a")) {
      event.stopPropagation();
      return;
    }

    const epicHeader = target.closest(".epic-mini-header[data-ticket-id]");
    if (epicHeader) {
      closeCreateFlyout();
      navigate({ boardId: state.boardId, view: "ticket", ticketId: epicHeader.dataset.ticketId });
      return;
    }

    const card = target.closest(".card");
    if (!card) return;
    if (suppressClickAfterDrag) {
      suppressClickAfterDrag = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    closeCreateFlyout();
    navigate({ boardId: state.boardId, view: "ticket", ticketId: card.dataset.ticketId });
  });

  // --- Context menu ---
  bindCardContextMenuDelegated(kanban, (id) => boardTicketsById.get(id), {
    handlers: cardActionHandlers,
    onBeforeOpen: closeCreateFlyout
  });
}

export function renderBoardSelection() {
  kanban.querySelectorAll(".card.selected").forEach((card) => card.classList.remove("selected"));
  if (!state.selectedTicketId) return;
  kanban
    .querySelectorAll(`.card[data-ticket-id="${CSS.escape(state.selectedTicketId)}"]`)
    .forEach((card) => card.classList.add("selected"));
}

function renderEmptyState(columnName) {
  const name = columnName.toLowerCase();
  let flair = {
    icon: `<svg class="empty-state-icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" opacity="0.5" /></svg>`,
    title: "Nothing here",
    subtitle: "Tasks will appear when ready"
  };

  if (name === "ai ready") {
    flair = {
      icon: `<svg class="empty-state-icon ai-sparkle" viewBox="0 0 24 24">
        <path d="M12 3L14.5 9L21 11.5L14.5 14L12 20L9.5 14L3 11.5L9.5 9L12 3Z" fill="currentColor" opacity="0.65" />
        <circle cx="12" cy="11.5" r="1.8" fill="#fff" />
      </svg>`,
      title: "Ready for agents",
      subtitle: "Drop unblocked cards here — the claim-next tool picks them up"
    };
  } else if (name.includes("progress")) {
    flair = {
      icon: `<svg class="empty-state-icon orbit" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="10" fill="currentColor" opacity="0.9" />
        <circle class="ring" cx="50" cy="50" r="30" stroke="currentColor" stroke-dasharray="4 6" />
        <circle class="satellite" cx="80" cy="50" r="4" fill="currentColor" />
      </svg>`,
      title: "Work in progress",
      subtitle: "Active work will appear here"
    };
  } else if (name.includes("review")) {
    flair = {
      icon: `<svg class="empty-state-icon star" viewBox="0 0 24 24">
        <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" fill="currentColor" />
      </svg>`,
      title: "Under review",
      subtitle: "Quality gate before merge"
    };
  } else if (name.includes("todo") || name.includes("backlog")) {
    flair = {
      icon: `<svg class="empty-state-icon ai-sparkle" viewBox="0 0 24 24">
        <path d="M12 3L14.5 9L21 11.5L14.5 14L12 20L9.5 14L3 11.5L9.5 9L12 3Z" fill="currentColor" opacity="0.5" />
        <path d="M19 8L20 10L21 8L20 6L19 8ZM19 16L20 18L21 16L20 14L19 16ZM5 8L6 10L7 8L6 6L5 8Z" fill="currentColor" />
      </svg>`,
      title: "Ready for launch",
      subtitle: "Create a card manually or task an AI to generate tasks"
    };
  } else if (name.includes("done") || name.includes("finished")) {
    flair = {
      icon: `<svg class="empty-state-icon" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" />
        <path d="M8 12L11 15L16 9" />
      </svg>`,
      title: "Done",
      subtitle: "Move completed tickets here"
    };
  } else if (name.includes("cancel")) {
    flair = {
      icon: `<svg class="empty-state-icon" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" opacity="0.2" />
        <path d="M15 9L9 15M9 9l6 6" />
      </svg>`,
      title: "Not moving forward",
      subtitle: "Parked or replaced"
    };
  }

  return `
    <div class="column-empty-state">
      <div class="empty-state-visual">
        <div class="empty-state-glow"></div>
        ${flair.icon}
      </div>
      <div class="empty-state-title">${escapeHtml(flair.title)}</div>
      <div class="empty-state-subtitle">${escapeHtml(flair.subtitle)}</div>
    </div>
  `;
}

function renderColumn(column, tickets) {
  const columnTickets = tickets.filter((ticket) => ticket.state_id === column.id);
  const isEmpty = columnTickets.length === 0;
  // The "AI Ready" lane is a contract between humans and agents: cards here
  // are the queue the claim-next MCP tool pulls from. Mark it so humans can
  // instantly see where agent-facing staging lives.
  const isAiReady = column.name === "AI Ready";
  const columnClasses = ["column", "lane"];
  if (isAiReady) columnClasses.push("column--ai-ready");
  const accentAttr = isAiReady ? ' data-accent="ai-ready"' : "";

  return `
    <section class="${columnClasses.join(" ")}" data-flat${accentAttr} data-state-id="${column.id}" data-state-name="${escapeHtml(column.name)}">
      <div class="column-head lane-head">
        <h2 class="lane-title"${isAiReady ? ' title="Agent staging — cards here are picked up by the claim-next tool when unblocked"' : ""}>
          ${isAiReady ? '<span class="agent-dot" aria-hidden="true"></span>' : ""}${escapeHtml(column.name)}
        </h2>
        <div class="column-head-actions lane-actions">
          <button type="button" class="column-add-btn" data-variant="plus" data-add-to-state="${escapeHtml(column.id)}" title="New card">+</button>
          <span class="count">${columnTickets.length}</span>
        </div>
      </div>
      ${isEmpty ? renderEmptyState(column.name) : renderColumnBody(columnTickets, tickets)}
      <button type="button" class="add-card-phantom" data-add-to-state="${escapeHtml(column.id)}">+ Add a card</button>
    </section>
  `;
}

/**
 * Lay out the cards inside a column with epic-aware grouping. Children of an
 * epic that's also in this column slide under the epic; children whose epic
 * lives in a different column appear under a thin "mini epic header" so the
 * relationship is still visible. Children get pulled to their group even if
 * the user dropped them out of order — the grouping always wins for clarity.
 */
function renderColumnBody(columnTickets, allTickets) {
  const epicById = new Map(
    allTickets
      .filter((t) => canonicalTicketType(t.type) === "epic")
      .map((t) => [t.id, t])
  );
  const epicIdsInColumn = new Set(
    columnTickets
      .filter((t) => canonicalTicketType(t.type) === "epic")
      .map((t) => t.id)
  );
  const childrenByEpicId = new Map();
  for (const t of columnTickets) {
    if (t.parent_ticket_id && epicById.has(t.parent_ticket_id)) {
      const list = childrenByEpicId.get(t.parent_ticket_id) || [];
      list.push(t);
      childrenByEpicId.set(t.parent_ticket_id, list);
    }
  }

  const rendered = new Set();
  const blocks = [];
  for (const t of columnTickets) {
    if (rendered.has(t.id)) continue;

    if (canonicalTicketType(t.type) === "epic") {
      const children = childrenByEpicId.get(t.id) || [];
      if (children.length) {
        const childrenHtml = children.map((c) => renderCard(c, { asEpicChild: true })).join("");
        blocks.push(`${renderCard(t)}<div class="epic-children">${childrenHtml}</div>`);
        children.forEach((c) => rendered.add(c.id));
      } else {
        blocks.push(renderCard(t));
      }
      rendered.add(t.id);
      continue;
    }

    // Defer children whose epic is in this column — they'll render under the
    // epic when the loop reaches it. Without this skip, a child iterated before
    // its epic would render standalone here, then again inside epic-children
    // (rendered.add happens at the epic, which may come later in updated_at order).
    if (t.parent_ticket_id && epicIdsInColumn.has(t.parent_ticket_id)) {
      continue;
    }

    if (t.parent_ticket_id && epicById.has(t.parent_ticket_id) && !epicIdsInColumn.has(t.parent_ticket_id)) {
      const epic = epicById.get(t.parent_ticket_id);
      const siblings = childrenByEpicId.get(t.parent_ticket_id) || [];
      const childrenHtml = siblings.map((c) => renderCard(c, { asEpicChild: true })).join("");
      blocks.push(`${renderEpicMiniHeader(epic)}<div class="epic-children">${childrenHtml}</div>`);
      siblings.forEach((c) => rendered.add(c.id));
      continue;
    }

    blocks.push(renderCard(t));
    rendered.add(t.id);
  }

  return blocks.join("");
}

function renderEpicMiniHeader(epic) {
  return `
    <div class="epic-mini-header" data-ticket-id="${escapeHtml(epic.id)}" title="Open epic">
      <div class="card-type-id type-pill-epic">
        ${renderTypeIcon("epic")}
        <span class="card-type-label">EPIC</span>
      </div>
      <span class="ticket-number">${escapeHtml(ticketLabel(epic))}</span>
      <span class="epic-mini-title">${escapeHtml(epic.title)}</span>
    </div>
  `;
}

/** Pill mirroring the structure/feel of the Type pill, colored per priority. */
export function renderPriorityPill(priority) {
  const key = priorityKeyFor(priority);
  const label = priorityLabel(priority);
  return `<div class="card-priority-id priority-pill" data-variant="${escapeHtml(key)}"><span class="card-priority-label">${escapeHtml(label)}</span></div>`;
}

export function renderTypeIcon(type) {
  const canonical = canonicalTicketType(type);
  let icon = "";
  let color = "currentColor";

  switch (canonical) {
    case "epic":
      color = "#c084fc"; // Purple
      icon = `<path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" fill="currentColor" />`;
      break;
    case "feature":
      color = "#4ade80"; // Green
      icon = `<path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2v16z" fill="currentColor" />`;
      break;
    case "bug":
      color = "#f87171"; // Red
      icon = `<circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" />`;
      break;
    default: // task
      color = "#60a5fa"; // Blue
      icon = `<rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 12l2 2 4-4" />`;
  }

  return `
    <svg class="card-type-icon" viewBox="0 0 24 24" style="color: ${color}">
      ${icon}
    </svg>
  `;
}

function renderCard(ticket, { asEpicChild = false } = {}) {
  const canonicalType = canonicalTicketType(ticket.type);
  const priorityKey = priorityKeyFor(ticket.priority);
  const typeText = typeLabel(ticket.type).toUpperCase();
  const isExpanded = state.expandedCardIds.has(ticket.id);
  const hasDescription = Boolean(String(ticket.description || "").trim());
  const hasExpandable = hasDescription || (ticket.labels && ticket.labels.length) || ticket.parent_ticket || ticket.child_count;

  const triggerInner = `
    <span class="ticket-number">${escapeHtml(ticketLabel(ticket))}</span>
    <div class="card-type-id type-pill-${escapeHtml(canonicalType)}">
      ${renderTypeIcon(ticket.type)}
      <span class="card-type-label">${escapeHtml(typeText)}</span>
    </div>
    ${state.showPriority ? renderPriorityPill(ticket.priority) : ""}
    ${hasExpandable ? `<svg class="card-expand-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>` : ""}
  `;

  const unreadN = unreadCount(ticket);
  const unreadDot = unreadN === 0
    ? ""
    : unreadN === 1
      ? `<span class="card-unread-dot" role="status" aria-label="1 unread update"></span>`
      : `<span class="card-unread-dot has-count" role="status" aria-label="${unreadN} unread updates">${unreadN > 99 ? "99+" : unreadN}</span>`;

  return `
    <article class="card type-${escapeHtml(canonicalType)} priority-${escapeHtml(priorityKey)}${isExpanded ? " is-expanded" : ""}${asEpicChild ? " is-epic-child" : ""} ${ticket.id === state.selectedTicketId ? "selected" : ""}" data-variant="${escapeHtml(canonicalType)}" draggable="true" data-ticket-id="${ticket.id}">
      ${unreadDot}
      <h3>${escapeHtml(ticket.title)}</h3>

      <div class="card-meta">
        ${hasExpandable
          ? `<button type="button" class="card-expand-trigger" data-variant="card-accordion" data-card-toggle aria-expanded="${isExpanded ? "true" : "false"}">${triggerInner}</button>`
          : `<div class="card-expand-trigger card-expand-trigger--static">${triggerInner}</div>`}
      </div>

      ${hasExpandable && isExpanded ? renderCardExpandable(ticket) : ""}
    </article>
  `;
}

// The expandable body holds the only genuinely expensive per-card work: a full
// markdown parse of the description. It's rendered eagerly only for cards that
// are already expanded; collapsed cards get it injected on first open (see
// toggleCardExpansion). Kept as its own function so both paths share one source.
function renderCardExpandable(ticket) {
  const hasDescription = Boolean(String(ticket.description || "").trim());
  return `
    <div class="card-expandable">
      ${hasDescription ? `<div class="card-description markdown-body">${renderMarkdown(ticket.description)}</div>` : ""}
      ${renderLabels(ticket.labels)}
      ${ticket.parent_ticket ? `<div class="parent-line">-> ${escapeHtml(ticketLabel(ticket.parent_ticket))}</div>` : ""}
      ${ticket.child_count ? `<div class="child-count">${ticket.child_count} feature${ticket.child_count === 1 ? "" : "s"} inside</div>` : ""}
    </div>
  `;
}

/**
 * Click-and-drag horizontal panning on the kanban container.
 * Skipped when the pointer starts on a .card (cards own their own click + HTML5 DnD),
 * or on any interactive control inside a column head.
 */
export function enableKanbanDragScroll() {
  const DRAG_THRESHOLD = 4; // px before we consider it a real drag (avoids eating clicks)
  const LINE_SCROLL_PX = 16;
  const PAGE_SCROLL_PX = () => Math.max(kanban.clientWidth, 1);
  let active = false;
  let dragged = false;
  let startX = 0;
  let startScroll = 0;
  let pointerId = 0;

  const shouldIgnore = (target) => {
    if (!(target instanceof Element)) return false;
    // Let cards keep their click/drag behavior untouched.
    if (target.closest(".card")) return true;
    // Don't hijack interactive controls that might land in the board area later.
    if (target.closest("a, button, input, select, textarea, [draggable='true']")) return true;
    return false;
  };

  const wheelPixels = (value, mode) => {
    if (mode === WheelEvent.DOM_DELTA_LINE) return value * LINE_SCROLL_PX;
    if (mode === WheelEvent.DOM_DELTA_PAGE) return value * PAGE_SCROLL_PX();
    return value;
  };

  kanban.addEventListener(
    "wheel",
    (event) => {
      if (event.defaultPrevented || event.ctrlKey) return;
      const horizontalDelta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (!horizontalDelta) return;
      const horizontal = Math.abs(horizontalDelta) >= Math.abs(event.deltaY) || event.shiftKey;
      if (!horizontal || kanban.scrollWidth <= kanban.clientWidth) return;

      event.preventDefault();
      kanban.scrollLeft += wheelPixels(horizontalDelta, event.deltaMode);
    },
    { passive: false }
  );

  kanban.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (shouldIgnore(event.target)) return;

    active = true;
    dragged = false;
    pointerId = event.pointerId;
    startX = event.clientX;
    startScroll = kanban.scrollLeft;
    kanban.classList.add("is-grabbing");
  });

  kanban.addEventListener("pointermove", (event) => {
    if (!active || event.pointerId !== pointerId) return;
    const delta = event.clientX - startX;
    if (!dragged && Math.abs(delta) > DRAG_THRESHOLD) {
      dragged = true;
      // Capture so movement outside the element still pans smoothly.
      try {
        kanban.setPointerCapture(pointerId);
      } catch {
        /* no-op: some browsers can't capture here */
      }
    }
    if (dragged) {
      event.preventDefault();
      kanban.scrollLeft = startScroll - delta;
    }
  });

  const endDrag = (event) => {
    if (!active || (event && event.pointerId !== pointerId)) return;
    active = false;
    kanban.classList.remove("is-grabbing");
    try {
      kanban.releasePointerCapture(pointerId);
    } catch {
      /* no-op */
    }
  };

  kanban.addEventListener("pointerup", endDrag);
  kanban.addEventListener("pointercancel", endDrag);
  kanban.addEventListener("pointerleave", endDrag);

  // Suppress the synthetic click at the end of a real drag so empty-area panning
  // doesn't accidentally trigger downstream click handlers.
  kanban.addEventListener(
    "click",
    (event) => {
      if (dragged) {
        event.stopPropagation();
        event.preventDefault();
        dragged = false;
      }
    },
    true
  );
}
