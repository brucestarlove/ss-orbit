import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { folderPickerCommands, pickFolder } from "../src/core/system-picker.js";
import { normalizePath } from "../src/core/util.js";

const repoRoot = resolve(import.meta.dirname, "..");
const orbitCli = join(repoRoot, "src", "cli", "orbit.js");

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
  runOrbit(["init", "--ai", "--cwd", h.projectRoot], h);

  const db = new DatabaseSync(join(h.projectRoot, ".orbit", "board.db"));
  const board = db.prepare("SELECT id, slug, name, repo_url, system_path, default_branch, project_notes, ai_enabled FROM boards LIMIT 1").get();
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

test("board delete removes registry row and local board database after slug confirmation", async () => {
  const h = makeHarness();
  runOrbit(["init", "--example", "--cwd", h.projectRoot], h);

  const dbPath = join(h.projectRoot, ".orbit", "board.db");
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
    assert.equal(existsSync(dbPath), false);

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

test("snapshot import after delete and re-init restores into the new board id", async () => {
  const h = makeHarness();
  runOrbit(["init", "--example", "--cwd", h.projectRoot], h);

  const dbPath = join(h.projectRoot, ".orbit", "board.db");
  const originalDb = new DatabaseSync(dbPath);
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
    const replacementDb = new DatabaseSync(dbPath);
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

    const restoredDb = new DatabaseSync(dbPath);
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

  const db = new DatabaseSync(join(h.projectRoot, ".orbit", "board.db"));
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

  const db = new DatabaseSync(join(h.projectRoot, ".orbit", "board.db"));
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

  const db = new DatabaseSync(join(h.projectRoot, ".orbit", "board.db"));
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

  const db = new DatabaseSync(join(h.projectRoot, ".orbit", "board.db"));
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
