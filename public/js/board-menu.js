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

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(bytes, value) {
  bytes.push(value & 0xff, (value >>> 8) & 0xff);
}

function writeUint32(bytes, value) {
  bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function zipDateTime(date = new Date()) {
  return {
    time:
      ((date.getHours() & 0x1f) << 11) |
      ((date.getMinutes() & 0x3f) << 5) |
      (Math.floor(date.getSeconds() / 2) & 0x1f),
    date:
      (((date.getFullYear() - 1980) & 0x7f) << 9) |
      (((date.getMonth() + 1) & 0xf) << 5) |
      (date.getDate() & 0x1f)
  };
}

function createZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const timestamp = zipDateTime();

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = encoder.encode(file.content);
    const checksum = crc32(dataBytes);
    const localHeader = [];
    writeUint32(localHeader, 0x04034b50);
    writeUint16(localHeader, 20);
    writeUint16(localHeader, 0x0800);
    writeUint16(localHeader, 0);
    writeUint16(localHeader, timestamp.time);
    writeUint16(localHeader, timestamp.date);
    writeUint32(localHeader, checksum);
    writeUint32(localHeader, dataBytes.length);
    writeUint32(localHeader, dataBytes.length);
    writeUint16(localHeader, nameBytes.length);
    writeUint16(localHeader, 0);
    localParts.push(new Uint8Array(localHeader), nameBytes, dataBytes);

    const centralHeader = [];
    writeUint32(centralHeader, 0x02014b50);
    writeUint16(centralHeader, 20);
    writeUint16(centralHeader, 20);
    writeUint16(centralHeader, 0x0800);
    writeUint16(centralHeader, 0);
    writeUint16(centralHeader, timestamp.time);
    writeUint16(centralHeader, timestamp.date);
    writeUint32(centralHeader, checksum);
    writeUint32(centralHeader, dataBytes.length);
    writeUint32(centralHeader, dataBytes.length);
    writeUint16(centralHeader, nameBytes.length);
    writeUint16(centralHeader, 0);
    writeUint16(centralHeader, 0);
    writeUint16(centralHeader, 0);
    writeUint16(centralHeader, 0);
    writeUint32(centralHeader, 0);
    writeUint32(centralHeader, offset);
    centralParts.push(new Uint8Array(centralHeader), nameBytes);

    offset += localHeader.length + nameBytes.length + dataBytes.length;
  });

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endHeader = [];
  writeUint32(endHeader, 0x06054b50);
  writeUint16(endHeader, 0);
  writeUint16(endHeader, 0);
  writeUint16(endHeader, files.length);
  writeUint16(endHeader, files.length);
  writeUint32(endHeader, centralSize);
  writeUint32(endHeader, centralOffset);
  writeUint16(endHeader, 0);

  return new Blob([...localParts, ...centralParts, new Uint8Array(endHeader)], { type: "application/zip" });
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function safeExportName(board, usedNames) {
  const base = String(board?.slug || board?.name || board?.id || "board")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "board";
  let name = `${base}.orbit.json`;
  let suffix = 2;
  while (usedNames.has(name)) {
    name = `${base}-${suffix}.orbit.json`;
    suffix += 1;
  }
  usedNames.add(name);
  return name;
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
    const boards = state.data.boards || [];
    if (!boards.length) {
      toast.error("No boards to export");
      return;
    }
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "Exporting...";
    try {
      const includeAttachments = Boolean(boardFlyout.querySelector("#exportAllBoardImages")?.checked);
      const suffix = includeAttachments ? "?include_attachments=true" : "";
      const usedNames = new Set();
      const files = [];
      for (const board of boards) {
        const snapshot = await api(`/api/boards/${encodeURIComponent(board.id)}/export${suffix}`);
        files.push({
          name: safeExportName(board, usedNames),
          content: JSON.stringify(snapshot, null, 2)
        });
      }
      const archive = createZip(files);
      const date = new Date().toISOString().slice(0, 10);
      downloadBlob(`orbit-boards-${date}${includeAttachments ? ".with-images" : ""}.zip`, archive);
      toast.success(`Exported ${files.length} board${files.length === 1 ? "" : "s"}`);
    } catch (error) {
      toast.error(`Export failed: ${error?.message || "request failed"}`);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
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
