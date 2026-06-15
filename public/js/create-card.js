// "New card" flyout (top-right panel, separate from the main ticket
// drawer). Handles open/close transitions, form rendering, and submission.

import {
  $,
  createFlyout,
  createFlyoutInner,
  createFlyoutBackdrop
} from "./dom.js";
import { state, visibleStatesForProject, ticketsForProject } from "./state.js";
import { escapeHtml } from "./format.js";
import { api } from "./api.js";
import { syncUrlFromState } from "./router.js";
import { handleTextareaIndentationKeydown } from "./text-editing.js";
import { closeDrawer } from "./drawer.js";
import { closeMenuFlyouts } from "./board-menu.js";
import { load } from "./app.js";
import { closeIconSvg } from "./icons.js";

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
  const states = visibleStatesForProject();
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
    .map((ticket) => {
      const label = `#${ticket.number} — ${ticket.title || ""}`.trim();
      return `<option value="${escapeHtml(ticket.id)}">${escapeHtml(label)}</option>`;
    })
    .join("");
  return `
    <div class="create-flyout-head">
      <h2>New card</h2>
      <button type="button" class="create-flyout-close ghost" id="createFlyoutClose" aria-label="Close">${closeIconSvg}</button>
    </div>
    <form id="createTicketForm" class="create-flyout-form">
      <input id="createTicketTitle" name="title" type="text" placeholder="Title — what is this card?" autocomplete="off" required />
      <textarea id="createTicketDescription" name="description" placeholder="Description (optional)"></textarea>
      <div class="control-grid">
        <label class="control-field">
          <span class="control-field-label">LANE</span>
          <select id="createTicketState" name="state" class="select-chevron-field" aria-label="Lane">${stateOptions}</select>
        </label>
        <label class="control-field">
          <span class="control-field-label">TYPE</span>
          <select id="createTicketType" name="type" class="select-chevron-field" aria-label="Ticket type">
            <option value="epic">Epic</option>
            <option value="feature">Feature</option>
            <option value="task" selected>Task</option>
            <option value="bug">Bug</option>
          </select>
        </label>
        <label class="control-field">
          <span class="control-field-label">PRIORITY</span>
          <select id="createTicketPriority" name="priority" class="select-chevron-field" aria-label="Priority">
            <option value="4">URGENT</option>
            <option value="3">HIGH</option>
            <option value="2" selected>MED</option>
            <option value="1">LOW</option>
            <option value="0">MAYBE</option>
          </select>
        </label>
      </div>
      <label class="control-field" id="createTicketParentField">
        <span class="control-field-label">Parent epic</span>
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
  const description = form.querySelector("#createTicketDescription");
  description?.addEventListener("keydown", (event) => {
    handleTextareaIndentationKeydown(event, description);
  });

  // Epics cannot have a parent (server rejects with `epic_cannot_have_parent`),
  // so hide the Parent epic field whenever Type is Epic.
  const typeSelect = form.querySelector("#createTicketType");
  const parentField = form.querySelector("#createTicketParentField");
  const parentSelect = form.querySelector("#createTicketParent");
  const syncParentVisibility = () => {
    const isEpic = typeSelect.value === "epic";
    parentField.hidden = isEpic;
    if (isEpic) parentSelect.value = "";
  };
  typeSelect.addEventListener("change", syncParentVisibility);
  syncParentVisibility();

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
