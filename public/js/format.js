// Pure string helpers: escape, dates, ticket/type/priority labels.
// Zero side effects, no imports — safe to import from anywhere.

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

/** Richer timestamp for the detail pane “Updated” line (refreshes after every save). */
export function formatDateDetail(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

export function ticketLabel(ticket) {
  return `#${ticket.number}`;
}

export function canonicalTicketType(type) {
  if (type === "epic" || type === "feature" || type === "bug" || type === "task") return type;
  return "task";
}

// Short label for dense surfaces (card pills, child-card pills).
export function typeLabel(type) {
  const labels = {
    epic: "Epic",
    feature: "Feature",
    task: "Task",
    bug: "Bug"
  };
  return labels[canonicalTicketType(type)] || "Task";
}

// Long, hierarchy-aware label for dropdowns where we have the room. Epic/Story
// pairs older vocabulary so existing terminology still resonates.
export function typeLabelLong(type) {
  const labels = {
    epic: "Epic / Story",
    feature: "Feature",
    task: "Task",
    bug: "Bug"
  };
  return labels[canonicalTicketType(type)] || "Task";
}

export function priorityLabel(priority) {
  const labels = {
    0: "MAYBE",
    1: "LOW",
    2: "MED",
    3: "HIGH",
    4: "URGENT"
  };
  return labels[Number(priority)] || "MED";
}

/** Lowercase key used for CSS class targeting: `priority-maybe`, `priority-urgent`, etc. */
export function priorityKeyFor(priority) {
  const keys = ["maybe", "low", "med", "high", "urgent"];
  const n = Number(priority);
  return keys[Number.isFinite(n) ? Math.max(0, Math.min(4, n)) : 2];
}

export function renderLabels(labels = []) {
  if (!labels.length) return "";
  return `
    <div class="labels">
      ${labels
        .map(
          (label) =>
            `<span class="label" style="--label-color: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>`
        )
        .join("")}
    </div>
  `;
}

export function repoLabelFromUrl(repoUrl) {
  const raw = String(repoUrl || "").trim();
  if (!raw) return "Not set";
  const githubHttps = raw.match(/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (githubHttps) return `${githubHttps[1]}/${githubHttps[2]}`;
  const githubSsh = raw.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (githubSsh) return `${githubSsh[1]}/${githubSsh[2]}`;
  return raw;
}
