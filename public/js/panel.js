// Reusable settings-style "panel" primitives shared by the project settings
// drawer and the ticket detail drawer. A panel is a bordered card with a
// tinted header strip (small-caps title) and a padded body — the same visual
// language used across the Appearance / AI / Data settings tabs. The
// collapsible variant turns the header into a <details>/<summary> toggle with a
// chevron that flips when open, so any surface can drop in a togglable section
// without re-deriving the markup. These intentionally emit the .settings-card
// class family (documented in styles.css as a reusable @starlove/ui primitive).

import { escapeHtml } from "./format.js";

const panelChevronSvg = `<svg class="settings-card-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>`;

/**
 * Static panel: bordered card with a header title and a padded body.
 *
 * Options:
 *   - title: heading text shown in the small-caps header strip.
 *   - body: raw HTML for the card body (already escaped by the caller).
 *   - className: extra classes appended to the .settings-card element.
 *   - attrs: extra attributes string placed on the <section> (e.g. data-*).
 *   - headExtra: raw HTML appended after the title inside the header (actions).
 */
export function renderPanel({ title, body = "", className = "", attrs = "", headExtra = "" } = {}) {
  const classAttr = className ? ` ${className}` : "";
  const extraAttrs = attrs ? ` ${attrs}` : "";
  return `
    <section class="settings-card${classAttr}"${extraAttrs}>
      <header class="settings-card-head">
        <h3 class="settings-card-title">${escapeHtml(title)}</h3>
        ${headExtra}
      </header>
      <div class="settings-card-body">${body}</div>
    </section>
  `;
}

/**
 * Collapsible panel: same chrome as renderPanel but the header doubles as a
 * <details>/<summary> toggle with a flipping chevron.
 *
 * Options mirror renderPanel, plus:
 *   - open: whether the section starts expanded.
 */
export function renderTogglePanel({ title, body = "", open = false, className = "", attrs = "", headExtra = "" } = {}) {
  const classAttr = className ? ` ${className}` : "";
  const extraAttrs = attrs ? ` ${attrs}` : "";
  return `
    <details class="settings-card settings-card--collapsible${classAttr}"${open ? " open" : ""}${extraAttrs}>
      <summary class="settings-card-head">
        <h3 class="settings-card-title">${escapeHtml(title)}</h3>
        ${headExtra}
        ${panelChevronSvg}
      </summary>
      <div class="settings-card-body">${body}</div>
    </details>
  `;
}
