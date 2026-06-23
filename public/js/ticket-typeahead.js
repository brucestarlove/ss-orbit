// Shared ticket typeahead: the styled suggestion dropdown used wherever a
// ticket is picked by typing (ticket-detail's Related / parent-epic / add-child
// fields and the New-card flyout's parent-epic field). Rows mirror the topbar
// search results — bold #number, title, type badge, state badge — and selecting
// a row fills the input with the canonical "#12 — Title" label so the host
// form's resolve-on-submit logic keeps working unchanged.

import { escapeHtml, ticketLabel, stateClassFor, typeLabel, canonicalTicketType } from "./format.js";
import { attachTypeahead } from "./typeahead.js";

// Canonical "#12 — Title" label the resolve-on-submit logic expects.
export function ticketCanonicalLabel(t) {
  return `#${t.number} — ${t.title}`;
}

// A typeahead row for a ticket: bold #number, title, then trailing type and
// state badges — the same shape as the topbar search results.
export function renderTicketHitRow(t) {
  const type = canonicalTicketType(t.type);
  return `
    <span class="search-hit-main">
      <strong>${escapeHtml(ticketLabel(t))}</strong>
      <span class="search-hit-title">${escapeHtml(t.title)}</span>
    </span>
    <span class="search-hit-type type-pill-${escapeHtml(type)}">${escapeHtml(typeLabel(t.type))}</span>
    <span class="search-hit-state" data-variant="${escapeHtml(stateClassFor(t))}">${escapeHtml(t.state_name || "State")}</span>
  `;
}

// Matches a ticket against a query by number ("12", "#12") or title substring.
export function ticketMatchesQuery(t, query) {
  const q = query.replace(/^#/, "");
  return String(t.number).startsWith(q) || t.title.toLowerCase().includes(query);
}

// Wire the styled typeahead onto a ticket-picker input. `getCandidates` returns
// the eligible tickets; `onSelect` (optional) fires after the value is filled,
// e.g. to record the chosen ticket's id in a hidden field.
export function attachTicketTypeahead(input, getCandidates, { onSelect } = {}) {
  if (!input) return;
  attachTypeahead(input, {
    getItems: getCandidates,
    match: ticketMatchesQuery,
    renderItem: renderTicketHitRow,
    valueOf: ticketCanonicalLabel,
    onSelect,
    emptyText: "No matching tickets",
  });
}
