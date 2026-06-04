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
    bodyEl.innerHTML = `<p class="artifact-drawer-error">${escapeHtml(err.payload?.error || err.message || "Unable to load artifact")}</p>`;
    toast.error("Artifact could not be opened");
    return false;
  }
}

closeBtn?.addEventListener("click", closeArtifactDrawer);
backdrop?.addEventListener("click", closeArtifactDrawer);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && drawer && !drawer.hidden) closeArtifactDrawer();
});
