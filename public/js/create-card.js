// "New card" flyout (top-right panel, separate from the main ticket
// drawer). Handles open/close transitions, form rendering, and submission.

import {
  $,
  createFlyout,
  createFlyoutInner,
  createFlyoutBackdrop
} from "./dom.js";
import { state, statesForProject, ticketsForProject } from "./state.js";
import { escapeHtml, ticketLabel } from "./format.js";
import { api } from "./api.js";
import { syncUrlFromState } from "./router.js";
import { closeDrawer } from "./drawer.js";
import { closeMenuFlyouts } from "./board-menu.js";
import { load } from "./app.js";

/** Clears any pending hide timeout when reopening the create flyout quickly. */
let createFlyoutHideTimer = 0;

export function isCreateFlyoutOpen() {
  return createFlyout?.classList.contains("is-open");
}

/** Compact top-right panel for creating a card (separate from the main ticket drawer). */
export function openCreateFlyout(preselectedLaneId) {
  clearTimeout(createFlyoutHideTimer);
  closeMenuFlyouts();
  closeDrawer();
  createFlyoutInner.innerHTML = renderCreateForm(preselectedLaneId || "");
  wireCreateForm();
  $("#createFlyoutClose")?.addEventListener("click", () => closeCreateFlyout());
  createFlyout.hidden = false;
  createFlyoutBackdrop.hidden = false;
  requestAnimationFrame(() => {
    createFlyout.classList.add("is-open");
    createFlyoutBackdrop.classList.add("is-visible");
  });
  requestAnimationFrame(() => {
    $("#createTicketTitle")?.focus();
  });
}

export function closeCreateFlyout() {
  clearTimeout(createFlyoutHideTimer);
  createFlyout.classList.remove("is-open");
  createFlyoutBackdrop.classList.remove("is-visible");
  createFlyoutHideTimer = setTimeout(() => {
    createFlyout.hidden = true;
    createFlyoutBackdrop.hidden = true;
    createFlyoutInner.innerHTML = "";
  }, 220);
}

/** HTML for the “New” flyout: lane + type + priority on one row, then parent and labels. */
function renderCreateForm(preselectedLaneId) {
  const states = statesForProject();
  const defaultState = states.find((item) => item.is_default) || states[0];
  const effectiveStateId =
    preselectedLaneId && states.some((s) => s.id === preselectedLaneId)
      ? preselectedLaneId
      : defaultState?.id || "";
  const stateOptions = states
    .map(
      (item) =>
        `<option value="${escapeHtml(item.id)}" ${item.id === effectiveStateId ? "selected" : ""}>${escapeHtml(item.name)}</option>`
    )
    .join("");
  const parentOptions = ticketsForProject()
    .filter((ticket) => ticket.type === "epic")
    .map((ticket) => `<option value="${escapeHtml(ticket.id)}">${escapeHtml(ticketLabel(ticket))}</option>`)
    .join("");
  return `
    <div class="create-flyout-head">
      <h2>New card</h2>
      <button type="button" class="create-flyout-close ghost" id="createFlyoutClose" aria-label="Close">×</button>
    </div>
    <form id="createTicketForm" class="create-flyout-form">
      <input id="createTicketTitle" name="title" type="text" placeholder="Title — what is this card?" autocomplete="off" required />
      <textarea id="createTicketDescription" name="description" placeholder="Description (optional)"></textarea>
      <div class="create-flyout-grid">
        <label>
          Lane
          <select id="createTicketState" name="state" class="select-chevron-field" aria-label="Lane">${stateOptions}</select>
        </label>
        <label>
          Type
          <select id="createTicketType" name="type" class="select-chevron-field" aria-label="Ticket type">
            <option value="epic">Epic / Story</option>
            <option value="feature">Feature</option>
            <option value="task" selected>Task</option>
            <option value="bug">Bug</option>
          </select>
        </label>
        <label>
          Priority
          <select id="createTicketPriority" name="priority" class="select-chevron-field" aria-label="Priority">
            <option value="0">MAYBE</option>
            <option value="1">LOW</option>
            <option value="2" selected>MED</option>
            <option value="3">HIGH</option>
            <option value="4">URGENT</option>
          </select>
        </label>
      </div>
      <label>
        Parent epic
        <select id="createTicketParent" name="parent_ticket_id" class="select-chevron-field" aria-label="Parent epic">
          <option value="">None</option>
          ${parentOptions}
        </select>
      </label>
      <input id="createTicketLabels" name="labels" type="text" placeholder="Labels (comma-separated)" />
      <button type="submit">Create card</button>
    </form>
  `;
}

function wireCreateForm() {
  const form = $("#createTicketForm");
  if (!form) return;
  form.addEventListener("submit", createTicketFromDrawer);
}

async function createTicketFromDrawer(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const labels = String(data.get("labels") || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const created = await api("/api/tickets", {
    method: "POST",
    body: {
      board_id: state.boardId,
      title: data.get("title"),
      description: data.get("description"),
      type: data.get("type"),
      parent_ticket_id: data.get("parent_ticket_id") || null,
      state_id: data.get("state"),
      priority: Number(data.get("priority")),
      labels
    }
  });

  closeCreateFlyout();
  state.selectedTicketId = created.id;
  state.detailMode = "ticket";
  await load();
  syncUrlFromState();
}
