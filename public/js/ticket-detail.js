// Ticket detail drawer: renders the full ticket pane (header meta, AI plan,
// status history, comments) and wires every editable surface — inline title
// and description editors, meta selects, label management, parent epic, and
// related cards. Also owns the small render helpers (status history,
// comments, detail-card) that are only used inside the drawer.

import { state, ticketsForProject, selectableStatesForProject, boardLabelCatalog, currentBoard } from "./state.js";
import { drawerInner, drawer, $ } from "./dom.js";
import {
  escapeHtml,
  formatDate,
  formatDateDetail,
  ticketLabel,
  canonicalTicketType,
  typeLabel,
  typeLabelLong,
  priorityLabel,
  priorityKeyFor,
  renderMarkdown
} from "./format.js";
import { renderTypeIcon, renderPriorityPill } from "./kanban.js";
import { renderDrawerShell, openDrawer, closeDrawer } from "./drawer.js";
import { navigate } from "./router.js";
import { api, withBoardQuery } from "./api.js";
import { toast } from "./toast.js";
import { load } from "./app.js";
import { renderProjectDetail } from "./settings.js";
import { unreadCount, markRead } from "./unread.js";
import { formatActorLabel, formatCommentAuthor } from "./actor-labels.js";

/**
 * PATCH a ticket then reload + re-render the drawer in ticket mode. Lives
 * here because every caller is a drawer interaction; api.js stays I/O-only.
 */
async function patchTicket(ticketId, body) {
  await api(withBoardQuery(`/api/tickets/${ticketId}`), { method: "PATCH", body });
  await load();
  state.selectedTicketId = ticketId;
  state.detailMode = "ticket";
  await renderDetail();
}

/**
 * Replace a static node with an inline editor; commit on Enter / blur, cancel on Esc.
 * For multi-line fields, Ctrl/Cmd+Enter commits and plain Enter inserts a newline.
 */
function startInlineEdit(node, field, initialValue, ticketId) {
  if (!node || node.dataset.editing === "true") return;
  node.dataset.editing = "true";

  const isTextarea = field === "description";
  const editor = document.createElement(isTextarea ? "textarea" : "input");
  editor.className = isTextarea ? "inline-desc-editor" : "inline-title-editor";
  editor.value = initialValue;
  editor.setAttribute("data-editing-field", field);
  editor.setAttribute("aria-label", isTextarea ? "Edit ticket description" : "Edit ticket title");
  if (!isTextarea) {
    editor.type = "text";
    editor.maxLength = 500;
    editor.autocomplete = "off";
    editor.spellcheck = true;
  } else {
    editor.rows = Math.max(3, String(initialValue).split("\n").length + 1);
  }

  node.replaceWith(editor);
  editor.focus();
  if (!isTextarea) editor.select();
  else editor.setSelectionRange(editor.value.length, editor.value.length);

  let done = false;

  const stopWatchingOutsideClicks = () => {
    document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
  };

  // The title row uses a persistent shell element (#drawerTitle) that
  // renderDrawerShell re-queries by id on every render. Leaving the editor in
  // its place means the next render finds nothing, throws, and the input is
  // stranded on screen until a full reload. Put the original node back before
  // any downstream render runs.
  const restoreNode = () => {
    if (editor.isConnected) editor.replaceWith(node);
    delete node.dataset.editing;
  };

  const finish = () => {
    done = true;
    stopWatchingOutsideClicks();
    restoreNode();
  };

  function handleOutsidePointerDown(event) {
    if (done || event.target === editor || editor.contains(event.target)) return;
    // Some drawer/header surfaces are not focusable, so clicking them does not
    // reliably blur the title input in every browser. Force the same blur path
    // description editing already uses so the edit styling cannot get stuck.
    editor.blur();
  }

  document.addEventListener("pointerdown", handleOutsidePointerDown, true);

  const commit = async () => {
    if (done) return;
    const next = field === "title" ? editor.value.trim() : editor.value;
    finish();
    if (String(next) === String(initialValue)) {
      await renderDetail();
      return;
    }
    if (field === "title" && !next) {
      toast.warning("Title cannot be empty");
      await renderDetail();
      return;
    }
    await patchTicket(ticketId, { [field]: next });
  };

  const cancel = async () => {
    if (done) return;
    finish();
    await renderDetail();
  };

  editor.addEventListener("blur", commit);
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void cancel();
      return;
    }
    if (event.key === "Enter") {
      if (!isTextarea) {
        event.preventDefault();
        void commit();
      } else if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        void commit();
      }
    }
  });
}

/** Wire inline editors on the ticket detail header (meta fields, labels). */
function wireTicketDetailEditors(ticket) {
  const ticketId = ticket.id;

  const titleEl = drawer.querySelector('[data-edit-field="title"]');
  if (titleEl) {
    titleEl.addEventListener("click", () => {
      startInlineEdit(titleEl, "title", ticket.title || "", ticketId);
    });
    titleEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        startInlineEdit(titleEl, "title", ticket.title || "", ticketId);
      }
    });
  }

  const descEl = drawerInner.querySelector('[data-edit-field="description"]');
  if (descEl) {
    descEl.addEventListener("click", (event) => {
      event.preventDefault();
      startInlineEdit(descEl, "description", ticket.description || "", ticketId);
    });
    descEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        startInlineEdit(descEl, "description", ticket.description || "", ticketId);
      }
    });
  }

  drawer.querySelectorAll(".meta-select[data-meta-field]").forEach((select) => {
    select.addEventListener("change", async () => {
      const field = select.dataset.metaField;
      if (field === "type") {
        await patchTicket(ticketId, { type: select.value });
        return;
      }
      if (field === "state_id") {
        await patchTicket(ticketId, { state_id: select.value });
        return;
      }
      if (field === "parent_ticket_id") {
        await patchTicket(ticketId, { parent_ticket_id: select.value || null });
        return;
      }
      if (field === "priority") {
        await patchTicket(ticketId, { priority: Number(select.value) });
      }
    });
  });

  const applyLabelPatch = async (nextNames) => {
    await patchTicket(ticketId, { labels: nextNames });
  };

  drawerInner.querySelectorAll("[data-remove-label]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const removeName = btn.getAttribute("data-remove-label");
      const names = (ticket.labels || []).map((l) => l.name).filter((n) => n !== removeName);
      await applyLabelPatch(names);
    });
  });

  const addLabel = async () => {
    const input = drawerInner.querySelector("[data-label-input]");
    if (!input) return;
    const name = input.value.trim();
    if (!name) return;
    const names = (ticket.labels || []).map((l) => l.name);
    if (names.includes(name)) {
      input.value = "";
      return;
    }
    names.push(name);
    input.value = "";
    await applyLabelPatch(names);
  };

  drawerInner.querySelector("[data-label-add]")?.addEventListener("click", () => {
    void addLabel();
  });
  drawerInner.querySelector("[data-label-input]")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void addLabel();
    }
  });
}

export async function renderDetail() {
  if (state.detailMode === "settings") {
    await renderProjectDetail();
    openDrawer();
    return;
  }

  if (!state.selectedTicketId) {
    closeDrawer();
    return;
  }

  const [context, statusHistory, commentPack] = await Promise.all([
    api(withBoardQuery(`/api/tickets/${state.selectedTicketId}/context?depth=1`)),
    api(withBoardQuery(`/api/tickets/${state.selectedTicketId}/history`)),
    api(withBoardQuery(`/api/tickets/${state.selectedTicketId}/comments`))
  ]);
  const ticket = context.ticket;
  const comments = Array.isArray(commentPack?.comments) ? commentPack.comments : [];
  // Acknowledge the read receipt: clear the unread dot on this card.
  // Also wipe the dot from the already-rendered card in the board so the
  // user doesn't see it lingering until the next full re-render.
  markRead(ticket.id, ticket.updated_at);
  document.querySelector(`.card[data-ticket-id="${CSS.escape(ticket.id)}"] .card-unread-dot`)?.remove();
  const states = selectableStatesForProject(ticket.state_id);

  // Ordered by the canonical hierarchy so the dropdown visually reinforces scale:
  // Epic (biggest) → Feature → Task → Bug.
  const typeOptions = ["epic", "feature", "task", "bug"]
    .map(
      (value) =>
        `<option value="${escapeHtml(value)}" ${canonicalTicketType(ticket.type) === value ? "selected" : ""}>${escapeHtml(typeLabelLong(value))}</option>`
    )
    .join("");

  const stateOptions = states
    .map(
      (s) =>
        `<option value="${escapeHtml(s.id)}" ${s.id === ticket.state_id ? "selected" : ""}>${escapeHtml(s.name)}</option>`
    )
    .join("");

  const priorityOptions = [0, 1, 2, 3, 4]
    .map(
      (p) =>
        `<option value="${p}" ${Number(ticket.priority) === p ? "selected" : ""}>${escapeHtml(priorityLabel(p))}</option>`
    )
    .join("");

  const labelPills = (ticket.labels || [])
    .map(
      (label) => `
      <span class="label-pill-removable" style="--label-color: ${escapeHtml(label.color)}">
        ${escapeHtml(label.name)}
        <button type="button" class="label-pill-remove" data-remove-label="${escapeHtml(label.name)}" title="Remove label">×</button>
      </span>`
    )
    .join("");

  const catalogNames = boardLabelCatalog()
    .map((l) => l.name)
    .filter((name) => !ticket.labels?.some((tl) => tl.name === name));

  const datalistOptions = catalogNames.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");

  const detailCanonicalType = canonicalTicketType(ticket.type);
  const priorityKey = priorityKeyFor(ticket.priority);
  const currentState = states.find((s) => s.id === ticket.state_id);
  const stateClass = String(currentState?.role || currentState?.name || "state")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "state";
  const detailSubtitleHtml = `
    <span class="ticket-number">${escapeHtml(ticketLabel(ticket))}</span>
    <div class="detail-meta-badge-row" aria-label="Ticket metadata controls">
      <select class="detail-meta-badge detail-state-badge state-pill-${escapeHtml(stateClass)} meta-select" data-meta-field="state_id" aria-label="Ticket state">${stateOptions}</select>
      <select class="detail-meta-badge detail-type-badge type-pill-${escapeHtml(detailCanonicalType)} meta-select" data-meta-field="type" aria-label="Ticket type">${typeOptions}</select>
      <select class="detail-meta-badge detail-priority-badge priority-pill priority-pill-${escapeHtml(priorityKey)} meta-select" data-meta-field="priority" aria-label="Ticket priority">${priorityOptions}</select>
    </div>
  `;

  renderDrawerShell({
    mode: "ticket",
    title: ticket.title,
    titleAttrs: {
      class: "editable-field",
      "data-edit-field": "title",
      role: "button",
      tabindex: "0",
      title: "Click or press Enter to edit ticket title",
      "aria-label": "Edit ticket title"
    },
    subtitleHtml: detailSubtitleHtml,
    body: `
    <div class="detail-head">
      <p class="detail-updated" title="Last saved change">Updated ${escapeHtml(formatDateDetail(ticket.updated_at))}</p>
      <div class="description markdown-body editable-field ${ticket.description ? "" : "is-placeholder"}" data-edit-field="description" tabindex="0" title="Click to edit">${ticket.description ? renderMarkdown(ticket.description) : escapeHtml("No description yet.")}</div>
      <dl class="ticket-meta" id="ticketMetaGrid" data-ticket-id="${escapeHtml(ticket.id)}">
        <div class="ticket-meta-row ticket-meta-row--stack">
          <dt>Labels</dt>
          <dd>
            <div class="label-pills-row" data-other-labels>${labelPills}</div>
            <div class="label-add-row">
              <input type="text" class="label-add-input meta-inline-input" data-label-input list="board-label-suggestions" placeholder="Add label…" aria-label="Add label" />
              <datalist id="board-label-suggestions">${datalistOptions}</datalist>
              <button type="button" class="ghost meta-add-btn" data-label-add>Add</button>
            </div>
          </dd>
        </div>
      </dl>
    </div>

    ${renderHierarchySection(ticket, context)}

    ${renderParentEpicSection(ticket, context)}

    <div class="section">
      <h3>Related</h3>
      ${renderRelated(context.relations, ticket)}
    </div>

    ${currentBoard()?.ai_enabled !== 0 ? `
    <details class="section ai-fields" data-ai-plan-toggle data-ticket-id="${escapeHtml(ticket.id)}"${aiPlanOpen(ticket.id) ? " open" : ""}>
      <summary><h3>AI Plan / Implementation Record</h3></summary>
      <form id="aiFieldsForm" class="field-form">
        <label>
          <span>AI-Written Plan</span>
          <textarea name="ai_plan" placeholder="Paste or let an AI write the plan...">${escapeHtml(ticket.ai_plan || "")}</textarea>
        </label>
        <label>
          <span>Implementation Summary</span>
          <textarea name="implementation_summary" placeholder="What changed, what shipped, what remains...">${escapeHtml(ticket.implementation_summary || "")}</textarea>
        </label>
        <label>
          <span>Implementation Updates / Lessons</span>
          <textarea name="implementation_updates" placeholder="Progress notes, mistakes to avoid, discoveries...">${escapeHtml(ticket.implementation_updates || "")}</textarea>
        </label>
        <button type="submit">Save Fields</button>
      </form>
    </details>` : ""}

    <div class="section">
      <h3>Status History</h3>
      ${renderStatusHistory(statusHistory)}
    </div>

    <div class="section">
      <h3>Comments</h3>
      ${comments.map(renderComment).join("") || `<p class="description">No comments yet.</p>`}
      <form class="comment-form" id="detailCommentForm">
        <textarea name="body" placeholder="Add a comment, decision, or instruction..." required></textarea>
        <button type="submit">Comment</button>
      </form>
    </div>
  `
  });

  wireTicketDetailEditors(ticket);

  $("#aiFieldsForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api(withBoardQuery(`/api/tickets/${ticket.id}`), {
      method: "PATCH",
      body: {
        ai_plan: form.get("ai_plan"),
        implementation_summary: form.get("implementation_summary"),
        implementation_updates: form.get("implementation_updates")
      }
    });
    await load();
    state.selectedTicketId = ticket.id;
    state.detailMode = "ticket";
    await renderDetail();
    toast.success("AI fields saved");
  });

  $("#detailCommentForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = new FormData(event.currentTarget).get("body").trim();
    if (!body) return;
    await api(withBoardQuery(`/api/tickets/${ticket.id}/comments`), {
      method: "POST",
      body: { body }
    });
    await load();
    state.selectedTicketId = ticket.id;
    state.detailMode = "ticket";
    await renderDetail();
  });

  drawerInner.querySelectorAll("[data-open-ticket]").forEach((card) => {
    card.addEventListener("click", async (event) => {
      if (event.target.closest("[data-detach-child],[data-detach-parent],[data-detach-relation]")) return;
      navigate({
        boardId: state.boardId,
        view: "ticket",
        ticketId: card.dataset.openTicket
      });
    });
  });

  drawerInner.querySelectorAll("[data-detach-child]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const childId = btn.dataset.detachChild;
      try {
        await api(withBoardQuery(`/api/tickets/${childId}`), {
          method: "PATCH",
          body: { parent_ticket_id: null }
        });
      } catch (err) {
        toast.error(err.message || "Failed to remove child");
        return;
      }
      await load();
      state.selectedTicketId = ticket.id;
      state.detailMode = "ticket";
      await renderDetail();
      toast.success("Removed from epic");
    });
  });

  drawerInner.querySelectorAll("[data-detach-parent]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        await api(withBoardQuery(`/api/tickets/${ticket.id}`), {
          method: "PATCH",
          body: { parent_ticket_id: null }
        });
      } catch (err) {
        toast.error(err.message || "Failed to remove parent");
        return;
      }
      await load();
      state.selectedTicketId = ticket.id;
      state.detailMode = "ticket";
      await renderDetail();
      toast.success("Parent epic removed");
    });
  });

  drawerInner.querySelectorAll("[data-detach-relation]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const relationId = btn.dataset.detachRelation;
      try {
        await api(withBoardQuery(`/api/relations/${relationId}`), { method: "DELETE" });
      } catch (err) {
        toast.error(err.message || "Failed to remove relation");
        return;
      }
      await load();
      state.selectedTicketId = ticket.id;
      state.detailMode = "ticket";
      await renderDetail();
      toast.success("Relation removed");
    });
  });

  const aiPlanEl = drawerInner.querySelector("[data-ai-plan-toggle]");
  if (aiPlanEl) {
    aiPlanEl.addEventListener("toggle", () => {
      const id = aiPlanEl.dataset.ticketId;
      if (aiPlanEl.open) localStorage.setItem(`mab_ai_plan_open:${id}`, "1");
      else localStorage.removeItem(`mab_ai_plan_open:${id}`);
    });
  }

  const parentEpicForm = drawerInner.querySelector("#parentEpicForm");
  if (parentEpicForm) {
    const parentInput = parentEpicForm.querySelector("[name=target]");
    const parentClear = parentEpicForm.querySelector("[data-parent-epic-clear]");
    const syncParentClear = () => {
      parentEpicForm.classList.toggle("has-value", parentInput.value.length > 0);
    };
    parentInput.addEventListener("input", syncParentClear);
    syncParentClear();
    parentClear.addEventListener("click", () => {
      parentInput.value = "";
      syncParentClear();
      parentInput.focus();
    });
    parentEpicForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const targetLabel = String(new FormData(event.currentTarget).get("target") || "").trim();
      if (!targetLabel) return;
      const targetId = resolveTicketIdFromLabel(targetLabel, ticket.id);
      if (!targetId) {
        toast.warning("Pick an epic from the suggestions");
        return;
      }
      const target = ticketsForProject().find((t) => t.id === targetId);
      if (!target || canonicalTicketType(target.type) !== "epic") {
        toast.warning("Parent must be an epic");
        return;
      }
      try {
        await api(withBoardQuery(`/api/tickets/${ticket.id}`), {
          method: "PATCH",
          body: { parent_ticket_id: targetId }
        });
      } catch (err) {
        toast.error(err.message || "Failed to set parent epic");
        return;
      }
      await load();
      state.selectedTicketId = ticket.id;
      state.detailMode = "ticket";
      await renderDetail();
      toast.success("Parent epic set");
    });
  }

  const relatedAddForm = drawerInner.querySelector("#relatedAddForm");
  if (relatedAddForm) {
    const relatedInput = relatedAddForm.querySelector("[name=target]");
    const relatedClear = relatedAddForm.querySelector("[data-related-clear]");
    const syncRelatedClear = () => {
      relatedAddForm.classList.toggle("has-value", relatedInput.value.length > 0);
    };
    relatedInput.addEventListener("input", syncRelatedClear);
    syncRelatedClear();
    relatedClear.addEventListener("click", () => {
      relatedInput.value = "";
      syncRelatedClear();
      relatedInput.focus();
    });
    relatedAddForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const targetLabel = String(form.get("target") || "").trim();
      const relationType = String(form.get("type") || "relates_to");
      if (!targetLabel) return;
      const targetId = resolveTicketIdFromLabel(targetLabel, ticket.id);
      if (!targetId) {
        toast.warning("Pick a ticket from the suggestions");
        return;
      }
      try {
        await api(withBoardQuery(`/api/relations`), {
          method: "POST",
          body: { source_ticket_id: ticket.id, target_ticket_id: targetId, type: relationType }
        });
      } catch (err) {
        toast.error(err.message || "Failed to add relation");
        return;
      }
      await load();
      state.selectedTicketId = ticket.id;
      state.detailMode = "ticket";
      await renderDetail();
    });
  }

  openDrawer();
}

function aiPlanOpen(ticketId) {
  return localStorage.getItem(`mab_ai_plan_open:${ticketId}`) === "1";
}

function resolveTicketIdFromLabel(label, selfId) {
  const trimmed = label.trim();
  const match = trimmed.match(/^#?(\d+)\b/);
  const tickets = ticketsForProject().filter((t) => t.id !== selfId);
  if (match) {
    const n = Number(match[1]);
    const hit = tickets.find((t) => t.number === n);
    if (hit) return hit.id;
  }
  const exact = tickets.find((t) => `#${t.number} — ${t.title}` === trimmed);
  return exact ? exact.id : "";
}

function renderStatusHistory(history) {
  if (!history || history.length === 0) {
    return `<p class="description">No status changes yet.</p>`;
  }
  return history
    .map((event) => {
      const body = event.body;
      const from = body.from ? escapeHtml(body.from) : "?";
      const to = escapeHtml(body.to || body.state || body.next_state || "?");
      const byLine = escapeHtml(
        formatActorLabel({
          actor: event.actor,
          actorType: body.actor_type || "human",
          actorId: body.actor_id
        })
      );
      return `<div class="comment status-change">
        <div class="comment-meta">
          <span class="status-route">${from} → ${to}</span>
          <span>${byLine} · ${formatDate(event.created_at)}</span>
        </div>
      </div>`;
    })
    .join("");
}

function renderComment(comment) {
  return `
    <div class="comment ${comment.kind === "checkpoint" ? "checkpoint" : ""}">
      <div class="comment-meta">
        <strong>${escapeHtml(formatCommentAuthor(comment))}</strong>
        <span>${comment.kind === "human_comment" ? "" : `${escapeHtml(comment.kind)} - `}${formatDate(comment.created_at)}</span>
      </div>
      <div class="comment-body">${escapeHtml(comment.body)}</div>
    </div>
  `;
}

function renderRelated(relations = [], ticket) {
  const relatedIds = new Set(relations.map((r) => r.other_ticket.id));
  const hierarchyIds = new Set();
  if (ticket?.parent_ticket_id) hierarchyIds.add(ticket.parent_ticket_id);
  if (ticket?.id) {
    for (const t of ticketsForProject()) {
      if (t.parent_ticket_id === ticket.id) hierarchyIds.add(t.id);
    }
  }
  const candidates = ticketsForProject().filter(
    (t) => t.id !== ticket?.id && !relatedIds.has(t.id) && !hierarchyIds.has(t.id)
  );
  const datalistOptions = candidates
    .map((t) => `<option value="#${t.number} — ${escapeHtml(t.title)}"></option>`)
    .join("");

  const list = relations.length
    ? `<div class="detail-card-grid">${relations.map((r) => renderRelatedCard(r)).join("")}</div>`
    : "";

  const form = `
    <form id="relatedAddForm" class="related-add-row">
      <div class="related-add-input-wrap">
        <input type="text" name="target" class="related-add-input meta-inline-input" list="related-ticket-suggestions" placeholder="Add related ticket…" aria-label="Add related ticket" autocomplete="off" />
        <button type="button" class="related-add-clear" data-related-clear aria-label="Clear" tabindex="-1">×</button>
        <datalist id="related-ticket-suggestions">${datalistOptions}</datalist>
      </div>
      <select name="type" class="related-add-type meta-inline" aria-label="Relation type">
        <option value="relates_to">relates to</option>
        <option value="blocks">blocks</option>
        <option value="blocked_by">blocked by</option>
      </select>
      <button type="submit" class="ghost meta-add-btn">Add</button>
    </form>
  `;

  return list + form;
}

function renderHierarchySection(ticket, context) {
  const isEpic = canonicalTicketType(ticket.type) === "epic";
  if (isEpic) {
    const cards = context.child_tickets || [];
    const body = cards.length
      ? `<div class="detail-card-grid">${cards.map((c) => renderDetailCard(c, { detach: { mode: "child", id: c.id } })).join("")}</div>`
      : `<p class="description">No child features yet. Create a feature / task card and set this epic as its parent.</p>`;
    return `
      <div class="section">
        <h3>Features inside this Epic</h3>
        ${body}
      </div>
    `;
  }
  return "";
}

function renderParentEpicSection(ticket, context) {
  if (canonicalTicketType(ticket.type) === "epic") return "";

  const epics = ticketsForProject().filter((t) => t.type === "epic" && t.id !== ticket.id);
  const datalistOptions = epics
    .map((t) => `<option value="#${t.number} — ${escapeHtml(t.title)}"></option>`)
    .join("");

  const body = context.parent_ticket
    ? `<div class="detail-card-grid detail-card-grid--single">${renderDetailCard(context.parent_ticket, { detach: { mode: "parent" } })}</div>`
    : `
      <form id="parentEpicForm" class="related-add-row">
        <div class="related-add-input-wrap">
          <input type="text" name="target" class="related-add-input meta-inline-input" list="parent-epic-suggestions" placeholder="Set parent epic…" aria-label="Set parent epic" autocomplete="off" />
          <button type="button" class="related-add-clear" data-parent-epic-clear aria-label="Clear" tabindex="-1">×</button>
          <datalist id="parent-epic-suggestions">${datalistOptions}</datalist>
        </div>
        <button type="submit" class="ghost meta-add-btn">Set</button>
      </form>
    `;

  return `
    <div class="section">
      <h3>Epic</h3>
      ${body}
    </div>
  `;
}

export function renderDetailCard(ticket, options = {}) {
  const canonicalType = canonicalTicketType(ticket.type);
  const priorityKey = priorityKeyFor(ticket.priority);
  const typeText = typeLabel(ticket.type).toUpperCase();
  const eyebrow = options.eyebrow
    ? `<span class="card-eyebrow">${escapeHtml(options.eyebrow)}</span>`
    : "";
  let detachBtn = "";
  if (options.detach) {
    const { mode, id } = options.detach;
    let attr = "";
    let label = "";
    if (mode === "child") {
      attr = `data-detach-child="${escapeHtml(id)}"`;
      label = "Remove from epic";
    } else if (mode === "parent") {
      attr = `data-detach-parent="1"`;
      label = "Remove parent epic";
    } else if (mode === "relation") {
      attr = `data-detach-relation="${escapeHtml(id)}"`;
      label = "Remove relation";
    }
    detachBtn = `<button type="button" class="card-detach-btn" ${attr} aria-label="${label}" title="${label}">×</button>`;
  } else if (options.archive) {
    const tid = escapeHtml(options.archive.id);
    const restoreSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>`;
    const trashSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;
    detachBtn = `
      <div class="card-archive-actions">
        <button type="button" class="card-archive-btn card-archive-btn--restore" data-archive-restore="${tid}" aria-label="Restore to board" title="Restore to board">${restoreSvg}</button>
        <button type="button" class="card-archive-btn card-archive-btn--delete" data-archive-delete="${tid}" aria-label="Delete permanently" title="Delete permanently">${trashSvg}</button>
      </div>
    `;
  }
  const unreadN = unreadCount(ticket);
  const unreadDot = unreadN === 0
    ? ""
    : unreadN === 1
      ? `<span class="card-unread-dot" role="status" aria-label="1 unread update"></span>`
      : `<span class="card-unread-dot has-count" role="status" aria-label="${unreadN} unread updates">${unreadN > 99 ? "99+" : unreadN}</span>`;
  return `
    <article class="card card--detail type-${escapeHtml(canonicalType)} priority-${escapeHtml(priorityKey)}"${options.disableOpen ? "" : ` data-open-ticket="${escapeHtml(ticket.id)}"`}>
      ${unreadDot}
      ${detachBtn}
      ${eyebrow}
      <h3>${escapeHtml(ticket.title)}</h3>
      <div class="card-meta">
        <div class="card-expand-trigger card-expand-trigger--static">
          <span class="ticket-number">${escapeHtml(ticketLabel(ticket))}</span>
          <div class="card-type-id type-pill-${escapeHtml(canonicalType)}">
            ${renderTypeIcon(ticket.type)}
            <span class="card-type-label">${escapeHtml(typeText)}</span>
          </div>
          ${state.showPriority ? renderPriorityPill(ticket.priority) : ""}
        </div>
      </div>
    </article>
  `;
}

function renderRelatedCard(relation) {
  const verb = String(relation.type || "").replace(/_/g, " ");
  const direction = relation.direction === "incoming" ? "from" : "to";
  return renderDetailCard(relation.other_ticket, {
    eyebrow: `${verb} ${direction}`,
    detach: { mode: "relation", id: relation.id }
  });
}
