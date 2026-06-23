// Board picker flyout (the "Board" chip in the topbar). Lists every board
// the actor can see, switches between them, and — for owners — exposes the
// new-board form. Also owns the topbar chip label/title sync.

import { boardFlyout, boardMenuBtn } from "./dom.js";
import { state } from "./state.js";
import { escapeHtml } from "./format.js";
import { api } from "./api.js";
import { navigate, syncUrlFromState } from "./router.js";
import { closeCreateFlyout } from "./create-card.js";
import { toast } from "./toast.js";
import { load } from "./app.js";
import { features } from "./config.js";
import { exportAllBoards } from "./board-export.js";

let boardFlyoutView = "list";

export function closeBoardFlyout() {
  if (!boardFlyout) return;
  boardFlyout.hidden = true;
  boardFlyout.innerHTML = "";
  boardFlyoutView = "list";
  boardMenuBtn?.setAttribute("aria-expanded", "false");
}

export function closeMenuFlyouts() {
  closeBoardFlyout();
}

const boardChipIcon = `
  <svg
    class="topbar-icon"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <rect x="4" y="2" width="6" height="20" rx="0.75" stroke="currentColor" stroke-width="2" />
    <rect x="14" y="2" width="6" height="20" rx="0.75" stroke="currentColor" stroke-width="2" />
  </svg>`;

export function updateTopbarChips() {
  if (!state.data) return;
  const board = (state.data.boards || []).find((b) => b.id === state.boardId);
  if (boardMenuBtn) {
    const label = board?.name || "Board";
    boardMenuBtn.innerHTML = `${boardChipIcon}<span class="topbar-chip-label">${escapeHtml(label)}</span>`;
    boardMenuBtn.title = board ? `${board.name} — slug: ${board.slug}` : "Choose board";
  }
}

async function inflateZipEntry(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Compressed ZIP entries are not supported in this browser.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseImportSnapshotText(text, filename = "snapshot") {
  const trimmed = String(text || "").trimStart();
  if (trimmed.startsWith("<")) throw new Error(`${filename} looks like HTML instead of JSON.`);
  try {
    const snapshot = JSON.parse(text);
    if (!snapshot?.board) throw new Error("snapshot_missing_board");
    return snapshot;
  } catch (error) {
    throw new Error(`${filename}: ${error?.message || "invalid JSON"}`);
  }
}

async function readZipSnapshots(file) {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  const snapshots = [];
  let offset = 0;

  while (offset + 30 <= bytes.length) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) throw new Error("Invalid ZIP archive.");

    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const filenameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + filenameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (flags & 0x0008) throw new Error("ZIP entries with data descriptors are not supported.");
    if (dataEnd > bytes.length) throw new Error("Invalid ZIP archive.");

    const name = decoder.decode(bytes.slice(nameStart, nameStart + filenameLength));
    if (!name.endsWith("/")) {
      if (!name.toLowerCase().endsWith(".orbit.json")) {
        throw new Error("ZIP imports may contain only .orbit.json files.");
      }
      const compressed = bytes.slice(dataStart, dataEnd);
      const data = method === 0 ? compressed : method === 8 ? await inflateZipEntry(compressed) : null;
      if (!data) throw new Error("Unsupported ZIP compression method.");
      snapshots.push(parseImportSnapshotText(decoder.decode(data), name));
    }

    offset = dataEnd;
  }

  if (!snapshots.length) throw new Error("ZIP archive did not contain any .orbit.json snapshots.");
  return snapshots;
}

async function readImportSnapshots(file) {
  const name = String(file?.name || "").toLowerCase();
  if (name.endsWith(".zip")) return readZipSnapshots(file);
  if (name.endsWith(".orbit.json")) return [parseImportSnapshotText(await file.text(), file.name)];
  throw new Error("Choose a .zip archive or a single .orbit.json snapshot.");
}

function renderBoardFlyoutHeader() {
  const showListButton = boardFlyoutView !== "list";
  const newLabel = showListButton ? "List" : "New";
  return `
    <div class="menu-flyout-head menu-flyout-head--actions">
      <span>Board</span>
      <span class="menu-flyout-actions">
        ${features.multiBoard ? `<button type="button" data-variant="ghost" data-board-view="${showListButton ? "list" : "new"}">${newLabel}</button>` : ""}
        <button type="button" data-variant="ghost" data-board-view="export">Export</button>
      </span>
    </div>`;
}

function renderBoardFlyoutInner() {
  const boards = state.data.boards || [];
  const rows = boards
    .map(
      (b) => `
      <button type="button" class="menu-flyout-item ${b.id === state.boardId ? "is-current" : ""}" data-variant="menu-item" data-pick-board="${escapeHtml(b.id)}" role="menuitem">
        <span class="menu-flyout-item-title">${escapeHtml(b.name)}</span>
        <span class="menu-flyout-item-meta">${escapeHtml(b.slug)}</span>
      </button>`
    )
    .join("");
  const listBody =
    rows ||
    `<p class="menu-flyout-hint menu-flyout-hint--empty">No boards yet. Create one below if you can.</p>`;
  const listBlock = `<div class="menu-flyout-list">${listBody}</div>`;
  const createBlock = `
    <div class="menu-flyout-section">
      <h3 class="menu-flyout-heading">New Board</h3>
      <form id="createBoardForm" class="menu-flyout-form">
        <input name="name" type="text" required placeholder="Board name" autocomplete="off" />
        <div class="folder-picker-field">
          <input id="repoPathInput" name="repo_path" type="text" readonly placeholder="Coding project folder (optional)" autocomplete="off" />
          <button type="button" id="pickRepoFolderBtn">Browse</button>
        </div>
        <div id="helperFilesReveal" hidden>
          <p class="menu-flyout-hint menu-flyout-hint--intro">Orbit writes <code>SKILL-ORBIT.md</code> and <code>AGENTS.md</code> into this folder for your AI coding agent.</p>
          <label class="menu-flyout-check">
            <input id="helperFilesCheckbox" name="manage_helper_files" type="checkbox" checked />
            <span>Generate AI helper files (<code>SKILL-ORBIT.md</code>, <code>AGENTS.md</code>)</span>
          </label>
        </div>
        <input name="slug" type="text" placeholder="Slug (optional)" autocomplete="off" />
        <button type="submit">Create board</button>
      </form>
    </div>`;
  const exportBlock = `
    <div class="menu-flyout-section menu-flyout-section--export">
      <p class="menu-flyout-copy">Export every board as Orbit snapshots in a ZIP archive.</p>
      ${features.attachments ? `
        <label class="orbit-check menu-flyout-toggle">
          <input type="checkbox" id="exportAllBoardImages" />
          <span class="orbit-check-box" aria-hidden="true">
            <svg viewBox="0 0 16 16" class="orbit-check-tick"><path d="M3.5 8.5l3 3 6-7" /></svg>
          </span>
          <span class="menu-flyout-toggle-text">Include attached images</span>
        </label>
      ` : ""}
      <div class="menu-flyout-actions-row">
        <button type="button" id="exportAllBoards">Export All</button>
      </div>
      <div class="menu-flyout-divider" aria-hidden="true"></div>
      <section class="menu-flyout-danger-section" aria-label="Import All">
        <h3 class="menu-flyout-danger-heading">Import All</h3>
        <p class="menu-flyout-danger-copy">Imports fully overwrite each matching board. Snapshots without a matching board create new boards.</p>
        <div class="menu-flyout-actions-row">
          <input type="file" id="importAllBoardsFile" class="import-file-input" accept=".zip,.orbit.json,application/zip" />
          <button type="button" data-arc="danger" id="importAllBoards">Import All</button>
        </div>
      </section>
    </div>`;
  const body = boardFlyoutView === "export" ? exportBlock : boardFlyoutView === "new" && features.multiBoard ? createBlock : listBlock;
  return `
    ${renderBoardFlyoutHeader()}
    ${body}
  `;
}

function rerenderBoardFlyout(view) {
  boardFlyoutView = view;
  boardFlyout.innerHTML = renderBoardFlyoutInner();
  wireBoardFlyout();
  if (view === "new") boardFlyout.querySelector('input[name="name"]')?.focus();
}

function wireBoardFlyout() {
  boardFlyout.querySelectorAll("[data-board-view]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const view = button.getAttribute("data-board-view") || "list";
      rerenderBoardFlyout(view);
    });
  });

  boardFlyout.querySelectorAll("[data-pick-board]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const id = btn.getAttribute("data-pick-board");
      closeBoardFlyout();
      if (id === state.boardId) return;
      closeCreateFlyout();
      await navigate({
        boardId: id,
        view: "board"
      });
    });
  });
  const form = boardFlyout.querySelector("#createBoardForm");
  if (form) {
    const pickRepoFolderBtn = form.querySelector("#pickRepoFolderBtn");
    const repoPathInput = form.querySelector("#repoPathInput");
    const helperFilesReveal = form.querySelector("#helperFilesReveal");
    // The folder explanation and "Generate AI helper files" option only make
    // sense once a folder is chosen — there's nowhere to write them otherwise.
    // Reveal both with the folder value rather than disabling.
    const syncHelperFilesVisibility = () => {
      if (helperFilesReveal) helperFilesReveal.hidden = !repoPathInput.value.trim();
    };
    syncHelperFilesVisibility();
    pickRepoFolderBtn?.addEventListener("click", async (event) => {
      event.preventDefault();
      pickRepoFolderBtn.disabled = true;
      try {
        const result = await api("/api/system/pick-folder", { method: "POST" });
        if (result.path) {
          repoPathInput.value = result.path;
          repoPathInput.dispatchEvent(new Event("input", { bubbles: true }));
          syncHelperFilesVisibility();
        }
      } catch (error) {
        toast.error(error?.message || "Folder picker unavailable");
      } finally {
        pickRepoFolderBtn.disabled = false;
      }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const fd = new FormData(form);
      const slug = String(fd.get("slug") || "").trim();
      const repoPath = String(fd.get("repo_path") || "").trim();
      // Folder is optional. Only forward the helper-files choice when a folder
      // is set; the server ignores it otherwise.
      const created = await api("/api/boards", {
        method: "POST",
        body: {
          name: fd.get("name"),
          ...(repoPath ? { repo_path: repoPath, manage_helper_files: fd.get("manage_helper_files") === "on" } : {}),
          ...(slug ? { slug } : {})
        }
      });
      closeBoardFlyout();
      state.boardId = created.id;
      state.selectedTicketId = "";
      state.detailMode = "settings";
      await load();
      syncUrlFromState();
      toast.success("Board created");
    });
  }

  boardFlyout.querySelector("#exportAllBoards")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const includeAttachments = Boolean(boardFlyout.querySelector("#exportAllBoardImages")?.checked);
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "Exporting...";
    try {
      await exportAllBoards({ includeAttachments });
    } catch (error) {
      toast.error(`Export failed: ${error?.message || "request failed"}`);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });

  const importAllBoardsFile = boardFlyout.querySelector("#importAllBoardsFile");
  boardFlyout.querySelector("#importAllBoards")?.addEventListener("click", () => {
    importAllBoardsFile?.click();
  });

  importAllBoardsFile?.addEventListener("change", async (event) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const importButton = boardFlyout.querySelector("#importAllBoards");
    const originalText = importButton?.textContent;
    if (importButton) {
      importButton.disabled = true;
      importButton.textContent = "Importing...";
    }
    try {
      const snapshots = await readImportSnapshots(file);
      const boardsById = new Map((state.data.boards || []).map((board) => [board.id, board]));
      const boardsBySlug = new Map((state.data.boards || []).map((board) => [board.slug, board]));
      let replaced = 0;
      let created = 0;

      for (const snapshot of snapshots) {
        const incomingBoard = snapshot.board || {};
        const match = boardsBySlug.get(incomingBoard.slug) || boardsById.get(incomingBoard.id);
        if (match) {
          await api("/api/admin/import", {
            method: "POST",
            body: {
              board_id: match.id,
              replace_existing: true,
              snapshot
            }
          });
          replaced += 1;
          continue;
        }

        const result = await api("/api/admin/import", {
          method: "POST",
          body: {
            ...(state.boardId ? { board_id: state.boardId } : {}),
            create_new: true,
            snapshot
          }
        });
        created += 1;
        if (result.imported_board_id) boardsById.set(result.imported_board_id, { id: result.imported_board_id, slug: result.imported_board_slug });
        if (result.imported_board_slug) boardsBySlug.set(result.imported_board_slug, { id: result.imported_board_id, slug: result.imported_board_slug });
      }

      await load();
      toast.success(`Imported ${snapshots.length} board${snapshots.length === 1 ? "" : "s"} (${replaced} replaced, ${created} created)`);
      closeBoardFlyout();
      await navigate({ boardId: state.boardId, view: "board" }, { replace: true });
    } catch (error) {
      toast.error(`Import failed: ${error?.message || "invalid import file"}`);
    } finally {
      input.value = "";
      if (importButton) {
        importButton.disabled = false;
        importButton.textContent = originalText;
      }
    }
  });
}

export function openBoardFlyout() {
  closeCreateFlyout();
  if (boardFlyoutView === "new" && !features.multiBoard) boardFlyoutView = "list";
  boardFlyout.innerHTML = renderBoardFlyoutInner();
  boardFlyout.hidden = false;
  boardMenuBtn?.setAttribute("aria-expanded", "true");
  wireBoardFlyout();
}
