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

// UTF-8 bytes mis-decoded as CP-437 (the typical Windows-tmux artifact).
// Ported from a local fix-newlines utility — every entry is [mojibake sequence,
// what it should have been]. Long sequences first so shorter prefixes do not
// eat them.
const MOJIBAKE_REPLACEMENTS = [
  // General Punctuation (UTF-8 E2 80 XX → CP-437 "ΓÇ" + glyph)
  ["ΓÇô", "–"],
  ["ΓÇö", "—"],
  ["ΓÇ£", '"'],
  ["ΓÇ¥", '"'],
  ["ΓÇÿ", "'"],
  ["ΓÇÖ", "'"],
  ["ΓÇª", "…"],
  ["ΓÇó", "•"],
  ["ΓÇ░", "‰"],
  ["ΓÇ╣", "‹"],
  ["ΓÇ║", "›"],

  // Box drawing — light (UTF-8 E2 94 XX → CP-437 "Γö" + glyph)
  ["ΓöÇ", "─"],
  ["Γöé", "│"],
  ["Γöî", "┌"],
  ["ΓöÉ", "┐"],
  ["Γöö", "└"],
  ["Γöÿ", "┘"],
  ["Γö£", "├"],
  ["Γöñ", "┤"],
  ["Γö¼", "┬"],
  ["Γö┤", "┴"],
  ["Γö╝", "┼"],

  // Box drawing — heavy/double + rounded corners (UTF-8 E2 95 XX → "Γò" + glyph)
  ["ΓòÉ", "═"],
  ["Γòæ", "║"],
  ["ΓòÆ", "╒"],
  ["Γòö", "╔"],
  ["Γò¡", "╭"],
  ["Γò«", "╮"],
  ["Γò»", "╯"],
  ["Γò░", "╰"],

  // Geometric shapes (UTF-8 E2 96 XX / E2 97 XX → "Γû" / "Γù" + glyph)
  ["Γûæ", "░"],
  ["ΓûÆ", "▒"],
  ["Γûô", "▓"],
  ["ΓûÉ", "▐"],
  ["Γûî", "▌"],
  ["ΓûÄ", ">"],
  ["Γûá", "■"],
  ["Γû╝", "▼"],
  ["ΓùÅ", "●"],
  ["Γùï", "○"],

  // Misc symbols (UTF-8 E2 9A XX → "ΓÜ" + glyph)
  ["ΓÜò", "⚕"],
  ["ΓÜá", "⚠"],
  ["ΓÜí", "⚡"],
  ["ΓÜô", "⚓"],

  // Arrows (UTF-8 E2 86 XX → "Γå" + glyph)
  ["ΓåÉ", "←"],
  ["Γåæ", "↑"],
  ["ΓåÆ", "→"],
  ["Γåô", "↓"],
  ["Γåö", "↔"],

  // Latin-1 Supplement (UTF-8 C2 XX → CP-437 "┬" + glyph)
  ["┬á", " "],
  ["┬⌐", "©"],
  ["┬«", "®"],
  ["┬░", "°"],
  ["┬º", "§"],
  ["┬╖", "·"],

  // Stray curly quotes that survived as proper Unicode; normalize to ASCII
  // straight quotes so pasted terminal/log text stays consistent.
  ["“", '"'],
  ["”", '"'],
  ["‘", "'"],
  ["’", "'"],
];

function fixMojibake(text) {
  if (!text) return text;
  let out = text;
  for (const [from, to] of MOJIBAKE_REPLACEMENTS) {
    out = out.split(from).join(to);
  }
  return out;
}

/**
 * Repair common mojibake and normalize line endings without disturbing the
 * author's indentation or soft line breaks. Use this on inbound text before
 * saving (so the DB stays clean going forward) and again before rendering (so
 * existing dirty rows display fixed without a migration).
 */
export function cleanText(value) {
  if (!value) return "";
  return fixMojibake(String(value)).replace(/\r\n?/g, "\n");
}

export function renderPreservedText(value) {
  return escapeHtml(cleanText(value));
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

function renderTaskItem(rawContent) {
  // GFM-style `- [ ] text` or `- [x] text`. We render as a disabled checkbox
  // followed by the inline-rendered remainder. The list itself gets a
  // `task-list` class so CSS can drop the default bullet.
  const match = rawContent.match(/^\[( |x|X)\]\s+(.*)$/);
  if (!match) return null;
  const checked = match[1].toLowerCase() === "x";
  const body = renderInlineMarkdown(match[2].trim()).replaceAll("\n", "<br>");
  return {
    checked,
    html: `<input type="checkbox" disabled${checked ? " checked" : ""}> ${body}`,
  };
}

export function renderMarkdown(value) {
  // Mojibake repair runs at render time too so existing dirty rows display
  // cleanly without a backfill. cleanText also normalizes line endings.
  const source = cleanText(value);
  if (!source.trim()) return "";

  const blocks = [];
  const lines = source.split("\n");
  let paragraph = [];
  let list = null;
  let blockquote = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(renderParagraph(paragraph));
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    const classAttr = list.taskList ? ' class="task-list"' : "";
    blocks.push(
      `<${list.type}${classAttr}>${list.items
        .map((item) => `<li${item.taskClass ? ` class="${item.taskClass}"` : ""}>${item.html}</li>`)
        .join("")}</${list.type}>`
    );
    list = null;
  };

  const flushBlockquote = () => {
    if (!blockquote) return;
    blocks.push(`<blockquote>${renderMarkdown(blockquote.join("\n"))}</blockquote>`);
    blockquote = null;
  };

  const flushAll = () => {
    flushParagraph();
    flushList();
    flushBlockquote();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      flushAll();
      const codeLines = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      blocks.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    // Horizontal rule: a line of three+ dashes / asterisks / underscores.
    if (/^\s*(?:-\s*){3,}\s*$/.test(line) || /^\s*(?:\*\s*){3,}\s*$/.test(line) || /^\s*(?:_\s*){3,}\s*$/.test(line)) {
      flushAll();
      blocks.push("<hr>");
      continue;
    }

    // ATX header: 1-6 # followed by a space and content.
    const header = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (header) {
      flushAll();
      const level = header[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(header[2])}</h${level}>`);
      continue;
    }

    // Blockquote: `> ...`. We collect consecutive `>` lines, strip the leading
    // marker, and recurse so quoted content can itself contain lists/headers.
    const quoteMatch = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      if (!blockquote) blockquote = [];
      blockquote.push(quoteMatch[1]);
      continue;
    }
    if (blockquote && !line.trim()) {
      flushBlockquote();
      continue;
    }
    flushBlockquote();

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
      const content = (ordered || unordered)[1].trim();

      let task = null;
      if (unordered) task = renderTaskItem(content);

      if (!list || list.type !== type || Boolean(list.taskList) !== Boolean(task)) {
        flushList();
        list = { type, items: [], taskList: Boolean(task) };
      }

      if (task) {
        list.items.push({
          html: task.html,
          taskClass: task.checked ? "task-item task-item-done" : "task-item",
        });
      } else {
        list.items.push({
          html: renderInlineMarkdown(content).replaceAll("\n", "<br>"),
        });
      }
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushAll();

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

export function stateClassFor(ticketOrState) {
  const source =
    ticketOrState?.state_role || ticketOrState?.role || ticketOrState?.state_name || ticketOrState?.name || "state";
  return String(source)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "state";
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
