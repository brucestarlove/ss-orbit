import { cleanText, escapeHtml, renderPreservedText } from "./format.js";

const NOTE_FALLBACK = "No board notes yet";
const NOTES_PLACEHOLDER = "Add board notes for yourself and your agents…";

function compactText(value) {
  return cleanText(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function boardNotesSummary(board = {}) {
  return compactText(board.project_notes) || NOTE_FALLBACK;
}

function updateCachedBoard(board, appState) {
  if (!board?.id || !appState?.data?.boards) return;
  const index = appState.data.boards.findIndex((item) => item.id === board.id);
  if (index >= 0) appState.data.boards.splice(index, 1, { ...appState.data.boards[index], ...board });
}

let lastRenderedBoard = {};

function renderNotesBody(board) {
  const notes = board?.project_notes || "";
  const hasNotes = Boolean(notes.trim());
  const placeholderClass = hasNotes ? "" : " is-placeholder";
  const inner = hasNotes ? renderPreservedText(notes) : escapeHtml(NOTES_PLACEHOLDER);
  return `
    <div
      class="inline-md-field-body preserved-text-body editable-field settings-notes-body brand-focus-notes-edit${placeholderClass}"
      data-edit-field="project_notes"
      tabindex="0"
      title="Click to edit"
      role="button"
      aria-label="Edit Notes For You"
    >${inner}</div>
  `;
}

export function renderTopbarFocus(board = lastRenderedBoard) {
  lastRenderedBoard = board || {};
  const summary = boardNotesSummary(lastRenderedBoard);
  const notesButton = document.getElementById("brandNotesBtn");
  const notesText = document.getElementById("brandNotesText");
  const notesBody = document.getElementById("brandFocusNotes");

  if (notesButton) {
    notesButton.hidden = false;
    notesButton.dataset.empty = summary === NOTE_FALLBACK ? "true" : "false";
    notesButton.setAttribute("aria-label", `Show board notes: ${summary}`);
  }
  if (notesText) notesText.textContent = summary === NOTE_FALLBACK ? "" : summary;
  if (notesBody) notesBody.innerHTML = renderNotesBody(lastRenderedBoard);
}

function setPopoverOpen(open) {
  const buttons = [
    document.getElementById("brandFocusBtn"),
    document.getElementById("brandNotesBtn")
  ].filter(Boolean);
  const popover = document.getElementById("brandFocusPopover");
  if (!popover) return;
  for (const button of buttons) {
    button.setAttribute("aria-expanded", open ? "true" : "false");
    button.dataset.state = open ? "open" : "closed";
  }
  popover.hidden = !open;
}

function togglePopover() {
  const popover = document.getElementById("brandFocusPopover");
  renderTopbarFocus();
  setPopoverOpen(Boolean(popover?.hidden));
}

async function startBoardNotesEdit(sourceEvent) {
  const notesEl = document.querySelector('#brandFocusPopover [data-edit-field="project_notes"]');
  if (!notesEl || !lastRenderedBoard?.id) return;
  const { startInlineEdit } = await import("./ticket-detail.js");
  startInlineEdit(notesEl, {
    fieldName: "project_notes",
    multiline: true,
    initialValue: lastRenderedBoard.project_notes || "",
    ariaLabel: "Edit Notes For You",
    sourceEvent,
    rerender: async () => {
      renderTopbarFocus(lastRenderedBoard);
      setPopoverOpen(true);
    },
    commit: async (next) => {
      const [{ api }, { state }] = await Promise.all([
        import("./api.js"),
        import("./state.js")
      ]);
      const updatedBoard = await api(`/api/boards/${encodeURIComponent(lastRenderedBoard.id || state.boardId)}`, {
        method: "PATCH",
        body: { project_notes: cleanText(next) }
      });
      lastRenderedBoard = { ...lastRenderedBoard, ...updatedBoard };
      updateCachedBoard(lastRenderedBoard, state);
      renderTopbarFocus(lastRenderedBoard);
      setPopoverOpen(true);
    }
  });
}

export function wireTopbarFocus() {
  const logoButton = document.getElementById("brandFocusBtn");
  const notesButton = document.getElementById("brandNotesBtn");
  const popover = document.getElementById("brandFocusPopover");
  if (!logoButton || !notesButton || !popover) return;

  logoButton.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePopover();
  });

  notesButton.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePopover();
  });

  popover.addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.target.closest('[data-edit-field="project_notes"]')) {
      void startBoardNotesEdit(event);
    }
  });

  popover.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (!event.target.closest('[data-edit-field="project_notes"]')) return;
    event.preventDefault();
    void startBoardNotesEdit(event);
  });

  document.addEventListener("click", (event) => {
    if (
      event.target.closest("#brandFocusBtn") ||
      event.target.closest("#brandNotesBtn") ||
      event.target.closest("#brandFocusPopover")
    ) return;
    setPopoverOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    setPopoverOpen(false);
  });
}
