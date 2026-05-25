import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { folderPickerCommands, pickFolder } from "../src/core/system-picker.js";
import { normalizePath } from "../src/core/util.js";
import { renderMarkdown } from "../public/js/format.js";
import { buildRoute, hasRoute, isCanonicalRouteUrl, parseRoute } from "../public/js/url-routes.js";

const repoRoot = resolve(import.meta.dirname, "..");
const orbitCli = join(repoRoot, "src", "cli", "orbit.js");


test("ticket description markdown renders common formatting safely", () => {
  const html = renderMarkdown(
    'First **bold** and *em* with `code`.\nSecond line\n\n- one\n- [link](https://example.com?a=1&b=2)\n\n1. first\n2. second\n\n```js\nconst x = "<tag>";\n```'
  );

  assert.match(html, /<p>First <strong>bold<\/strong> and <em>em<\/em> with <code>code<\/code>\.<br>Second line<\/p>/);
  assert.match(html, /<ul><li>one<\/li><li><a href="https:\/\/example\.com\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">link<\/a><\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<pre><code>const x = &quot;&lt;tag&gt;&quot;;<\/code><\/pre>/);
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

test("ticket descriptions use markdown rendering in the board and detail pane", () => {
  const formatSource = readFileSync(join(repoRoot, "public", "js", "format.js"), "utf8");
  const kanbanSource = readFileSync(join(repoRoot, "public", "js", "kanban.js"), "utf8");
  const detailSource = readFileSync(join(repoRoot, "public", "js", "ticket-detail.js"), "utf8");

  assert.match(formatSource, /export function renderMarkdown/);
  assert.match(kanbanSource, /renderMarkdown\(ticket\.description\)/);
  assert.match(kanbanSource, /card-description markdown-body/);
  assert.match(detailSource, /description markdown-body editable-field/);
  assert.match(detailSource, /renderMarkdown\(ticket\.description\)/);
  assert.doesNotMatch(detailSource, /escapeHtml\(ticket\.description \|\| "No description yet\."\)/);
});

test("ticket detail fetches comments from the dedicated endpoint", () => {
  const detailSource = readFileSync(join(repoRoot, "public", "js", "ticket-detail.js"), "utf8");

  assert.match(detailSource, /\/api\/tickets\/\$\{state\.selectedTicketId\}\/comments/);
  assert.match(detailSource, /api\(withBoardQuery\(`\/api\/tickets\/\$\{state\.selectedTicketId\}\/comments`\)\)\.then\(\(result\) => result\.comments \|\| \[\]\)/);
  assert.match(detailSource, /comments\.map\(renderComment\)/);
  assert.doesNotMatch(detailSource, /context\.comments\.map\(renderComment\)/);
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
  assert.doesNotMatch(settingsSource, /data-edit-field.*title/s);
  assert.match(drawerSource, /if \(titleAttrs\)/);
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
  assert.match(detailSource, /\/api\/tickets\/\$\{ticketId\}\/context\?depth=1/);
  assert.match(detailSource, /\/api\/tickets\/\$\{ticketId\}\/comments/);
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
