import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { folderPickerCommands, pickFolder } from "../src/core/system-picker.js";
import { readJson } from "../src/core/http.js";
import { normalizePath } from "../src/core/util.js";
import { renderMarkdown, cleanText, renderPreservedText } from "../public/js/format.js";
import { buildRoute, hasRoute, isCanonicalRouteUrl, parseRoute } from "../public/js/url-routes.js";

const repoRoot = resolve(import.meta.dirname, "..");
const orbitCli = join(repoRoot, "src", "cli", "orbit.js");

test("JSON request reader accepts payloads above the legacy 1 MiB cap", async () => {
  const largeText = "x".repeat(2 * 1024 * 1024);
  async function* chunks() {
    yield Buffer.from(JSON.stringify({ largeText }), "utf8");
  }

  const body = await readJson(chunks());

  assert.equal(body.largeText.length, largeText.length);
});


test("ticket description markdown renders common formatting safely", () => {
  const html = renderMarkdown(
    'First **bold** and *em* with `code`.\nSecond line\n\n- one\n- [link](https://example.com?a=1&b=2)\n\n1. first\n2. second\n\n```js\nconst x = "<tag>";\n```'
  );

  assert.match(html, /<p>First <strong>bold<\/strong> and <em>em<\/em> with <code>code<\/code>\.<br>Second line<\/p>/);
  assert.match(html, /<ul><li>one<\/li><li><a href="https:\/\/example\.com\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">link<\/a><\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<pre><code>const x = &quot;&lt;tag&gt;&quot;;<\/code><\/pre>/);
});

test("ticket markdown preserves pasted terminal indentation", () => {
  const html = renderMarkdown("agent output\n  file: C:\\Users\\operator\n\tstatus: ok");
  const stylesSource = readFileSync(join(repoRoot, "public", "styles.css"), "utf8");

  assert.equal(html, "<p>agent output<br>  file: C:\\Users\\operator<br>\tstatus: ok</p>");
  assert.match(stylesSource, /\.markdown-body\s*\{[\s\S]*tab-size:\s*4;/);
  assert.match(stylesSource, /\.markdown-body p\s*\{[\s\S]*white-space:\s*break-spaces;/);
});

test("preserved text rendering keeps detail description source literal", () => {
  const html = renderPreservedText("1. Keep numbering\n  GET /api/stream\n\tstatus: <ok>");

  assert.equal(html, "1. Keep numbering\n  GET /api/stream\n\tstatus: &lt;ok&gt;");
  assert.doesNotMatch(html, /<ol>/);
  assert.doesNotMatch(html, /<script/i);
});

test("cleanText repairs common CP-437 mojibake and normalizes CRLF", () => {
  // Curly quotes that survived as proper Unicode get flattened to straight ASCII.
  assert.equal(cleanText("It’s “great”"), 'It\'s "great"');
  // Classic Windows-tmux CP-437 mojibake sequences.
  assert.equal(cleanText("a ΓÇô b ΓÇö c"), "a – b — c");
  assert.equal(cleanText("ΓÇ£hi ThereΓÇ¥"), '"hi There"');
  // The Γû╝ (down arrow) sequence we added — required so the ASCII pipeline
  // diagrams users paste in survive round-tripping.
  assert.equal(cleanText("step 1 Γû╝ step 2"), "step 1 ▼ step 2");
  // CRLF / lone CR both fold to LF; multiple newlines preserved.
  assert.equal(cleanText("a\r\nb\rc\n\nd"), "a\nb\nc\n\nd");
  // Null / empty input stays empty without throwing.
  assert.equal(cleanText(""), "");
  assert.equal(cleanText(null), "");
});

test("renderMarkdown supports headers, blockquotes, hr, and GFM task lists", () => {
  const html = renderMarkdown(
    "# Top heading\n## Sub heading\n\n> quoted line\n> spans two\n\n---\n\n- [ ] todo item\n- [x] done item"
  );

  assert.match(html, /<h1>Top heading<\/h1>/);
  assert.match(html, /<h2>Sub heading<\/h2>/);
  assert.match(html, /<blockquote><p>quoted line<br>spans two<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<ul class="task-list">/);
  assert.match(html, /<li class="task-item"><input type="checkbox" disabled> todo item<\/li>/);
  assert.match(html, /<li class="task-item task-item-done"><input type="checkbox" disabled checked> done item<\/li>/);
});

test("renderMarkdown calls cleanText so mojibake-laden source still renders correctly", () => {
  const html = renderMarkdown("ΓÇ£hi ThereΓÇ¥\r\n\r\n- one\r\n- two");
  // The mojibake double-quote becomes a straight quote, which escapeHtml then
  // emits as &quot; inside the HTML output.
  assert.match(html, /<p>&quot;hi There&quot;<\/p>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
});

test("comments, AI fields, and board Notes use preserved read-only text with cleanup on save", () => {
  const detailSource = readFileSync(join(repoRoot, "public", "js", "ticket-detail.js"), "utf8");
  const settingsSource = readFileSync(join(repoRoot, "public", "js", "settings.js"), "utf8");
  const stylesSource = readFileSync(join(repoRoot, "public", "styles.css"), "utf8");

  // Comments use the same literal read-only renderer as the detail description,
  // so pasted plans/logs keep numbering, indentation, and blank lines.
  assert.match(detailSource, /comment-body preserved-text-body">\$\{renderPreservedText\(comment\.body\)\}/);
  assert.doesNotMatch(detailSource, /comment-body markdown-body/);
  assert.doesNotMatch(detailSource, /renderMarkdown\(comment\.body\)/);
  // New comments are cleanText'd on submit.
  assert.match(detailSource, /cleanText\(new FormData\(event\.currentTarget\)\.get\("body"\)\)/);

  // AI Plan / Implementation Record uses three click-to-edit preserved-text
  // fields instead of markdown-rendered read-only bodies or a shared form.
  assert.match(detailSource, /renderInlinePreservedTextField\(\{\s*fieldName:\s*"ai_plan"/);
  assert.match(detailSource, /renderInlinePreservedTextField\(\{\s*fieldName:\s*"implementation_summary"/);
  assert.match(detailSource, /renderInlinePreservedTextField\(\{\s*fieldName:\s*"implementation_updates"/);
  assert.match(detailSource, /const inner = hasValue \? renderPreservedText\(text\) : escapeHtml\(placeholder \|\| ""\)/);
  assert.match(detailSource, /class="inline-md-field-body preserved-text-body editable-field/);
  assert.match(detailSource, /data-edit-field="\$\{escapeHtml\(fieldName\)\}"/);
  assert.doesNotMatch(detailSource, /id="aiFieldsForm"/);
  // Saves go through patchTicket with cleanText applied.
  assert.match(detailSource, /patchTicket\(ticketId,\s*\{\s*\[key\]:\s*cleanText\(next\)\s*\}\)/);

  // Board Notes uses click-to-edit on preserved text, matching ticket detail.
  assert.match(settingsSource, /data-edit-field="project_notes"/);
  assert.match(settingsSource, /renderPreservedText\(notes\)/);
  assert.match(settingsSource, /class="inline-md-field-body preserved-text-body editable-field settings-notes-body/);
  assert.doesNotMatch(settingsSource, /renderMarkdown\(notes\)/);
  assert.doesNotMatch(settingsSource, /id="notesSettingsForm"/);
  assert.match(settingsSource, /project_notes:\s*cleanText\(next\)/);

  // Agent Instructions uses the same click-to-edit preserved text interface as Notes.
  assert.match(settingsSource, /data-edit-field="agent_instructions"/);
  assert.match(settingsSource, /renderPreservedText\(instructions\)/);
  assert.match(settingsSource, /class="inline-md-field-body preserved-text-body editable-field settings-agent-instructions-body/);
  assert.doesNotMatch(settingsSource, /id="agentInstructionsForm"/);
  assert.match(settingsSource, /agent_instructions:\s*cleanText\(next\)/);

  assert.match(stylesSource, /\.preserved-text-body\s*\{[\s\S]*white-space:\s*break-spaces;/);
  assert.match(stylesSource, /\.preserved-text-body\s*\{[\s\S]*tab-size:\s*4;/);
});

test("ticket description markdown escapes HTML and rejects unsafe link URLs", () => {
  const html = renderMarkdown(
    '<script>alert(1)</script> [bad](javascript:alert(1)) [ok](/tickets/1) <img src=x onerror=alert(1)>'
  );

  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /bad\)/);
  assert.match(html, /<a href="\/tickets\/1" target="_blank" rel="noopener noreferrer">ok<\/a>/);
});

test("ticket descriptions use markdown on cards and preserved text in the detail pane", () => {
  const formatSource = readFileSync(join(repoRoot, "public", "js", "format.js"), "utf8");
  const kanbanSource = readFileSync(join(repoRoot, "public", "js", "kanban.js"), "utf8");
  const detailSource = readFileSync(join(repoRoot, "public", "js", "ticket-detail.js"), "utf8");
  const stylesSource = readFileSync(join(repoRoot, "public", "styles.css"), "utf8");

  assert.match(formatSource, /export function renderMarkdown/);
  assert.match(formatSource, /export function renderPreservedText/);
  assert.match(kanbanSource, /renderMarkdown\(ticket\.description\)/);
  assert.match(kanbanSource, /card-description markdown-body/);
  assert.match(detailSource, /renderPreservedText\(ticket\.description\)/);
  assert.match(detailSource, /preserved-text-body editable-field/);
  assert.doesNotMatch(detailSource, /description markdown-body editable-field/);
  assert.doesNotMatch(detailSource, /renderMarkdown\(ticket\.description\)/);
  assert.match(stylesSource, /\.detail-head > \.preserved-text-body\s*\{[\s\S]*white-space:\s*break-spaces;/);
  assert.match(stylesSource, /\.detail-head > \.preserved-text-body\s*\{[\s\S]*font-family:\s*ui-monospace/);
  assert.doesNotMatch(detailSource, /escapeHtml\(ticket\.description \|\| "No description yet\."\)/);
});

test("ticket detail fetches comments from the dedicated endpoint", () => {
  const detailSource = readFileSync(join(repoRoot, "public", "js", "ticket-detail.js"), "utf8");

  assert.match(detailSource, /\/api\/tickets\/\$\{requestedTicketId\}\/comments/);
  assert.match(detailSource, /api\(withBoardQuery\(`\/api\/tickets\/\$\{requestedTicketId\}\/comments`\)\)\.then\(\(result\) => result\.comments \|\| \[\]\)/);
  assert.match(detailSource, /comments\.map\(renderComment\)/);
  assert.doesNotMatch(detailSource, /context\.comments\.map\(renderComment\)/);
});

test("ticket search renders state badges with shared state pill classes", () => {
  const searchSource = readFileSync(join(repoRoot, "public", "js", "search.js"), "utf8");
  const formatSource = readFileSync(join(repoRoot, "public", "js", "format.js"), "utf8");
  const stylesSource = readFileSync(join(repoRoot, "public", "styles.css"), "utf8");

  assert.match(formatSource, /export function stateClassFor/);
  assert.match(searchSource, /stateClassFor\(ticket\)/);
  assert.match(searchSource, /search-hit-state state-pill-/);
  assert.match(searchSource, /search-hit-title/);
  assert.match(stylesSource, /\.search-hit\s*\{[\s\S]*display:\s*flex;/);
  assert.match(stylesSource, /\.search-hit-title\s*\{[\s\S]*text-overflow:\s*ellipsis;/);
  assert.match(stylesSource, /\.search-hit-state\.state-pill-in-progress/);
  assert.match(stylesSource, /\[data-theme="dark"\] \.search-hit-state\.state-pill-in-progress/);
});

test("ticket detail preview cards render state badges with shared state pill classes", () => {
  const detailSource = readFileSync(join(repoRoot, "public", "js", "ticket-detail.js"), "utf8");
  const stylesSource = readFileSync(join(repoRoot, "public", "styles.css"), "utf8");

  assert.match(detailSource, /stateClassFor\(ticket\)/);
  assert.match(detailSource, /detail-card-state state-pill-/);
  assert.match(detailSource, /ticket\.state_name \|\| "State"/);
  assert.match(stylesSource, /\.detail-card-state\s*\{/);
  assert.match(stylesSource, /\.detail-card-state\.state-pill-in-progress/);
  assert.match(stylesSource, /\[data-theme="dark"\] \.detail-card-state\.state-pill-in-progress/);
});

test("ticket detail moves state, type, and priority controls into header badge dropdowns", () => {
  const detailSource = readFileSync(join(repoRoot, "public", "js", "ticket-detail.js"), "utf8");
  const stylesSource = readFileSync(join(repoRoot, "public", "styles.css"), "utf8");

  assert.match(detailSource, /detail-meta-badge-row/);
  assert.match(detailSource, /class=\"detail-meta-badge detail-state-badge/);
  assert.match(detailSource, /data-meta-field=\"state_id\"/);
  assert.match(detailSource, /class=\"detail-meta-badge detail-type-badge/);
  assert.match(detailSource, /data-meta-field=\"type\"/);
  assert.match(detailSource, /class=\"detail-meta-badge detail-priority-badge/);
  assert.match(detailSource, /data-meta-field=\"priority\"/);
  assert.doesNotMatch(detailSource, /<dt>State<\/dt>/);
  assert.doesNotMatch(detailSource, /<dt>Type<\/dt>/);
  assert.doesNotMatch(detailSource, /<dt>Priority<\/dt>/);
  assert.match(detailSource, /drawer\.querySelectorAll\("\.meta-select\[data-meta-field\]"\)/);
  assert.match(stylesSource, /\.detail-meta-badge/);
  assert.match(stylesSource, /\.detail-state-badge/);
  assert.match(stylesSource, /\.detail-priority-badge\.priority-pill-med\s*\{[\s\S]*background-color:\s*rgba\(var\(--amber-rgb\), 0\.16\);/);
  assert.match(stylesSource, /\[data-theme="dark"\] \.detail-priority-badge\.priority-pill-high\s*\{[\s\S]*background-color:\s*rgba\(var\(--coral-rgb\), 0\.2\);/);
});

test("ticket detail ignores stale async renders after rapid ticket switches", () => {
  const detailSource = readFileSync(join(repoRoot, "public", "js", "ticket-detail.js"), "utf8");

  assert.match(detailSource, /const requestedTicketId = state\.selectedTicketId;/);
  assert.match(detailSource, /\/api\/tickets\/\$\{requestedTicketId\}\/context\?depth=1/);
  assert.match(detailSource, /if \(state\.detailMode !== "ticket" \|\| state\.selectedTicketId !== requestedTicketId\) return;/);
  assert.match(detailSource, /if \(context\.ticket\?\.id !== requestedTicketId\) return;/);
});

test("drawer title block is rebuilt wholesale each render so inline-edit click handlers do not stack across ticket switches", () => {
  const drawerSource = readFileSync(join(repoRoot, "public", "js", "drawer.js"), "utf8");
  const indexSource = readFileSync(join(repoRoot, "public", "index.html"), "utf8");

  // Orbit #88: when #drawerEyebrow / #drawerTitle / #drawerSubtitle were
  // persistent shell elements, wireTicketDetailEditors stacked a new editTitle
  // click handler on the <h2> for every ticket the user opened. The first-
  // rendered handler won on click and seeded the inline editor with the
  // previously-selected ticket's title. Treat the title block like
  // drawerInner: replace its innerHTML each render so old listeners die with
  // the old nodes.
  assert.match(indexSource, /id="drawerTitleBlock"/);
  assert.doesNotMatch(indexSource, /id="drawerTitle"/);
  assert.doesNotMatch(indexSource, /id="drawerEyebrow"/);
  assert.doesNotMatch(indexSource, /id="drawerSubtitle"/);
  assert.match(drawerSource, /titleBlockEl\.innerHTML\s*=\s*segments\.join\(""\);/);
  assert.match(drawerSource, /<h2\$\{titleAttrHtml\}>/);
});

test("ticket edit refreshes never retarget the drawer after the user switches cards", () => {
  const detailSource = readFileSync(join(repoRoot, "public", "js", "ticket-detail.js"), "utf8");
  const refreshBody = detailSource.match(/async function refreshTicketDetail[\s\S]*?\n}\n\n\/\*\*/)?.[0] || "";

  assert.ok(refreshBody, "refreshTicketDetail helper should exist");
  assert.doesNotMatch(refreshBody, /state\.selectedTicketId\s*=\s*ticketId;/);
  assert.match(refreshBody, /\/api\/tickets\/\$\{ticketId\}\/context\?depth=1/);
  assert.match(refreshBody, /if \(state\.detailMode !== "ticket" \|\| state\.selectedTicketId !== ticketId\) return;/);
  assert.match(refreshBody, /if \(context\.ticket\?\.id !== ticketId\) return;/);
});

test("ticket title editor is explicit, keyboard friendly, and exits edit mode on outside clicks", () => {
  const detailSource = readFileSync(join(repoRoot, "public", "js", "ticket-detail.js"), "utf8");
  const settingsSource = readFileSync(join(repoRoot, "public", "js", "settings.js"), "utf8");
  const drawerSource = readFileSync(join(repoRoot, "public", "js", "drawer.js"), "utf8");
  const localBackendSource = readFileSync(join(repoRoot, "public", "js", "local-backend.js"), "utf8");
  const stylesSource = readFileSync(join(repoRoot, "public", "styles.css"), "utf8");
  const mcpServerSource = readFileSync(join(repoRoot, "src", "mcp-server.js"), "utf8");

  assert.match(detailSource, /"data-edit-field": "title"/);
  assert.match(detailSource, /role: "button"/);
  assert.match(detailSource, /"aria-label": "Edit ticket title"/);
  assert.match(detailSource, /event\.key === "Escape"/);
  assert.match(detailSource, /event\.key === "Enter"/);
  assert.match(detailSource, /editor\.value\.trim\(\)/);
  assert.match(detailSource, /handleOutsidePointerDown/);
  assert.match(detailSource, /editor\.blur\(\)/);
  assert.match(settingsSource, /title: project\.name/);
  assert.doesNotMatch(settingsSource, /data-edit-field="title"/);
  assert.match(drawerSource, /titleAttrs\?\.class/);
  const previewBoardPatchAllowed = localBackendSource.match(/async function handleBoardPatch[\s\S]*?const ALLOWED = \[([\s\S]*?)\];/);
  assert.ok(previewBoardPatchAllowed);
  assert.match(previewBoardPatchAllowed[1], /"name"/);
  assert.match(settingsSource, /id="boardRenameForm"/);
  assert.match(settingsSource, /Canonical slug unchanged/);
  assert.match(stylesSource, /--field-padding-y:\s*0\.62rem;/);
  assert.match(stylesSource, /--field-padding-x:\s*0\.8rem;/);
  assert.match(stylesSource, /input:not\(\[type\]\)[\s\S]*input\[type="text"\][\s\S]*select,[\s\S]*textarea\s*\{[\s\S]*padding:\s*var\(--field-padding-y\) var\(--field-padding-x\);/);
  assert.match(stylesSource, /\.inline-title-editor\s*\{[\s\S]*padding:\s*var\(--field-padding-y\) var\(--field-padding-x\);/);
  assert.match(stylesSource, /\.inline-desc-editor\s*\{[\s\S]*padding:\s*var\(--field-padding-y\) var\(--field-padding-x\);/);
  assert.match(stylesSource, /\.lane-row input,[\s\S]*\.lane-create-form select\s*\{[\s\S]*padding:\s*var\(--field-padding-y\) var\(--field-padding-x\);/);
  assert.match(stylesSource, /\.topbar-search input\s*\{[\s\S]*padding:\s*var\(--field-padding-y\) var\(--field-padding-x\);/);
  assert.match(stylesSource, /\.drawer-composer input,[\s\S]*\.composer textarea\s*\{[\s\S]*padding:\s*var\(--field-padding-y\) var\(--field-padding-x\);/);
  assert.match(stylesSource, /\.meta-inline\s*\{[\s\S]*padding:\s*var\(--field-padding-y\) var\(--field-padding-x\);/);
  assert.match(stylesSource, /\.label-add-input\s*\{[\s\S]*padding:\s*var\(--field-padding-y\) var\(--field-padding-x\);/);
  assert.match(stylesSource, /\.comment-form textarea\s*\{[\s\S]*padding:\s*var\(--field-padding-y\) var\(--field-padding-x\);/);
  assert.match(stylesSource, /\.field-form textarea\s*\{[\s\S]*padding:\s*var\(--field-padding-y\) var\(--field-padding-x\);/);
  assert.match(stylesSource, /\.mcp-path-grid input\s*\{[\s\S]*padding:\s*var\(--field-padding-y\) var\(--field-padding-x\);/);
  assert.match(stylesSource, /\.related-add-input\s*\{[\s\S]*padding:\s*var\(--field-padding-y\) var\(--field-padding-x\);/);
  assert.match(stylesSource, /--select-chevron-pad-x:\s*var\(--field-padding-x\);/);
  const settingsToolSchema = mcpServerSource.match(/name: "board_update_settings"[\s\S]*?inputSchema: \{([\s\S]*?)\n    handler:/);
  assert.ok(settingsToolSchema);
  assert.match(settingsToolSchema[1], /name: \{ type: "string" \}/);
});

test("ticket detail exposes dependency-free image attachment controls", () => {
  const detailSource = readFileSync(join(repoRoot, "public", "js", "ticket-detail.js"), "utf8");
  const configSource = readFileSync(join(repoRoot, "public", "js", "config.js"), "utf8");
  const stylesSource = readFileSync(join(repoRoot, "public", "styles.css"), "utf8");

  assert.match(configSource, /attachments: edition === "full"/);
  assert.match(detailSource, /renderAttachmentSection/);
  assert.match(detailSource, /data-attachment-dropzone/);
  assert.match(detailSource, /accept=\"image\/\*\" multiple/);
  assert.match(detailSource, /event\.dataTransfer\?\.files/);
  assert.match(detailSource, /clipboardData\?\.files/);
  assert.match(detailSource, /openAttachmentLightbox/);
  assert.match(detailSource, /event\.key === "Escape"/);
  assert.match(stylesSource, /\.attachment-lightbox/);
  assert.match(stylesSource, /\.attachment-dropzone/);
});

test("board snapshot export exposes optional image inclusion", () => {
  const settingsSource = readFileSync(join(repoRoot, "public", "js", "settings.js"), "utf8");
  const mcpClientSource = readFileSync(join(repoRoot, "src", "mcp", "orbit-client.js"), "utf8");
  const mcpServerSource = readFileSync(join(repoRoot, "src", "mcp-server.js"), "utf8");

  assert.match(settingsSource, /id="exportProjectImages"/);
  assert.match(settingsSource, /Include attached images/);
  assert.match(settingsSource, /include_attachments=true/);
  assert.match(settingsSource, /\.with-images\.orbit\.json/);
  assert.match(mcpClientSource, /include_attachments: args\.include_attachments \|\| args\.include_images \? "true" : undefined/);
  assert.match(mcpClientSource, /includeAttachments: Boolean\(args\.include_attachments \|\| args\.include_images\)/);
  const exportToolSchema = mcpServerSource.match(/name: "board_export_board"[\s\S]*?inputSchema: \{([\s\S]*?)\n    handler:/);
  assert.ok(exportToolSchema);
  assert.match(exportToolSchema[1], /include_attachments: \{ type: "boolean"/);
  assert.match(exportToolSchema[1], /include_images: \{ type: "boolean"/);
});

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), "orbit-regression-test-"));
  const projectRoot = join(root, "project");
  const dataDir = join(root, "data");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ name: "regression-project" }), "utf8");
  return { root, projectRoot, dataDir };
}

function runOrbit(args, harness) {
  const result = spawnSync(process.execPath, [orbitCli, ...args], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: harness.dataDir },
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`orbit ${args.join(" ")} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result.stdout;
}

/** Look up the board's db_path via the central registry. */
function boardDbPath(harness) {
  const reg = new DatabaseSync(join(harness.dataDir, "registry.db"));
  const row = reg.prepare("SELECT db_path FROM boards ORDER BY created_at LIMIT 1").get();
  reg.close();
  if (!row) throw new Error("No board found in registry");
  return row.db_path;
}

function freePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.on("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => (port ? resolvePromise(port) : rejectPromise(new Error("no port assigned"))));
    });
  });
}

function waitForOutput(child, pattern, timeoutMs = 3000) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = "";
    const timer = setTimeout(() => rejectPromise(new Error(`timed out waiting for ${pattern}; got ${buffer}`)), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      if (pattern.test(buffer)) {
        clearTimeout(timer);
        resolvePromise(buffer);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      rejectPromise(new Error(`server exited before ready: code=${code} signal=${signal}\n${buffer}`));
    });
  });
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// A backup file's name can appear before its bytes are fully flushed, so
// matching on the filename alone races the copy (intermittent "no such
// table: tickets" / "file is not a database"). Poll until the newest
// matching backup opens as a complete SQLite DB that actually contains the
// expected row, swallowing transient errors while the copy is in flight.
// Resolves the instant a valid backup is found (normally <100ms); the
// generous ceiling only adds patience under concurrent-test CPU contention.
async function waitForBackupRowCount(dir, pattern, sql, param, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (existsSync(dir)) {
      const match = readdirSync(dir)
        .filter((name) => pattern.test(name))
        .sort()
        .pop();
      if (match) {
        let backup = null;
        try {
          backup = new DatabaseSync(join(dir, match));
          const { count } = backup.prepare(sql).get(param);
          if (count > 0) return count;
          lastError = new Error(`backup ${match} found but row not present yet`);
        } catch (error) {
          lastError = error; // copy still in flight — retry
        } finally {
          backup?.close();
        }
      }
    }
    await delay(25);
  }
  throw new Error(
    `timed out waiting for a complete backup matching ${pattern} in ${dir}` +
      (lastError ? ` (last: ${lastError.message})` : "")
  );
}

async function readStreamUntil(reader, predicate, timeoutMs = 1500) {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      reader.read(),
      delay(remaining).then(() => ({ timeout: true }))
    ]);
    if (result.timeout) break;
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    if (predicate(buffer)) return buffer;
  }
  throw new Error(`timed out waiting for SSE chunk; got ${buffer}`);
}

test("orbit serve honors --port before loading server paths", async () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);

  const port = await freePort();
  const child = spawn(process.execPath, [orbitCli, "serve", "--cwd", h.projectRoot, "--port", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForOutput(child, /Starscape Orbit listening/);
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    child.kill("SIGTERM");
  }
});

test("board context exposes metadata needed by settings tabs", async () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);

  const db = new DatabaseSync(boardDbPath(h));
  const board = db.prepare("SELECT id, slug, name, repo_url, system_path, default_branch, project_notes, ai_enabled FROM boards LIMIT 1").get();
  db.close();
  const port = await freePort();
  const child = spawn(process.execPath, [orbitCli, "serve", "--cwd", h.projectRoot, "--port", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForOutput(child, /Starscape Orbit listening/);
    const contextResponse = await fetch(`http://127.0.0.1:${port}/api/boards/${encodeURIComponent(board.id)}/context?include_struck=true`);
    assert.equal(contextResponse.status, 200);
    const context = await contextResponse.json();
    assert.equal(context.board.id, board.id);
    assert.equal(context.board.slug, board.slug);
    assert.equal(context.board.repo_url, board.repo_url);
    assert.equal(context.board.system_path, board.system_path);
    assert.equal(context.board.default_branch, board.default_branch);
    assert.equal(context.board.project_notes, board.project_notes);
    assert.equal(context.board.ai_enabled, board.ai_enabled);

    const archiveResponse = await fetch(`http://127.0.0.1:${port}/api/boards/${encodeURIComponent(context.board.id)}/archive`);
    assert.equal(archiveResponse.status, 200);
  } finally {
    child.kill("SIGTERM");
  }
});

test("board settings PATCH renames display name without changing canonical slug", async () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);

  const db = new DatabaseSync(boardDbPath(h));
  const board = db.prepare("SELECT id, name, slug, project_notes FROM boards LIMIT 1").get();
  db.close();

  const port = await freePort();
  const child = spawn(process.execPath, [orbitCli, "serve", "--cwd", h.projectRoot, "--port", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForOutput(child, /Starscape Orbit listening/);
    const blankResponse = await fetch(`http://127.0.0.1:${port}/api/boards/${encodeURIComponent(board.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " })
    });
    assert.equal(blankResponse.status, 400);

    const patchResponse = await fetch(`http://127.0.0.1:${port}/api/boards/${encodeURIComponent(board.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed Orbit", project_notes: "notes still save" })
    });
    assert.equal(patchResponse.status, 200);
    const patched = await patchResponse.json();
    assert.equal(patched.name, "Renamed Orbit");
    assert.equal(patched.slug, board.slug);
    assert.equal(patched.project_notes, "notes still save");

    const contextResponse = await fetch(`http://127.0.0.1:${port}/api/boards/${encodeURIComponent(board.id)}/context`);
    assert.equal(contextResponse.status, 200);
    const context = await contextResponse.json();
    assert.equal(context.board.name, "Renamed Orbit");
    assert.equal(context.board.slug, board.slug);
    assert.equal(context.board.project_notes, "notes still save");

    const bootstrapResponse = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await bootstrapResponse.json();
    const bootstrapBoard = bootstrap.boards.find((item) => item.id === board.id);
    assert.equal(bootstrapBoard?.name, "Renamed Orbit");
    assert.equal(bootstrapBoard?.slug, board.slug);
  } finally {
    child.kill("SIGTERM");
  }
});

test("ticket read endpoint returns the lightweight agent ticket shape", async () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);

  const db = new DatabaseSync(boardDbPath(h));
  const board = db.prepare("SELECT id, slug FROM boards LIMIT 1").get();
  db.close();

  const port = await freePort();
  const child = spawn(process.execPath, [orbitCli, "serve", "--cwd", h.projectRoot, "--port", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForOutput(child, /Starscape Orbit listening/);
    const createdResponse = await fetch(`http://127.0.0.1:${port}/api/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board_id: board.id, title: "Lightweight", description: "Small read" })
    });
    assert.equal(createdResponse.status, 201);
    const ticket = await createdResponse.json();

    const commentResponse = await fetch(`http://127.0.0.1:${port}/api/tickets/${encodeURIComponent(ticket.id)}/comments?board=${encodeURIComponent(board.slug)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "comment-only-thread" })
    });
    assert.equal(commentResponse.status, 201);

    const readResponse = await fetch(`http://127.0.0.1:${port}/api/tickets/${encodeURIComponent(ticket.id)}?board=${encodeURIComponent(board.slug)}`);
    assert.equal(readResponse.status, 200);
    const read = await readResponse.json();

    const entryResponse = await fetch(`http://127.0.0.1:${port}/api/boards/${encodeURIComponent(board.id)}/entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "lesson", title: "Project Context Secret", body: "project-context-only" })
    });
    assert.equal(entryResponse.status, 201);

    const contextResponse = await fetch(`http://127.0.0.1:${port}/api/tickets/${encodeURIComponent(ticket.id)}/context?board=${encodeURIComponent(board.slug)}`);
    assert.equal(contextResponse.status, 200);
    const context = await contextResponse.json();

    const fullContextResponse = await fetch(`http://127.0.0.1:${port}/api/tickets/${encodeURIComponent(ticket.id)}/context/full?board=${encodeURIComponent(board.slug)}`);
    assert.equal(fullContextResponse.status, 200);
    const fullContext = await fullContextResponse.json();

    const projectContextResponse = await fetch(`http://127.0.0.1:${port}/api/boards/${encodeURIComponent(board.id)}/context?include_struck=true`);
    assert.equal(projectContextResponse.status, 200);
    const projectContext = await projectContextResponse.json();

    assert.deepEqual(Object.keys(read).sort(), ["board_manual", "ticket"]);
    assert.equal(read.ticket.id, ticket.id);
    assert.equal(read.ticket.title, "Lightweight");
    assert.equal(Object.hasOwn(read.ticket, "implementation_summary"), false);
    assert.equal(Object.hasOwn(read.ticket, "implementation_updates"), false);
    assert.equal(Object.hasOwn(read, "relations"), false);
    assert.equal(Object.hasOwn(read, "blockers"), false);
    assert.equal(Object.hasOwn(read, "child_tickets"), false);
    assert.equal(Object.hasOwn(read, "comments"), false);
    assert.equal(JSON.stringify(read).includes("comment-only-thread"), false);

    assert.equal(context.ticket.id, ticket.id);
    assert.equal(Object.hasOwn(context, "board_manual"), false);
    assert.deepEqual(Object.keys(context.board).sort(), ["default_branch", "id", "name", "repo_path", "slug", "system_path"]);
    assert.equal(Object.hasOwn(context.board, "agent_instructions"), false);
    assert.equal(Object.hasOwn(context.board, "project_notes"), false);
    assert.equal(Object.hasOwn(context, "comments"), false);
    assert.equal(JSON.stringify(context).includes("comment-only-thread"), false);
    assert.equal(JSON.stringify(context).includes("project-context-only"), false);

    assert.equal(fullContext.ticket.id, ticket.id);
    assert.equal(fullContext.board_manual.board.id, board.id);
    assert.equal(fullContext.board_manual.entries.some((entry) => entry.body === "project-context-only"), true);
    assert.equal(Object.hasOwn(fullContext, "comments"), false);
    assert.equal(JSON.stringify(fullContext).includes("comment-only-thread"), false);

    assert.equal(projectContext.board.id, board.id);
    assert.equal(projectContext.entries.some((entry) => entry.body === "project-context-only"), true);
  } finally {
    child.kill("SIGTERM");
  }
});

test("ticket lookup endpoint resolves number and title exactly with the lightweight shape", async () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);

  const db = new DatabaseSync(boardDbPath(h));
  const board = db.prepare("SELECT id, slug FROM boards LIMIT 1").get();
  db.close();

  const port = await freePort();
  const child = spawn(process.execPath, [orbitCli, "serve", "--cwd", h.projectRoot, "--port", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForOutput(child, /Starscape Orbit listening/);
    const targetResponse = await fetch(`http://127.0.0.1:${port}/api/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board_id: board.id, title: "Exact Lookup Ticket", description: "Target" })
    });
    assert.equal(targetResponse.status, 201);
    const target = await targetResponse.json();

    const distractorResponse = await fetch(`http://127.0.0.1:${port}/api/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board_id: board.id, title: "Different Ticket", description: "Not the target" })
    });
    assert.equal(distractorResponse.status, 201);
    const distractor = await distractorResponse.json();

    const targetCommentResponse = await fetch(`http://127.0.0.1:${port}/api/tickets/${encodeURIComponent(target.id)}/comments?board=${encodeURIComponent(board.slug)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "target-comment-secret" })
    });
    assert.equal(targetCommentResponse.status, 201);

    const distractorCommentResponse = await fetch(`http://127.0.0.1:${port}/api/tickets/${encodeURIComponent(distractor.id)}/comments?board=${encodeURIComponent(board.slug)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Exact Lookup Ticket" })
    });
    assert.equal(distractorCommentResponse.status, 201);

    const secondBoardResponse = await fetch(`http://127.0.0.1:${port}/api/boards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Lookup Second Board", slug: "lookup-second-board", repo_path: join(h.root, "lookup-second") })
    });
    assert.equal(secondBoardResponse.status, 201);
    const secondBoard = await secondBoardResponse.json();
    const secondTicketResponse = await fetch(`http://127.0.0.1:${port}/api/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board_id: secondBoard.id, title: "Second Board Number One" })
    });
    assert.equal(secondTicketResponse.status, 201);
    const secondTicket = await secondTicketResponse.json();
    assert.equal(secondTicket.number, target.number, "fixture proves board-scoped same-number lookup");

    const secondBoardNumberResponse = await fetch(`http://127.0.0.1:${port}/api/tickets/lookup?board=${encodeURIComponent(secondBoard.slug)}&number=${secondTicket.number}`);
    assert.equal(secondBoardNumberResponse.status, 200);
    const secondBoardNumber = await secondBoardNumberResponse.json();
    assert.equal(secondBoardNumber.ticket.id, secondTicket.id);

    const byNumberResponse = await fetch(`http://127.0.0.1:${port}/api/tickets/lookup?board=${encodeURIComponent(board.slug)}&number=${target.number}`);
    assert.equal(byNumberResponse.status, 200);
    const byNumber = await byNumberResponse.json();

    const byTitleResponse = await fetch(`http://127.0.0.1:${port}/api/tickets/lookup?board=${encodeURIComponent(board.slug)}&title=${encodeURIComponent("Exact Lookup Ticket")}`);
    assert.equal(byTitleResponse.status, 200);
    const byTitle = await byTitleResponse.json();

    for (const read of [byNumber, byTitle]) {
      assert.deepEqual(Object.keys(read).sort(), ["board_manual", "ticket"]);
      assert.equal(read.ticket.id, target.id);
      assert.equal(read.ticket.title, "Exact Lookup Ticket");
      assert.equal(Object.hasOwn(read.ticket, "implementation_summary"), false);
      assert.equal(Object.hasOwn(read, "relations"), false);
      assert.equal(Object.hasOwn(read, "comments"), false);
      assert.equal(JSON.stringify(read).includes("target-comment-secret"), false);
    }
  } finally {
    child.kill("SIGTERM");
  }
});

test("bootstrap exposes the selected default board separately from alphabetic board list order", async () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);

  const port = await freePort();
  const child = spawn(process.execPath, [orbitCli, "serve", "--cwd", h.projectRoot, "--port", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForOutput(child, /Starscape Orbit listening/);
    const createdResponse = await fetch(`http://127.0.0.1:${port}/api/boards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Zzz Later Board", repo_path: h.projectRoot })
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();

    // Registry timestamps can legitimately collide when a board is created
    // immediately after startup. The selected board should still be the most
    // recently inserted/activated row, not the alphabetically first board.
    const reg = new DatabaseSync(join(h.dataDir, "registry.db"));
    const tieTimestamp = "2026-01-01T00:00:00.000Z";
    reg.prepare("UPDATE boards SET last_active_at = ?, created_at = ?, updated_at = ?").run(tieTimestamp, tieTimestamp, tieTimestamp);
    reg.close();

    const bootstrapResponse = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await bootstrapResponse.json();

    assert.equal(bootstrap.active_board_id, created.id);
    assert.notEqual(bootstrap.boards[0].id, created.id, "registry list remains alphabetic, not active-first");
    assert.deepEqual([...new Set(bootstrap.states.map((state) => state.board_id))], [created.id]);
    assert.deepEqual([...new Set(bootstrap.tickets.map((ticket) => ticket.board_id))], []);
  } finally {
    child.kill("SIGTERM");
  }
});

test("bootstrap can select the initial board by slug", async () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);
  const secondProject = join(h.root, "second-project");
  mkdirSync(secondProject, { recursive: true });

  const port = await freePort();
  const child = spawn(process.execPath, [orbitCli, "serve", "--cwd", h.projectRoot, "--port", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForOutput(child, /Starscape Orbit listening/);
    const createdResponse = await fetch(`http://127.0.0.1:${port}/api/boards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Board", slug: "second-board", repo_path: secondProject })
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();

    const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap?board=${encodeURIComponent(created.slug)}`);
    assert.equal(response.status, 200);
    const bootstrap = await response.json();
    assert.ok(bootstrap.states.length > 0);
    assert.ok(bootstrap.states.every((row) => row.board_id === created.id));
  } finally {
    child.kill("SIGTERM");
  }
});

test("board delete removes registry row and local board database after slug confirmation", async () => {
  const h = makeHarness();
  runOrbit(["init", "--example", "--cwd", h.projectRoot], h);

  // With central storage, the db lives in DATA_DIR/boards/<slug>/; find it via registry.
  const dbPath = boardDbPath(h);
  const boardDir = dirname(dbPath);
  const skillPath = join(h.projectRoot, "SKILL-ORBIT.md");
  const agentsPath = join(h.projectRoot, "AGENTS.md");
  const db = new DatabaseSync(dbPath);
  const board = db.prepare("SELECT id, slug FROM boards LIMIT 1").get();
  db.close();

  const port = await freePort();
  const child = spawn(process.execPath, [orbitCli, "serve", "--cwd", h.projectRoot, "--port", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForOutput(child, /Starscape Orbit listening/);

    const rejected = await fetch(`http://127.0.0.1:${port}/api/boards/${encodeURIComponent(board.id)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm_slug: "wrong-slug", delete_files: true })
    });
    assert.equal(rejected.status, 400);
    assert.equal(existsSync(dbPath), true);

    const deleted = await fetch(`http://127.0.0.1:${port}/api/boards/${encodeURIComponent(board.id)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm_slug: board.slug, delete_files: true })
    });
    assert.equal(deleted.status, 200);
    assert.equal(existsSync(dbPath), false, "central board db should be gone");
    assert.equal(existsSync(boardDir), false, "central board dir should be gone");
    assert.equal(existsSync(join(h.projectRoot, ".orbit")), false);
    assert.equal(existsSync(skillPath), false);
    const agentsContent = readFileSync(agentsPath, "utf8");
    assert.doesNotMatch(agentsContent, /ORBIT:AGENTS-START/);
    assert.doesNotMatch(agentsContent, /SKILL-ORBIT\.md/);

    const backupDir = join(h.dataDir, "backups", "boards", board.id);
    const backupFiles = readdirSync(backupDir).filter((name) => name.endsWith(".board.db"));
    assert.ok(backupFiles.some((name) => name.includes("pre-board-delete")));
    const backup = new DatabaseSync(join(backupDir, backupFiles.find((name) => name.includes("pre-board-delete"))));
    assert.deepEqual(backup.prepare("SELECT id, slug FROM boards LIMIT 1").get(), board);
    backup.close();

    const boardsResponse = await fetch(`http://127.0.0.1:${port}/api/boards`);
    assert.equal(boardsResponse.status, 200);
    assert.deepEqual((await boardsResponse.json()).boards, []);
  } finally {
    child.kill("SIGTERM");
  }
});

test("board delete reports busy Windows board files with a retryable conflict", () => {
  const source = readFileSync(join(repoRoot, "src", "core", "delete-board.js"), "utf8");

  assert.match(source, /board_files_busy/);
  assert.match(source, /maxRetries\s*=\s*10/);
  assert.match(source, /retry the delete from Settings/);
});

test("snapshot import after delete and re-init restores into the new board id", async () => {
  const h = makeHarness();
  runOrbit(["init", "--example", "--cwd", h.projectRoot], h);

  // Find the original board db via registry (central storage).
  const originalDbPath = boardDbPath(h);
  const originalDb = new DatabaseSync(originalDbPath);
  const originalBoard = originalDb.prepare("SELECT id, slug FROM boards LIMIT 1").get();
  originalDb.close();

  const port = await freePort();
  const child = spawn(process.execPath, [orbitCli, "serve", "--cwd", h.projectRoot, "--port", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForOutput(child, /Starscape Orbit listening/);

    const snapshotResponse = await fetch(`http://127.0.0.1:${port}/api/boards/${encodeURIComponent(originalBoard.id)}/export`);
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();

    const deleted = await fetch(`http://127.0.0.1:${port}/api/boards/${encodeURIComponent(originalBoard.id)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm_slug: originalBoard.slug, delete_files: true })
    });
    assert.equal(deleted.status, 200);

    runOrbit(["init", "--cwd", h.projectRoot], h);
    // Find the replacement board via registry (a new board was created).
    const replacementDbPath = boardDbPath(h);
    const replacementDb = new DatabaseSync(replacementDbPath);
    const replacementBoard = replacementDb.prepare("SELECT id, slug FROM boards LIMIT 1").get();
    replacementDb.close();
    assert.notEqual(replacementBoard.id, originalBoard.id);

    const imported = await fetch(`http://127.0.0.1:${port}/api/admin/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board_id: replacementBoard.id, replace_existing: true, snapshot })
    });
    assert.equal(imported.status, 201);
    assert.equal((await imported.json()).imported_board_id, replacementBoard.id);

    const restoredDb = new DatabaseSync(replacementDbPath);
    assert.equal(restoredDb.prepare("SELECT id FROM boards LIMIT 1").get().id, replacementBoard.id);
    assert.deepEqual(restoredDb.prepare("SELECT number FROM tickets ORDER BY number").all().map((row) => row.number), [1, 2, 3, 12]);
    restoredDb.close();
  } finally {
    child.kill("SIGTERM");
  }
});

test("ticket image attachments upload, export, missing-file listing, and import", async () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);

  const db = new DatabaseSync(boardDbPath(h));
  const board = db.prepare("SELECT id, slug FROM boards LIMIT 1").get();
  db.close();

  const port = await freePort();
  const child = spawn(process.execPath, [orbitCli, "serve", "--cwd", h.projectRoot, "--port", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForOutput(child, /Starscape Orbit listening/);
    const createdResponse = await fetch(`http://127.0.0.1:${port}/api/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board_id: board.id, title: "Attachment ticket" })
    });
    assert.equal(createdResponse.status, 201);
    const ticket = await createdResponse.json();

    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
    const upload = await fetch(`http://127.0.0.1:${port}/api/tickets/${encodeURIComponent(ticket.id)}/attachments?board_id=${encodeURIComponent(board.id)}&filename=${encodeURIComponent("tiny.png")}`, {
      method: "POST",
      headers: { "Content-Type": "image/png", "X-File-Name": "..\\tiny.png" },
      body: png
    });
    assert.equal(upload.status, 201);
    const attachment = await upload.json();
    assert.equal(attachment.original_name, "..\\tiny.png");
    assert.equal(attachment.mime_type, "image/png");
    assert.equal(attachment.size_bytes, png.length);
    assert.equal(attachment.missing, false);
    assert.match(attachment.stored_path, /^tickets\//);
    assert.doesNotMatch(attachment.stored_path, /\.\./);

    const listedResponse = await fetch(`http://127.0.0.1:${port}/api/tickets/${encodeURIComponent(ticket.id)}/attachments?board_id=${encodeURIComponent(board.id)}`);
    assert.equal(listedResponse.status, 200);
    const listed = await listedResponse.json();
    assert.equal(listed.attachments.length, 1);
    assert.equal(listed.attachments[0].missing, false);

    const contentResponse = await fetch(`http://127.0.0.1:${port}${listed.attachments[0].content_url}?board_id=${encodeURIComponent(board.id)}`);
    assert.equal(contentResponse.status, 200);
    assert.equal(contentResponse.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await contentResponse.arrayBuffer()), png);

    const defaultExportResponse = await fetch(`http://127.0.0.1:${port}/api/boards/${encodeURIComponent(board.id)}/export`);
    const defaultExport = await defaultExportResponse.json();
    assert.equal(defaultExport.include_attachments, false);
    assert.equal(defaultExport.attachments[0].included, false);
    assert.equal(defaultExport.attachments[0].data_base64, null);

    const includedExportResponse = await fetch(`http://127.0.0.1:${port}/api/boards/${encodeURIComponent(board.id)}/export?include_attachments=true`);
    const includedExport = await includedExportResponse.json();
    assert.equal(includedExport.include_attachments, true);
    assert.equal(includedExport.attachments[0].included, true);
    assert.equal(includedExport.attachments[0].data_base64, png.toString("base64"));

    const attachmentDb = new DatabaseSync(boardDbPath(h));
    const storedPath = attachmentDb.prepare("SELECT stored_path FROM ticket_attachments WHERE id = ?").get(attachment.id).stored_path;
    attachmentDb.close();
    const absoluteStoredPath = join(dirname(boardDbPath(h)), "attachments", storedPath);
    unlinkSync(absoluteStoredPath);
    const missingResponse = await fetch(`http://127.0.0.1:${port}/api/tickets/${encodeURIComponent(ticket.id)}/attachments?board_id=${encodeURIComponent(board.id)}`);
    const missingList = await missingResponse.json();
    assert.equal(missingList.attachments[0].missing, true);
    assert.equal(missingList.attachments[0].content_url, null);

    const h2 = makeHarness();
    runOrbit(["init", "--cwd", h2.projectRoot], h2);
    const importedDb = new DatabaseSync(boardDbPath(h2));
    const targetBoard = importedDb.prepare("SELECT id FROM boards LIMIT 1").get();
    importedDb.close();
    const importPort = await freePort();
    const importChild = spawn(process.execPath, [orbitCli, "serve", "--cwd", h2.projectRoot, "--port", String(importPort)], {
      cwd: repoRoot,
      env: { ...process.env, DATA_DIR: h2.dataDir },
      stdio: ["ignore", "pipe", "pipe"]
    });
    try {
      await waitForOutput(importChild, /Starscape Orbit listening/);
      const imported = await fetch(`http://127.0.0.1:${importPort}/api/admin/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ board_id: targetBoard.id, replace_existing: true, snapshot: includedExport })
      });
      assert.equal(imported.status, 201);
      const restoredDb = new DatabaseSync(boardDbPath(h2));
      const restored = restoredDb.prepare("SELECT * FROM ticket_attachments WHERE id = ?").get(attachment.id);
      restoredDb.close();
      assert.equal(restored.mime_type, "image/png");
      assert.equal(existsSync(join(dirname(boardDbPath(h2)), "attachments", restored.stored_path)), true);
    } finally {
      importChild.kill("SIGTERM");
    }
  } finally {
    child.kill("SIGTERM");
  }
});

test("successful writes schedule a debounced automatic board backup", async () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);

  const db = new DatabaseSync(boardDbPath(h));
  const board = db.prepare("SELECT id, slug FROM boards LIMIT 1").get();
  db.close();

  const port = await freePort();
  const child = spawn(process.execPath, [orbitCli, "serve", "--cwd", h.projectRoot, "--port", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir, ORBIT_AUTO_BACKUP_DELAY_MS: "25" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForOutput(child, /Starscape Orbit listening/);
    const created = await fetch(`http://127.0.0.1:${port}/api/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board_id: board.id, title: "Back up this write" })
    });
    assert.equal(created.status, 201);

    const backupDir = join(h.dataDir, "backups", "boards", board.id);
    const count = await waitForBackupRowCount(
      backupDir,
      /auto-write.*\.board\.db$/,
      "SELECT COUNT(*) AS count FROM tickets WHERE title = ?",
      "Back up this write"
    );
    assert.equal(count, 1);
  } finally {
    child.kill("SIGTERM");
  }
});

test("SSE replay with Last-Event-ID does not crash the Orbit server", async () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);

  const db = new DatabaseSync(boardDbPath(h));
  const board = db.prepare("SELECT id FROM boards LIMIT 1").get();
  const anchorEventId = "evt-anchor";
  db.prepare(
    "INSERT INTO events (id, ticket_id, actor, type, body_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(anchorEventId, null, "owner", "board_updated", "{}", "2026-01-01T00:00:00.000Z");

  const port = await freePort();
  const child = spawn(process.execPath, [orbitCli, "serve", "--cwd", h.projectRoot, "--port", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForOutput(child, /Starscape Orbit listening/);
    const response = await fetch(`http://127.0.0.1:${port}/api/events/stream?board_id=${encodeURIComponent(board.id)}`, {
      headers: { "Last-Event-ID": anchorEventId }
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const firstChunk = await reader.read();
    assert.match(new TextDecoder().decode(firstChunk.value), /:ok/);
    await reader.cancel();
    await delay(250);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill("SIGTERM");
  }
});

test("SSE streams events written by another Orbit process", async () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);

  const db = new DatabaseSync(boardDbPath(h));
  const board = db.prepare("SELECT id FROM boards LIMIT 1").get();
  const port = await freePort();
  const child = spawn(process.execPath, [orbitCli, "serve", "--cwd", h.projectRoot, "--port", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir, ORBIT_SSE_POLL_MS: "50" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForOutput(child, /Starscape Orbit listening/);
    const response = await fetch(`http://127.0.0.1:${port}/api/events/stream?board_id=${encodeURIComponent(board.id)}`);
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    await readStreamUntil(reader, (chunk) => chunk.includes(":ok"));

    const externalEventId = "evt-external-process";
    db.prepare(
      "INSERT INTO events (id, ticket_id, actor, type, body_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(externalEventId, null, "agent", "board_updated", JSON.stringify({ source: "external" }), new Date().toISOString());

    const chunk = await readStreamUntil(reader, (text) => text.includes(externalEventId), 300);
    assert.match(chunk, /event: board/);
    assert.match(chunk, /"type":"board_updated"/);
    await reader.cancel();
  } finally {
    child.kill("SIGTERM");
  }
});

test("SSE external event polling uses insertion order when timestamps tie", async () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);

  const db = new DatabaseSync(boardDbPath(h));
  const board = db.prepare("SELECT id FROM boards LIMIT 1").get();
  const tiedTimestamp = "2026-01-01T00:00:00.000Z";
  db.prepare(
    "INSERT INTO events (id, ticket_id, actor, type, body_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("z-anchor", null, "agent", "board_updated", "{}", tiedTimestamp);

  const port = await freePort();
  const child = spawn(process.execPath, [orbitCli, "serve", "--cwd", h.projectRoot, "--port", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir, ORBIT_SSE_POLL_MS: "50" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForOutput(child, /Starscape Orbit listening/);
    const response = await fetch(`http://127.0.0.1:${port}/api/events/stream?board_id=${encodeURIComponent(board.id)}`);
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    await readStreamUntil(reader, (chunk) => chunk.includes(":ok"));

    db.prepare(
      "INSERT INTO events (id, ticket_id, actor, type, body_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("a-later", null, "agent", "board_updated", JSON.stringify({ source: "same-ms" }), tiedTimestamp);

    const chunk = await readStreamUntil(reader, (text) => text.includes("a-later"), 300);
    assert.match(chunk, /event: board/);
    await reader.cancel();
  } finally {
    child.kill("SIGTERM");
  }
});

test("SSE external event bridge uses per-board data_version watchers", () => {
  const eventsSource = readFileSync(join(repoRoot, "src", "core", "events.js"), "utf8");

  assert.match(eventsSource, /const\s+boardWatchers\s*=\s*new Map\(\)/);
  assert.match(eventsSource, /ORBIT_SSE_POLL_MS/);
  assert.match(eventsSource, /PRAGMA data_version/);
  assert.match(eventsSource, /function\s+getOrCreateBoardWatcher/);
  assert.match(eventsSource, /function\s+pollBoardWatcher/);
  assert.doesNotMatch(eventsSource, /for \(const client of sseClients\)[\s\S]*eventsAfterCursor\(client\.boardRow, client\.cursor\)/);
});

test("router reloads board switches from the app module that exports load", () => {
  const routerSource = readFileSync(join(repoRoot, "public", "js", "router.js"), "utf8");
  const appSource = readFileSync(join(repoRoot, "public", "js", "app.js"), "utf8");

  assert.match(appSource, /export async function load\(/);
  assert.match(routerSource, /await import\("\.\/app\.js"\)/);
  assert.doesNotMatch(routerSource, /await import\("\.\/main\.js"\)/);
});

test("same-board ticket routes use a detail-only render path", () => {
  const routerSource = readFileSync(join(repoRoot, "public", "js", "router.js"), "utf8");
  const appSource = readFileSync(join(repoRoot, "public", "js", "app.js"), "utf8");
  const kanbanSource = readFileSync(join(repoRoot, "public", "js", "kanban.js"), "utf8");

  assert.match(appSource, /export async function renderDetailOnly\(\)/);
  assert.match(appSource, /renderBoardSelection\(\)/);
  assert.match(kanbanSource, /export function renderBoardSelection\(\)/);
  assert.match(routerSource, /const \{ load, renderDetailOnly \} = await import\("\.\/app\.js"\)/);
  assert.match(routerSource, /if \(state\.boardId && state\.boardId !== prevBoardId\) \{[\s\S]*await load\(\);[\s\S]*return;[\s\S]*\}\n  await renderDetailOnly\(\);/);
  assert.doesNotMatch(routerSource, /await render\(\);/);
});

test("ticket detail mutations avoid full bootstrap reloads", () => {
  const detailSource = readFileSync(join(repoRoot, "public", "js", "ticket-detail.js"), "utf8");
  const stateSource = readFileSync(join(repoRoot, "public", "js", "state.js"), "utf8");

  assert.match(stateSource, /export function upsertTicket\(/);
  assert.match(detailSource, /async function refreshTicketDetail\(/);
  assert.match(detailSource, /\/api\/tickets\/\$\{requestedTicketId\}\/context\?depth=1/);
  assert.match(detailSource, /\/api\/tickets\/\$\{requestedTicketId\}\/comments/);
  assert.match(detailSource, /upsertTicket\(context\.ticket\)/);
  assert.match(detailSource, /comments\.map\(renderComment\)/);
  assert.match(detailSource, /if \(renderBoardAfter\) renderBoard\(\);/);
  assert.doesNotMatch(detailSource, /from "\.\/app\.js"/);
  assert.doesNotMatch(detailSource, /await load\(\);/);
});

test("browser routes build hash URLs with board slugs", () => {
  const boardSlug = "orbit-board";
  const ticketId = "ticket 456";

  assert.equal(buildRoute({ boardSlug }), "#/b/orbit-board");
  assert.equal(
    buildRoute({ boardSlug, view: "ticket", ticketId }),
    "#/b/orbit-board/t/ticket%20456"
  );
  assert.equal(
    buildRoute({ boardSlug, view: "settings", tab: "ai" }),
    "#/b/orbit-board/settings/ai"
  );

  assert.deepEqual(parseRoute({ pathname: "/", hash: "#/b/orbit-board/settings/ai" }), {
    boardSlug,
    view: "settings",
    ticketId: "",
    tab: "ai"
  });
  assert.equal(hasRoute({ pathname: "/", hash: "" }), false);
  assert.equal(hasRoute({ pathname: "/b/board-123", hash: "" }), false);
  assert.equal(hasRoute({ pathname: "/app/", hash: "#/b/orbit-board" }), true);
  assert.equal(isCanonicalRouteUrl({ pathname: "/app/", hash: "#/b/orbit-board" }, { boardSlug }), true);
  assert.equal(isCanonicalRouteUrl({ pathname: "/", hash: "#/b/board-id" }, { boardSlug }), false);
});

test("board picker selection switches boards without opening Settings", () => {
  const boardMenuSource = readFileSync(join(repoRoot, "public", "js", "board-menu.js"), "utf8");
  const pickBoardHandler = boardMenuSource.match(/querySelectorAll\("\[data-pick-board\]"\)[\s\S]*?\n  \}\);/);

  assert.ok(pickBoardHandler, "board picker handler should exist");
  assert.match(pickBoardHandler[0], /await navigate\(\{\s*boardId: id,\s*view: "board"\s*\}\);/);
  assert.doesNotMatch(pickBoardHandler[0], /view: "settings"/);
});

test("board creation uses a system folder picker instead of a typed repo path", () => {
  const boardMenuSource = readFileSync(join(repoRoot, "public", "js", "board-menu.js"), "utf8");
  const stylesSource = readFileSync(join(repoRoot, "public", "styles.css"), "utf8");
  const routerSource = readFileSync(join(repoRoot, "src", "core", "router.js"), "utf8");

  assert.match(boardMenuSource, /name="repo_path"[^>]*readonly/);
  assert.match(boardMenuSource, /id="pickRepoFolderBtn"/);
  assert.match(boardMenuSource, /\/api\/system\/pick-folder/);
  assert.doesNotMatch(boardMenuSource, /placeholder="Repo path on disk"/);
  assert.match(stylesSource, /\.folder-picker-field/);
  assert.match(routerSource, /url\.pathname === "\/api\/system\/pick-folder"/);
});

test("system folder picker normalizes selected paths and reports unsupported platforms", async () => {
  const darwinCommands = folderPickerCommands("darwin", "Pick folder");
  assert.equal(darwinCommands[0].command, "osascript");
  assert.match(darwinCommands[0].args.join(" "), /choose folder/);

  const picked = await pickFolder({
    platform: "darwin",
    execFileImpl: async () => ({ stdout: "/tmp/example/\n" })
  });
  assert.deepEqual(picked, { path: normalizePath("/tmp/example") });

  const unsupported = await pickFolder({
    platform: "linux",
    execFileImpl: async () => {
      const error = new Error("missing command");
      error.code = "ENOENT";
      throw error;
    }
  });
  assert.deepEqual(unsupported, { unsupported: true });
});

test("kanban horizontal wheel gestures stay inside the board scroller", () => {
  const kanbanSource = readFileSync(join(repoRoot, "public", "js", "kanban.js"), "utf8");
  const stylesSource = readFileSync(join(repoRoot, "public", "styles.css"), "utf8");
  const wheelHandler = kanbanSource.match(/kanban\.addEventListener\(\s*"wheel"[\s\S]*?\{ passive: false \}\s*\);/);

  assert.ok(wheelHandler, "kanban should install a non-passive wheel handler");
  assert.match(wheelHandler[0], /event\.preventDefault\(\)/);
  assert.match(wheelHandler[0], /kanban\.scrollLeft \+= wheelPixels\(horizontalDelta, event\.deltaMode\)/);
  assert.match(stylesSource, /\.kanban\s*\{[\s\S]*overscroll-behavior-x:\s*contain;/);
});

test("renderBoard stays cheap: delegated listeners, no per-card rebind or rescan", () => {
  const kanbanSource = readFileSync(join(repoRoot, "public", "js", "kanban.js"), "utf8");
  const renderBoardFn = kanbanSource.match(/export function renderBoard\(\)\s*\{[\s\S]*?\n\}/)?.[0] || "";

  assert.ok(renderBoardFn, "renderBoard should exist");
  // The hot path must not re-attach listeners or linear-scan tickets per card.
  assert.doesNotMatch(renderBoardFn, /addEventListener/);
  assert.doesNotMatch(renderBoardFn, /querySelectorAll/);
  assert.doesNotMatch(renderBoardFn, /tickets\.find\(/);
  // It builds an id->ticket Map so delegated handlers resolve in O(1).
  assert.match(renderBoardFn, /boardTicketsById\s*=\s*new Map\(/);

  // Interaction wiring is attached once to the persistent container.
  assert.match(kanbanSource, /export function enableKanbanInteractions\(\)/);
  assert.match(kanbanSource, /bindCardContextMenuDelegated\(kanban/);
});

test("kanban card markdown is parsed lazily, only for expanded cards", () => {
  const kanbanSource = readFileSync(join(repoRoot, "public", "js", "kanban.js"), "utf8");
  const renderCardFn = kanbanSource.match(/function renderCard\(ticket[\s\S]*?\n\}/)?.[0] || "";

  assert.ok(renderCardFn, "renderCard should exist");
  // Collapsed cards (the common case) must not run the markdown parser.
  assert.doesNotMatch(renderCardFn, /renderMarkdown\(/);
  // The expandable body is emitted only when already expanded...
  assert.match(renderCardFn, /isExpanded \? renderCardExpandable\(ticket\)/);
  // ...and injected on first open via the toggle handler.
  assert.match(kanbanSource, /function toggleCardExpansion[\s\S]*?renderCardExpandable\(ticket\)/);
});

test("card action submenus render as viewport-layered panels", () => {
  const cardActionsSource = readFileSync(join(repoRoot, "public", "js", "card-actions.js"), "utf8");
  const stylesSource = readFileSync(join(repoRoot, "public", "styles.css"), "utf8");
  const menuRule = stylesSource.match(/\.card-action-menu\s*\{[\s\S]*?\n\}/)?.[0] || "";
  const submenuRule = stylesSource.match(/\.card-action-submenu\s*\{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(cardActionsSource, /calculateSubmenuPosition/);
  assert.match(cardActionsSource, /document\.addEventListener\("scroll", dismissOnScroll/);
  assert.ok(menuRule, "card action menu CSS should exist");
  assert.ok(submenuRule, "card action submenu CSS should exist");
  assert.match(menuRule, /overflow:\s*visible;/);
  assert.doesNotMatch(menuRule, /overflow-y:\s*auto;/);
  assert.match(submenuRule, /position:\s*fixed;/);
  assert.match(submenuRule, /overflow-y:\s*auto;/);
});

test("kanban columns use the wide width by default", () => {
  const stateSource = readFileSync(join(repoRoot, "public", "js", "state.js"), "utf8");
  const settingsSource = readFileSync(join(repoRoot, "public", "js", "settings.js"), "utf8");
  const stylesSource = readFileSync(join(repoRoot, "public", "styles.css"), "utf8");

  assert.doesNotMatch(stateSource, /wideKanbanColumns|mab_wide_kanban_columns|applyKanbanColumnWidthPreference/);
  assert.doesNotMatch(settingsSource, /wideKanbanColumnsToggle|mab_wide_kanban_columns|Wide kanban columns/);
  assert.match(stylesSource, /--kanban-column-width:\s*22rem;/);
  assert.match(stylesSource, /@media \(max-width: 720px\)[\s\S]*--kanban-column-width:\s*18rem;/);
  assert.match(stylesSource, /\.kanban\s*\{[\s\S]*grid-auto-columns:\s*minmax\(var\(--kanban-column-width\), 1fr\);/);
});

test("minimized epic headers span the lane while epic children stay indented", () => {
  const stylesSource = readFileSync(join(repoRoot, "public", "styles.css"), "utf8");
  const miniHeaderRule = stylesSource.match(/\.epic-mini-header\s*\{[\s\S]*?\n\}/)?.[0] || "";
  const childrenRule = stylesSource.match(/\.epic-children\s*\{[\s\S]*?\n\}/)?.[0] || "";

  assert.ok(miniHeaderRule, "mini epic header CSS should exist");
  assert.ok(childrenRule, "epic children CSS should exist");
  assert.match(miniHeaderRule, /width:\s*100%;/);
  assert.doesNotMatch(miniHeaderRule, /width:\s*92%;/);
  assert.doesNotMatch(miniHeaderRule, /align-self:\s*flex-end;/);
  assert.match(childrenRule, /width:\s*92%;/);
  assert.match(childrenRule, /align-self:\s*flex-end;/);
});
