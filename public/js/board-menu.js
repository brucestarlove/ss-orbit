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

export function closeBoardFlyout() {
  if (!boardFlyout) return;
  boardFlyout.hidden = true;
  boardFlyout.innerHTML = "";
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
    <rect x="4" y="4" width="6" height="16" rx="0.75" stroke="currentColor" stroke-width="2" />
    <rect x="14" y="4" width="6" height="16" rx="0.75" stroke="currentColor" stroke-width="2" />
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
  const createBlock = features.multiBoard
    ? `
    <div class="menu-flyout-section">
      <h3 class="menu-flyout-heading">New board</h3>
      <form id="createBoardForm" class="menu-flyout-form">
        <div class="folder-picker-field">
          <input id="repoPathInput" name="repo_path" type="text" required readonly placeholder="Choose a folder" autocomplete="off" />
          <button type="button" id="pickRepoFolderBtn">Browse</button>
        </div>
        <p class="menu-flyout-hint menu-flyout-hint--intro">Board data is stored in <code>.orbit/</code> under this folder.</p>
        <input name="name" type="text" required placeholder="Board name" autocomplete="off" />
        <input name="slug" type="text" placeholder="Slug (optional)" autocomplete="off" />
        <input name="default_branch" type="text" placeholder="Default branch (optional)" autocomplete="off" />
        <input name="repo_url" type="text" placeholder="Repo URL (optional)" autocomplete="off" />
        <button type="submit">Create board</button>
      </form>
    </div>`
    : "";
  return `
    <div class="menu-flyout-head">Board</div>
    <div class="menu-flyout-list">${listBody}</div>
    ${createBlock}
  `;
}

function wireBoardFlyout() {
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
    pickRepoFolderBtn?.addEventListener("click", async (event) => {
      event.preventDefault();
      pickRepoFolderBtn.disabled = true;
      try {
        const result = await api("/api/system/pick-folder", { method: "POST" });
        if (result.path) {
          repoPathInput.value = result.path;
          repoPathInput.dispatchEvent(new Event("input", { bubbles: true }));
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
      const branch = String(fd.get("default_branch") || "").trim();
      const repo = String(fd.get("repo_url") || "").trim();
      const repoPath = String(fd.get("repo_path") || "").trim();
      if (!repoPath) {
        repoPathInput?.reportValidity();
        return;
      }
      const created = await api("/api/boards", {
        method: "POST",
        body: {
          name: fd.get("name"),
          repo_path: repoPath,
          ...(slug ? { slug } : {}),
          ...(branch ? { default_branch: branch } : {}),
          ...(repo ? { repo_url: repo } : {})
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
}

export function openBoardFlyout() {
  closeCreateFlyout();
  boardFlyout.innerHTML = renderBoardFlyoutInner();
  boardFlyout.hidden = false;
  boardMenuBtn?.setAttribute("aria-expanded", "true");
  wireBoardFlyout();
}
