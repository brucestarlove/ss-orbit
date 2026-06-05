import { api, withBoardQuery } from "./api.js";
import { escapeHtml, renderMarkdown } from "./format.js";
import { toast } from "./toast.js";

const backdrop = document.getElementById("artifactDrawerBackdrop");
const drawer = document.getElementById("artifactDrawer");
const titleEl = document.getElementById("artifactDrawerTitle");
const metaEl = document.getElementById("artifactDrawerMeta");
const bodyEl = document.getElementById("artifactDrawerBody");
const closeBtn = document.getElementById("artifactDrawerCloseBtn");

function setOpen(open) {
  if (!drawer || !backdrop) return;
  drawer.hidden = false;
  backdrop.hidden = false;
  requestAnimationFrame(() => {
    drawer.classList.toggle("is-open", open);
    backdrop.classList.toggle("is-visible", open);
  });
  if (!open) {
    setTimeout(() => {
      if (drawer.classList.contains("is-open")) return;
      drawer.hidden = true;
      backdrop.hidden = true;
      if (bodyEl) bodyEl.innerHTML = "";
    }, 260);
  }
}

export function closeArtifactDrawer() {
  setOpen(false);
}

function localPathHint(path, error) {
  const code = error?.payload?.error || error?.message || "Unable to load artifact";
  const parts = [escapeHtml(code)];
  if (code === "artifact_path_outside_allowed_roots" || code === "artifact_not_found") {
    parts.push("<br><br>The Orbit server could not read that artifact path. If this webapp is hosted on another machine, the file needs to be stored on the hosted Orbit server or linked as a server-readable/repo-relative path.");
  }
  const mntDrive = String(path || "").match(/^\/mnt\/([a-z])\/(.+)$/i);
  const slashDrive = String(path || "").match(/^\/([a-z])\/Users\/(.+)$/i);
  if (mntDrive) {
    const drive = mntDrive[1].toUpperCase();
    parts.push(`<br><br>Windows spelling for this WSL path: <code>${escapeHtml(`${drive}:\\${mntDrive[2].replace(/\//g, "\\")}`)}</code>`);
  } else if (slashDrive) {
    const drive = slashDrive[1].toUpperCase();
    parts.push(`<br><br>Windows spelling for this path: <code>${escapeHtml(`${drive}:\\Users\\${slashDrive[2].replace(/\//g, "\\")}`)}</code>`);
  }
  return parts.join("");
}

export async function openArtifactDrawer({ ticketId, path, title = "Linked artifact" }) {
  if (!ticketId || !path) return false;
  if (!drawer || !bodyEl || !titleEl || !metaEl) return false;
  titleEl.textContent = title;
  metaEl.textContent = path;
  bodyEl.innerHTML = `<p class="artifact-drawer-loading">Loading artifact…</p>`;
  setOpen(true);

  try {
    const result = await api(
      withBoardQuery(`/api/tickets/${encodeURIComponent(ticketId)}/artifacts/markdown?path=${encodeURIComponent(path)}`),
    );
    titleEl.textContent = title;
    metaEl.textContent = result.path || path;
    bodyEl.innerHTML = `<article class="markdown-body artifact-markdown-body">${renderMarkdown(result.content || "") || `<p>${escapeHtml("Empty artifact.")}</p>`}</article>`;
    return true;
  } catch (err) {
    bodyEl.innerHTML = `<p class="artifact-drawer-error">${localPathHint(path, err)}</p>`;
    toast.error("Artifact could not be opened");
    return false;
  }
}

closeBtn?.addEventListener("click", closeArtifactDrawer);
backdrop?.addEventListener("click", closeArtifactDrawer);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && drawer && !drawer.hidden) closeArtifactDrawer();
});
