// Client-side update awareness. On boot we ask the server (GET /api/version)
// whether a newer Orbit exists; if so we light a dot on the Settings button and
// show a one-time toast. The Settings → Data "Version & Updates" card
// reuses fetchVersionInfo/getUpdateInfo/syncUpdateBadge for "Check now".
//
// Only the server-backed "full" edition has /api/version; the preview edition
// (IndexedDB, no server) and any fetch failure are swallowed silently — same
// best-effort posture as help-menu.js's version pill.

import { toast } from "./toast.js";
import { navigate } from "./router.js";
import { state } from "./state.js";
import { edition } from "./config.js";

const TOAST_SEEN_KEY = "orbit:updateToastSeen";

let cachedInfo = null;

/** Last /api/version payload (or null if not checked / unavailable). */
export function getUpdateInfo() {
  return cachedInfo;
}

/** Fetch version info. `force` adds ?refresh=1 so the server re-hits GitHub. */
export async function fetchVersionInfo({ force = false } = {}) {
  try {
    const res = await fetch(`./api/version${force ? "?refresh=1" : ""}`, { cache: "no-store" });
    if (!res.ok) return null;
    cachedInfo = await res.json();
    return cachedInfo;
  } catch {
    return null;
  }
}

/** Toggle the Settings-button dot to match the latest known state. */
export function syncUpdateBadge() {
  const show = Boolean(cachedInfo?.updateAvailable);
  const btn = document.getElementById("settingsBtn");
  if (!btn) return;
  btn.classList.toggle("has-update", show);
  const dot = btn.querySelector(".topbar-update-dot");
  if (dot) dot.hidden = !show;
}

/** Run once on boot: check, badge, and toast (deduped per detected version). */
export async function checkForUpdate() {
  if (edition !== "full") return;
  const info = await fetchVersionInfo();
  syncUpdateBadge();
  if (!info?.updateAvailable || !info.latest) return;

  if (localStorage.getItem(TOAST_SEEN_KEY) === info.latest) return;
  localStorage.setItem(TOAST_SEEN_KEY, info.latest);
  toast(`Orbit v${info.latest} is available →`, "info", 8000, {
    onClick: () => navigate({ boardId: state.boardId, view: "settings", tab: "data" })
  });
}
