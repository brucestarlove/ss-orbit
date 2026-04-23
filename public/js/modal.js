// Generic <dialog> modal utility.
//
// Usage:
//   wireModal(el)         — wire backdrop-click + [data-modal-close] buttons.
//   openModal(el)         — show the dialog as a modal (focus-trapped overlay).
//   closeModal(el)        — close it programmatically.
//
// Escape key is handled natively by the browser; no extra wiring needed.

export function openModal(dialogEl) {
  dialogEl?.showModal();
}

export function closeModal(dialogEl) {
  if (dialogEl?.open) dialogEl.close();
}

export function wireModal(dialogEl) {
  if (!dialogEl) return;

  // Close when the user clicks the backdrop (the dialog element itself,
  // outside its inner content box).
  dialogEl.addEventListener("click", (event) => {
    if (event.target === dialogEl) closeModal(dialogEl);
  });

  // Close buttons: any element inside the dialog with [data-modal-close].
  dialogEl.querySelectorAll("[data-modal-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(dialogEl));
  });
}
