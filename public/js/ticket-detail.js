// Ticket detail drawer: renders the full ticket pane (header meta, AI plan,
// status history, comments) and wires every editable surface — inline title
// and description editors, meta selects, label management, parent epic, and
// related cards. Also owns the small render helpers (status history,
// comments, detail-card) that are only used inside the drawer.

import { state, ticketsForProject, selectableStatesForProject, boardLabelCatalog, currentBoard, upsertTicket } from "./state.js";
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
  renderPreservedText,
  stateClassFor,
  cleanText
} from "./format.js";
import { renderTypeIcon, renderPriorityPill, renderBoard } from "./kanban.js";
import { renderDrawerShell, openDrawer, closeDrawer } from "./drawer.js";
import { navigate } from "./router.js";
import { api, withBoardQuery } from "./api.js";
import { features } from "./config.js";
import { toast } from "./toast.js";
// `load()` is intentionally not used for drawer-local mutations. Reloading
// /api/bootstrap rebuilds the whole app; these helpers patch the local ticket
// cache and refresh only the surfaces that actually changed.
import { renderProjectDetail } from "./settings.js";
import { unreadCount, markRead } from "./unread.js";
import { formatActorLabel, formatCommentAuthor } from "./actor-labels.js";

/**
 * Refresh the open drawer from the focused ticket context endpoint. When the
 * board card itself changed, also rebuild the board from the patched local
 * cache; otherwise leave the board DOM alone.
 */
async function refreshTicketDetail(ticketId, { renderBoardAfter = false } = {}) {
  state.selectedTicketId = ticketId;
  state.detailMode = "ticket";
  const [context, statusHistory, commentsResult] = await Promise.all([
    api(withBoardQuery(`/api/tickets/${ticketId}/context?depth=1`)),
    api(withBoardQuery(`/api/tickets/${ticketId}/history`)),
    api(withBoardQuery(`/api/tickets/${ticketId}/comments`))
  ]);
  upsertTicket(context.ticket);
  if (renderBoardAfter) renderBoard();
  await renderDetail({ context, statusHistory, comments: commentsResult.comments || [] });
}

/**
 * PATCH a ticket then refresh only the board/detail surfaces that depend on
 * the changed ticket. This avoids the previous full /api/bootstrap reload for
 * every drawer edit.
 */
async function patchTicket(ticketId, body) {
  await api(withBoardQuery(`/api/tickets/${ticketId}`), { method: "PATCH", body });
  await refreshTicketDetail(ticketId, { renderBoardAfter: true });
}

/**
 * Replace a static node with an inline editor; commit on Enter / blur, cancel on Esc.
 * For multi-line fields, Ctrl/Cmd+Enter commits and plain Enter inserts a newline.
 *
 * Options:
 *   - fieldName: short identifier used for aria-label / data attribute (e.g. "title").
 *   - multiline: true for <textarea> + Ctrl+Enter commit; false for <input> + Enter commit.
 *   - initialValue: text shown in the editor on open.
 *   - ariaLabel: full label for screen readers.
 *   - emptyMessage: if set, an empty trimmed value triggers a warning toast and cancels.
 *   - rerender: async fn called on cancel / no-change to put the static node back.
 *   - commit: async fn called with the new value when the user accepts a real change.
 *             Receives the *raw* editor value; the caller is responsible for any
 *             trimming, cleanText, or PATCH wiring.
 */
export function startInlineEdit(node, opts) {
  if (!node || node.dataset.editing === "true") return;
  const {
    fieldName,
    multiline = true,
    initialValue = "",
    ariaLabel,
    emptyMessage,
    rerender,
    commit: commitHandler
  } = opts;

  node.dataset.editing = "true";

  const editor = document.createElement(multiline ? "textarea" : "input");
  editor.className = multiline ? "inline-desc-editor" : "inline-title-editor";
  editor.value = initialValue;
  if (fieldName) editor.setAttribute("data-editing-field", fieldName);
  if (ariaLabel) editor.setAttribute("aria-label", ariaLabel);
  if (!multiline) {
    editor.type = "text";
    editor.maxLength = 500;
    editor.autocomplete = "off";
    editor.spellcheck = true;
  } else {
    editor.rows = Math.max(3, String(initialValue).split("\n").length + 1);
  }

  node.replaceWith(editor);
  editor.focus();
  if (!multiline) editor.select();
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
    // reliably blur the input in every browser. Force the blur path used on
    // commit so the edit styling cannot get stuck.
    editor.blur();
  }

  document.addEventListener("pointerdown", handleOutsidePointerDown, true);

  const commit = async () => {
    if (done) return;
    const next = multiline ? editor.value : editor.value.trim();
    finish();
    if (String(next) === String(initialValue)) {
      if (rerender) await rerender();
      return;
    }
    if (emptyMessage && !next.trim()) {
      toast.warning(emptyMessage);
      if (rerender) await rerender();
      return;
    }
    if (commitHandler) await commitHandler(next);
  };

  const cancel = async () => {
    if (done) return;
    finish();
    if (rerender) await rerender();
  };

  editor.addEventListener("blur", commit);
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void cancel();
      return;
    }
    if (event.key === "Enter") {
      if (!multiline) {
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

  const editTitle = () =>
    startInlineEdit(titleEl, {
      fieldName: "title",
      multiline: false,
      initialValue: ticket.title || "",
      ariaLabel: "Edit ticket title",
      emptyMessage: "Title cannot be empty",
      rerender: () => renderDetail(),
      commit: (next) => patchTicket(ticketId, { title: next })
    });

  const titleEl = drawer.querySelector('[data-edit-field="title"]');
  if (titleEl) {
    titleEl.addEventListener("click", editTitle);
    titleEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        editTitle();
      }
    });
  }

  const descEl = drawerInner.querySelector('[data-edit-field="description"]');
  const editDescription = () =>
    startInlineEdit(descEl, {
      fieldName: "description",
      multiline: true,
      initialValue: ticket.description || "",
      ariaLabel: "Edit ticket description",
      rerender: () => renderDetail(),
      commit: (next) => patchTicket(ticketId, { description: cleanText(next) })
    });

  if (descEl) {
    descEl.addEventListener("click", (event) => {
      event.preventDefault();
      editDescription();
    });
    descEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        editDescription();
      }
    });
  }

  // AI Plan / Implementation fields: each becomes its own click-to-edit
  // surface so they save independently on blur / Ctrl+Enter, matching the
  // description field. The "ai_plan" / "implementation_summary" /
  // "implementation_updates" data-edit-field selectors are emitted by the
  // detail body template below.
  const AI_FIELDS = [
    { key: "ai_plan", label: "AI plan" },
    { key: "implementation_summary", label: "Implementation summary" },
    { key: "implementation_updates", label: "Implementation updates / lessons" }
  ];
  for (const { key, label } of AI_FIELDS) {
    const fieldEl = drawerInner.querySelector(`[data-edit-field="${key}"]`);
    if (!fieldEl) continue;
    const edit = () =>
      startInlineEdit(fieldEl, {
        fieldName: key,
        multiline: true,
        initialValue: ticket[key] || "",
        ariaLabel: `Edit ${label}`,
        rerender: () => renderDetail(),
        commit: (next) => patchTicket(ticketId, { [key]: cleanText(next) })
      });
    fieldEl.addEventListener("click", (event) => {
      event.preventDefault();
      edit();
    });
    fieldEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        edit();
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

export async function renderDetail(options = {}) {
  if (state.detailMode === "settings") {
    await renderProjectDetail();
    openDrawer();
    return;
  }

  if (!state.selectedTicketId) {
    closeDrawer();
    return;
  }

  const hasOption = (key) => Object.prototype.hasOwnProperty.call(options, key);
  const [context, statusHistory, comments, attachmentList] = await Promise.all([
    hasOption("context")
      ? Promise.resolve(options.context)
      : api(withBoardQuery(`/api/tickets/${state.selectedTicketId}/context?depth=1`)),
    hasOption("statusHistory")
      ? Promise.resolve(options.statusHistory)
      : api(withBoardQuery(`/api/tickets/${state.selectedTicketId}/history`)),
    hasOption("comments")
      ? Promise.resolve(options.comments)
      : api(withBoardQuery(`/api/tickets/${state.selectedTicketId}/comments`)).then((result) => result.comments || []),
    hasOption("attachmentList")
      ? Promise.resolve(options.attachmentList)
      : features.attachments
        ? api(withBoardQuery(`/api/tickets/${state.selectedTicketId}/attachments`)).catch(() => ({ attachments: [] }))
        : Promise.resolve({ attachments: [] })
  ]);
  const ticket = context.ticket;
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
  const stateClass = stateClassFor(currentState);
  const descriptionHtml = ticket.description ? renderPreservedText(ticket.description) : escapeHtml("No description yet.");
  const descriptionClass = ticket.description
    ? "description preserved-text-body editable-field"
    : "description editable-field is-placeholder";
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
      <div class="${descriptionClass}" data-edit-field="description" tabindex="0" title="Click to edit">${descriptionHtml}</div>
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

    ${features.attachments ? renderAttachmentSection(ticket, attachmentList.attachments || []) : ""}

    ${renderParentEpicSection(ticket, context)}

    <div class="section">
      <h3>Related</h3>
      ${renderRelated(context.relations, ticket)}
    </div>

    ${currentBoard()?.ai_enabled !== 0 ? `
    <details class="section ai-fields" data-ai-plan-toggle data-ticket-id="${escapeHtml(ticket.id)}"${aiPlanOpen(ticket.id) ? " open" : ""}>
      <summary><h3>AI Plan / Implementation Record</h3></summary>
      <div class="ai-fields-grid">
        ${renderInlinePreservedTextField({
          fieldName: "ai_plan",
          label: "AI-Written Plan",
          value: ticket.ai_plan,
          placeholder: "Paste or let an AI write the plan..."
        })}
        ${renderInlinePreservedTextField({
          fieldName: "implementation_summary",
          label: "Implementation Summary",
          value: ticket.implementation_summary,
          placeholder: "What changed, what shipped, what remains..."
        })}
        ${renderInlinePreservedTextField({
          fieldName: "implementation_updates",
          label: "Implementation Updates / Lessons",
          value: ticket.implementation_updates,
          placeholder: "Progress notes, mistakes to avoid, discoveries..."
        })}
      </div>
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
  if (features.attachments) wireAttachmentControls(ticket);

  $("#detailCommentForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = cleanText(new FormData(event.currentTarget).get("body")).trim();
    if (!body) return;
    await api(withBoardQuery(`/api/tickets/${ticket.id}/comments`), {
      method: "POST",
      body: { body }
    });
    await refreshTicketDetail(ticket.id);
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
      await refreshTicketDetail(ticket.id, { renderBoardAfter: true });
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
      await refreshTicketDetail(ticket.id, { renderBoardAfter: true });
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
      await refreshTicketDetail(ticket.id);
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
      await refreshTicketDetail(ticket.id, { renderBoardAfter: true });
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
      await refreshTicketDetail(ticket.id);
    });
  }

  openDrawer();
}

function aiPlanOpen(ticketId) {
  return localStorage.getItem(`mab_ai_plan_open:${ticketId}`) === "1";
}

function renderAttachmentSection(ticket, attachments = []) {
  const cards = attachments.length
    ? `<div class="attachment-grid">${attachments.map((attachment) => renderAttachmentCard(ticket, attachment)).join("")}</div>`
    : `<p class="description">No images attached yet.</p>`;
  return `
    <div class="section attachments-section" data-attachment-section data-ticket-id="${escapeHtml(ticket.id)}">
      <div class="attachment-heading-row">
        <h3>Images</h3>
        <label class="ghost attachment-upload-button">
          Upload
          <input type="file" accept="image/*" multiple data-attachment-input />
        </label>
      </div>
      <div class="attachment-dropzone" data-attachment-dropzone tabindex="0">
        <strong>Paste, drag, or upload images</strong>
        <span>PNG, JPG, GIF, WebP, SVG, BMP, or AVIF up to 10 MB each.</span>
      </div>
      ${cards}
    </div>
  `;
}

function renderAttachmentCard(ticket, attachment) {
  const name = escapeHtml(attachment.original_name || "image");
  const meta = `${formatBytes(attachment.size_bytes)} · ${escapeHtml(attachment.mime_type || "image")}`;
  if (attachment.missing) {
    return `
      <article class="attachment-card is-missing">
        <div class="attachment-missing-thumb">Missing</div>
        <div class="attachment-card-meta"><strong>${name}</strong><span>${meta}</span></div>
        <button type="button" class="attachment-delete" data-delete-attachment="${escapeHtml(attachment.id)}" aria-label="Remove missing image">×</button>
      </article>
    `;
  }
  const src = withBoardQuery(attachment.content_url || `/api/tickets/${ticket.id}/attachments/${attachment.id}/content`);
  return `
    <article class="attachment-card">
      <button type="button" class="attachment-thumb-button" data-open-lightbox="${escapeHtml(src)}" data-lightbox-title="${name}">
        <img src="${escapeHtml(src)}" alt="${name}" loading="lazy" />
      </button>
      <div class="attachment-card-meta"><strong>${name}</strong><span>${meta}</span></div>
      <button type="button" class="attachment-delete" data-delete-attachment="${escapeHtml(attachment.id)}" aria-label="Remove image">×</button>
    </article>
  `;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function imageFilesFromList(files) {
  return [...(files || [])].filter((file) => file && String(file.type || "").startsWith("image/"));
}

async function uploadAttachmentFiles(ticket, files) {
  const imageFiles = imageFilesFromList(files);
  if (!imageFiles.length) {
    toast.warning("No image files found");
    return;
  }
  for (const file of imageFiles) {
    const response = await fetch(withBoardQuery(`/api/tickets/${ticket.id}/attachments?filename=${encodeURIComponent(file.name || "image")}`), {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-File-Name": file.name || "image"
      },
      body: file
    });
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch {}
      throw new Error(payload.error || `Upload failed (${response.status})`);
    }
  }
  await refreshTicketDetail(ticket.id);
  toast.success(imageFiles.length === 1 ? "Image attached" : `${imageFiles.length} images attached`);
}

function wireAttachmentControls(ticket) {
  const section = drawerInner.querySelector("[data-attachment-section]");
  if (!section) return;
  const input = section.querySelector("[data-attachment-input]");
  input?.addEventListener("change", async () => {
    try {
      await uploadAttachmentFiles(ticket, input.files);
      input.value = "";
    } catch (err) {
      toast.error(err.message || "Upload failed");
    }
  });

  const dropzone = section.querySelector("[data-attachment-dropzone]");
  dropzone?.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("is-dragover");
  });
  dropzone?.addEventListener("dragleave", () => dropzone.classList.remove("is-dragover"));
  dropzone?.addEventListener("drop", async (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragover");
    try {
      await uploadAttachmentFiles(ticket, event.dataTransfer?.files || []);
    } catch (err) {
      toast.error(err.message || "Upload failed");
    }
  });

  drawerInner.onpaste = async (event) => {
    if (event.target.closest("input, textarea, [contenteditable='true']")) return;
    const files = imageFilesFromList(event.clipboardData?.files || []);
    if (!files.length) return;
    event.preventDefault();
    try {
      await uploadAttachmentFiles(ticket, files);
    } catch (err) {
      toast.error(err.message || "Paste upload failed");
    }
  };

  section.querySelectorAll("[data-delete-attachment]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api(withBoardQuery(`/api/tickets/${ticket.id}/attachments/${btn.dataset.deleteAttachment}`), { method: "DELETE" });
        await refreshTicketDetail(ticket.id);
        toast.success("Image removed");
      } catch (err) {
        toast.error(err.message || "Delete failed");
      }
    });
  });

  section.querySelectorAll("[data-open-lightbox]").forEach((btn) => {
    btn.addEventListener("click", () => openAttachmentLightbox(btn.dataset.openLightbox, btn.dataset.lightboxTitle || "Image"));
  });
}

function openAttachmentLightbox(src, title) {
  const existing = document.querySelector(".attachment-lightbox");
  existing?.remove();
  const overlay = document.createElement("div");
  overlay.className = "attachment-lightbox";
  overlay.innerHTML = `
    <div class="attachment-lightbox-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <button type="button" class="attachment-lightbox-close" aria-label="Close image">×</button>
      <img src="${escapeHtml(src)}" alt="${escapeHtml(title)}" />
      <p>${escapeHtml(title)}</p>
    </div>
  `;
  const close = () => {
    document.removeEventListener("keydown", onKeyDown);
    overlay.remove();
  };
  function onKeyDown(event) {
    if (event.key === "Escape") close();
  }
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay || event.target.closest(".attachment-lightbox-close")) close();
  });
  document.addEventListener("keydown", onKeyDown);
  document.body.append(overlay);
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
      <div class="comment-body preserved-text-body">${renderPreservedText(comment.body)}</div>
    </div>
  `;
}

/**
 * Click-to-edit row for AI Plan / Implementation fields and any other
 * long-form ticket field that should render literal read-only text and become
 * a textarea on click. The wiring (event handlers + commit) lives in
 * wireTicketDetailEditors so this helper stays a pure template.
 */
export function renderInlinePreservedTextField({ fieldName, label, value, placeholder }) {
  const text = value || "";
  const hasValue = Boolean(text.trim());
  const inner = hasValue ? renderPreservedText(text) : escapeHtml(placeholder || "");
  const placeholderClass = hasValue ? "" : "is-placeholder";
  return `
    <div class="inline-md-field">
      <span class="inline-md-field-label">${escapeHtml(label)}</span>
      <div
        class="inline-md-field-body preserved-text-body editable-field ${placeholderClass}"
        data-edit-field="${escapeHtml(fieldName)}"
        tabindex="0"
        title="Click to edit"
        role="button"
        aria-label="Edit ${escapeHtml(label)}"
      >${inner}</div>
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
  const stateClass = stateClassFor(ticket);
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
          <span class="detail-card-state state-pill-${escapeHtml(stateClass)}">${escapeHtml(ticket.state_name || "State")}</span>
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
