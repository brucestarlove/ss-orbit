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

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function sanitizeMarkdownUrl(value) {
  const href = String(value || "").trim();
  if (!href) return "";

  // Collapse control characters/whitespace before checking the scheme so inputs
  // like `java\nscript:` or `jav\tascript:` cannot bypass the blocklist.
  const compact = href.replace(/[\u0000-\u001f\u007f\s]+/g, "").toLowerCase();
  if (/^(?:javascript|data|vbscript):/.test(compact)) return "";

  const scheme = compact.match(/^([a-z][a-z0-9+.-]*):/);
  if (scheme && !SAFE_LINK_PROTOCOLS.has(`${scheme[1]}:`)) return "";

  return href;
}

function renderEmphasis(text) {
  let html = escapeHtml(text);
  html = html.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>");
  html = html.replace(/(\*|_)(?=\S)([^*_]*?\S)\1/g, "<em>$2</em>");
  return html;
}

function renderLinksAndEmphasis(text) {
  const linkPattern = /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let html = "";
  let lastIndex = 0;
  let match;

  while ((match = linkPattern.exec(text))) {
    html += renderEmphasis(text.slice(lastIndex, match.index));

    const labelHtml = renderEmphasis(match[1]);
    const href = sanitizeMarkdownUrl(match[2]);
    html += href
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`
      : labelHtml;

    lastIndex = match.index + match[0].length;
  }

  html += renderEmphasis(text.slice(lastIndex));
  return html;
}

function renderInlineMarkdown(text) {
  const source = String(text ?? "");
  let html = "";
  let cursor = 0;

  while (cursor < source.length) {
    const codeStart = source.indexOf("`", cursor);
    if (codeStart === -1) {
      html += renderLinksAndEmphasis(source.slice(cursor));
      break;
    }

    const codeEnd = source.indexOf("`", codeStart + 1);
    if (codeEnd === -1) {
      html += renderLinksAndEmphasis(source.slice(cursor));
      break;
    }

    html += renderLinksAndEmphasis(source.slice(cursor, codeStart));
    html += `<code>${escapeHtml(source.slice(codeStart + 1, codeEnd))}</code>`;
    cursor = codeEnd + 1;
  }

  return html;
}

function renderParagraph(lines) {
  return `<p>${renderInlineMarkdown(lines.join("\n")).replaceAll("\n", "<br>")}</p>`;
}

export function renderMarkdown(value) {
  const source = String(value ?? "").replace(/\r\n?/g, "\n");
  if (!source.trim()) return "";

  const blocks = [];
  const lines = source.split("\n");
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(renderParagraph(paragraph));
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    blocks.push(`<${list.type}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${list.type}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      flushParagraph();
      flushList();
      const codeLines = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      blocks.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ordered || unordered) {
      flushParagraph();
      const type = ordered ? "ol" : "ul";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push(renderInlineMarkdown((ordered || unordered)[1].trim()).replaceAll("\n", "<br>"));
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();

  return blocks.join("");
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
