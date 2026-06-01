// Help & About dialog. The topbar "Help" button opens a centered
// .orbit-dialog (same shell as the welcome dialog) describing what Orbit is,
// how to get started, and where the docs live. modal.js owns the
// Escape/backdrop/close-button behavior; this module only wires the open
// trigger and best-effort fills the version pill from the build's version.json.

import { openModal, wireModal } from "./modal.js";

async function fillVersion(pill) {
  if (!pill) return;
  try {
    const res = await fetch("./version.json", { cache: "no-store" });
    if (!res.ok) return;
    const info = await res.json();
    if (info?.version) pill.textContent = `v${info.version}`;
  } catch {
    // Dev edition serves raw modules without version.json — leave the
    // static "Orbit" label in place.
  }
}

export function wireHelpMenu() {
  const dialog = document.getElementById("helpDialog");
  const helpBtn = document.getElementById("helpBtn");
  if (!dialog || !helpBtn) return;

  wireModal(dialog);
  fillVersion(document.getElementById("helpDialogVersion"));

  helpBtn.addEventListener("click", () => openModal(dialog));
}
