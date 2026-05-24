import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const repoRoot = resolve(import.meta.dirname, "..");
const orbitCli = join(repoRoot, "src", "cli", "orbit.js");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), "orbit-cli-test-"));
  const projectRoot = join(root, "project");
  const dataDir = join(root, "data");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ name: "test-project" }), "utf8");
  return { root, projectRoot, dataDir };
}

function runOrbit(args, harness, options = {}) {
  const result = spawnSync(process.execPath, [orbitCli, ...args], {
    cwd: options.cwd || repoRoot,
    env: { ...process.env, DATA_DIR: harness.dataDir, ...(options.env || {}) },
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`orbit ${args.join(" ")} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result.stdout;
}

function runOrbitResult(args, harness, options = {}) {
  return spawnSync(process.execPath, [orbitCli, ...args], {
    cwd: options.cwd || repoRoot,
    env: { ...process.env, DATA_DIR: harness.dataDir, ...(options.env || {}) },
    encoding: "utf8"
  });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandArgRegex(value) {
  const escaped = escapeRegex(value);
  return `(?:'${escaped}'|${escaped})`;
}

/** Open the board database via the registry (central storage). */
function openBoard(harness) {
  const reg = new DatabaseSync(join(harness.dataDir, "registry.db"));
  const row = reg.prepare("SELECT db_path FROM boards ORDER BY created_at LIMIT 1").get();
  reg.close();
  if (!row) throw new Error("No board found in registry");
  return new DatabaseSync(row.db_path);
}

function createCliTicket(harness, title = "Dispatch me", stateRole = null) {
  const db = openBoard(harness);
  const board = db.prepare("SELECT * FROM boards LIMIT 1").get();
  const state = stateRole
    ? db.prepare("SELECT * FROM states WHERE board_id = ? AND role = ?").get(board.id, stateRole)
    : db.prepare("SELECT * FROM states WHERE board_id = ? AND is_default = 1").get(board.id);
  const time = new Date().toISOString();
  const number = db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS number FROM tickets WHERE board_id = ?").get(board.id).number;
  const ticketId = `ticket-${number}-${Math.random().toString(16).slice(2)}`;
  db.prepare(
    `INSERT INTO tickets (id, board_id, number, title, description, type, ai_plan, implementation_summary,
                          implementation_updates, state_id, priority, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'task', '', '', '', ?, 0, 'test', ?, ?)`
  ).run(ticketId, board.id, number, title, state.id, time, time);
  db.close();
  return { board, id: ticketId, number, title };
}

function readCliTicket(harness, ticketId) {
  const db = openBoard(harness);
  const ticket = db
    .prepare(
      `SELECT t.*, s.name AS state_name, s.role AS state_role
       FROM tickets t JOIN states s ON s.id = t.state_id
       WHERE t.id = ?`
    )
    .get(ticketId);
  const comments = db.prepare("SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at").all(ticketId);
  db.close();
  return { ticket, comments };
}

function createFakeHermesBin(root, { exitCode = 0 } = {}) {
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, "hermes");
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nconst fs = require('fs');\nfs.appendFileSync(${JSON.stringify(join(root, "hermes.log"))}, process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(${exitCode});\n`,
    { mode: 0o755 }
  );
  return bin;
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed
STDOUT:
${result.stdout}
STDERR:
${result.stderr}`);
  }
  return result.stdout;
}

function initGitRepo(projectRoot) {
  runGit(["init"], projectRoot);
  runGit(["config", "user.name", "Orbit Test"], projectRoot);
  runGit(["config", "user.email", "orbit-test@example.invalid"], projectRoot);
  runGit(["add", "package.json"], projectRoot);
  runGit(["commit", "-m", "init"], projectRoot);
}

test("orbit -v and --version print the package version", () => {
  const h = makeHarness();
  for (const flag of ["-v", "--version"]) {
    const result = spawnSync(process.execPath, [orbitCli, flag], {
      cwd: repoRoot,
      env: { ...process.env, DATA_DIR: h.dataDir },
      encoding: "utf8"
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), packageJson.version);
    assert.equal(result.stderr, "");
  }
});

test("orbit dispatch prepares a ticket handoff, run record, safe policy, and preserved worktree", () => {
  const h = makeHarness();
  initGitRepo(h.projectRoot);
  runOrbit(["init", "--example", "--cwd", h.projectRoot], h);

  const stdout = runOrbit(["dispatch", "--cwd", h.projectRoot, "--ticket", "12", "--profile", "nova", "--worktree", "--no-spawn"], h);

  assert.match(stdout, /Dispatch prepared:/);
  assert.match(stdout, /Ticket: #12 Try Orbit MCP on this ticket/);
  assert.match(stdout, /Profile: nova/);
  assert.match(stdout, /Policy: nova-safe/);

  const db = openBoard(h);
  const ticket = db
    .prepare(`SELECT t.ai_plan, s.name AS state_name
              FROM tickets t JOIN states s ON s.id = t.state_id
              WHERE t.number = 12`)
    .get();
  assert.equal(ticket.state_name, "AI Ready");
  assert.match(ticket.ai_plan, /# Orbit Agent Handoff/);
  assert.match(ticket.ai_plan, /Autonomous policy: nova-safe/);
  assert.match(ticket.ai_plan, /AI Implementation Summary/);

  const comment = db
    .prepare("SELECT body FROM comments WHERE author = 'orbit dispatch' ORDER BY created_at DESC LIMIT 1")
    .get();
  assert.ok(comment);
  assert.match(comment.body, /run_id: orbit-12-nova-/);
  assert.match(comment.body, /pid: not spawned/);
  assert.match(comment.body, /mode: prepare-only/);
  assert.match(comment.body, /ticket state left unchanged/);
  assert.match(comment.body, /policy_bin:/);

  const worktreeLine = stdout.split("\n").find((line) => line.startsWith("Worktree: "));
  const worktreePath = worktreeLine.replace("Worktree: ", "").trim();
  assert.equal(existsSync(join(worktreePath, "package.json")), true);

  const policyLine = comment.body.split("\n").find((line) => line.includes("policy_bin:"));
  const policyBin = policyLine.replace("- policy_bin: ", "").trim();
  const docker = spawnSync(join(policyBin, "docker"), ["ps"], { encoding: "utf8" });
  assert.equal(docker.status, 126);
  assert.match(docker.stderr, /Docker requires explicit human approval/);
  const gitPush = spawnSync(join(policyBin, "git"), ["push", "origin", "HEAD"], { encoding: "utf8" });
  assert.equal(gitPush.status, 126);
  assert.match(gitPush.stderr, /Blocked by Orbit nova-safe policy: git push/);
  const npmInstall = spawnSync(join(policyBin, "npm"), ["install"], { encoding: "utf8" });
  assert.equal(npmInstall.status, 126);
  assert.match(npmInstall.stderr, /allowed package commands: test/);
  db.close();
});

test("orbit dispatch --help prints usage without an unknown argument warning", () => {
  const h = makeHarness();
  const result = runOrbitResult(["dispatch", "--help"], h);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /orbit dispatch \[options\]/);
  assert.doesNotMatch(result.stderr + result.stdout, /Unknown argument/);
});

test("orbit dispatch refuses remote server-url before creating local artifacts", () => {
  const h = makeHarness();
  const beforeRootEntries = readdirSync(h.root);
  const result = runOrbitResult(
    ["dispatch", "--board", "missing", "--ticket", "1", "--server-url", "https://orbit.example.test"],
    h
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Remote dispatch is not supported/i);
  assert.deepEqual(readdirSync(h.root), beforeRootEntries);
});

test("orbit dispatch validates board and ticket before writes", () => {
  const h = makeHarness();
  const missingBoard = runOrbitResult(["dispatch", "--board", "nope", "--ticket", "1"], h);

  assert.notEqual(missingBoard.status, 0);
  assert.match(missingBoard.stderr, /Board not found: nope/);

  runOrbit(["init", "--cwd", h.projectRoot], h);
  const ticket = createCliTicket(h);
  const missingTicket = runOrbitResult(["dispatch", "--board", ticket.board.slug, "--ticket", "99", "--no-spawn"], h);

  assert.notEqual(missingTicket.status, 0);
  assert.match(missingTicket.stderr, /Ticket not found/);
  const db = openBoard(h);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM comments").get().count, 0);
  assert.equal(existsSync(join(h.projectRoot, ".orbit", "dispatch-runs")), false);
  db.close();
});

test("orbit dispatch refuses blocked tickets before writes", () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);
  const blocked = createCliTicket(h, "Blocked dispatch target");
  const blocker = createCliTicket(h, "Blocking ticket");
  const db = openBoard(h);
  db.prepare("INSERT INTO relations (id, source_ticket_id, target_ticket_id, type, created_at) VALUES (?, ?, ?, 'blocked_by', ?)")
    .run("relation-blocks-dispatch", blocked.id, blocker.id, new Date().toISOString());
  db.close();

  const result = runOrbitResult(["dispatch", "--board", blocked.board.slug, "--ticket", String(blocked.number), "--no-spawn"], h);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Ticket #1 is blocked/);
  const after = readCliTicket(h, blocked.id);
  assert.equal(after.comments.length, 0);
  assert.equal(after.ticket.ai_plan, "");
  assert.equal(existsSync(join(h.projectRoot, ".orbit", "dispatch-runs")), false);
});

test("orbit dispatch preflights missing Hermes before ticket mutation", () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);
  const ticket = createCliTicket(h);

  const result = runOrbitResult(
    ["dispatch", "--board", ticket.board.slug, "--ticket", String(ticket.number), "--hermes-bin", join(h.root, "missing-hermes")],
    h
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Hermes binary not found/);
  assert.match(result.stderr, /--no-spawn/);
  const after = readCliTicket(h, ticket.id);
  assert.equal(after.ticket.state_name, "Todo");
  assert.equal(after.ticket.ai_plan, "");
  assert.equal(after.comments.length, 0);
  assert.equal(existsSync(join(h.projectRoot, ".orbit", "dispatch-runs")), false);
});

test("orbit dispatch --dry-run previews without mutating the ticket", () => {
  const h = makeHarness();
  initGitRepo(h.projectRoot);
  runOrbit(["init", "--cwd", h.projectRoot], h);
  const ticket = createCliTicket(h);

  const result = runOrbitResult(["dispatch", "--board", ticket.board.slug, "--ticket", String(ticket.number), "--worktree", "--dry-run"], h);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Dry run: would dispatch ticket/);
  assert.match(result.stdout, /No files, worktrees, ticket fields, comments, or agents were changed/);
  const after = readCliTicket(h, ticket.id);
  assert.equal(after.ticket.ai_plan, "");
  assert.equal(after.comments.length, 0);
  assert.equal(existsSync(join(h.projectRoot, ".orbit", "dispatch-runs")), false);
  assert.equal(existsSync(join(h.projectRoot, ".worktrees")), false);
});

test("orbit dispatch with a valid Hermes preflight writes run record and moves In Progress", () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);
  const ticket = createCliTicket(h);
  const hermes = createFakeHermesBin(h.root);

  const result = runOrbitResult(
    ["dispatch", "--board", ticket.board.slug, "--ticket", String(ticket.number), "--profile", "nova", "--hermes-bin", hermes],
    h
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Dispatch started:/);
  const after = readCliTicket(h, ticket.id);
  assert.equal(after.ticket.state_name, "In Progress");
  assert.match(after.ticket.ai_plan, /# Orbit Agent Handoff/);
  assert.equal(after.comments.length, 1);
  assert.match(after.comments[0].body, /mode: spawned/);
  assert.match(after.comments[0].body, /pid: \d+/);
  const hermesLog = readFileSync(join(h.root, "hermes.log"), "utf8");
  assert.match(hermesLog, /-p nova --help/);
});

test("orbit init creates AGENTS.md with Orbit instructions when missing", () => {
  const h = makeHarness();

  const stdout = runOrbit(["init", "--cwd", h.projectRoot], h);
  const skillOrbit = join(h.projectRoot, "SKILL-ORBIT.md");
  const agents = join(h.projectRoot, "AGENTS.md");

  assert.equal(existsSync(skillOrbit), true);
  assert.equal(existsSync(agents), true);
  assert.match(stdout, /Wrote .*SKILL-ORBIT\.md/);
  assert.match(stdout, /Wrote .*AGENTS\.md/);

  const content = readFileSync(agents, "utf8");
  assert.match(content, /^# AGENTS\.md/m);
  assert.match(content, /SKILL-ORBIT\.md` is canonical for Orbit\/kanban\/ticket\/card workflow/);
  assert.match(content, /When work mentions Orbit, kanban, board, lane, ticket, card/);
  assert.match(content, /Use Orbit API\/MCP tools for tickets\/cards; do not edit \.orbit\/board\.db directly\./);
  assert.doesNotMatch(content, /## Orbit Project Context/);
});

test("orbit init appends Orbit instructions to existing AGENTS.md once", () => {
  const h = makeHarness();
  const agents = join(h.projectRoot, "AGENTS.md");
  writeFileSync(agents, "# Existing Agent Rules\n\nKeep this repo-specific rule.\n", "utf8");

  const first = runOrbit(["init", "--cwd", h.projectRoot], h);
  const second = runOrbit(["init", "--cwd", h.projectRoot], h);
  const content = readFileSync(agents, "utf8");

  assert.match(first, /Appended Orbit instructions to .*AGENTS\.md/);
  assert.match(second, /AGENTS\.md already includes Orbit instructions/);
  assert.match(content, /Keep this repo-specific rule/);
  assert.equal((content.match(/ORBIT:AGENTS-START/g) || []).length, 1);
  assert.match(content, /SKILL-ORBIT\.md/);
  assert.match(content, /Use Orbit API\/MCP tools for tickets\/cards; do not edit \.orbit\/board\.db directly\./);
});

test("orbit init creates an empty board by default", () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);
  const db = openBoard(h);
  const ticketCount = db.prepare("SELECT COUNT(*) AS count FROM tickets").get().count;
  const board = db.prepare("SELECT ai_enabled, agent_instructions FROM boards LIMIT 1").get();
  const lanes = db.prepare("SELECT name, role FROM states ORDER BY position").all();

  assert.equal(ticketCount, 0);
  assert.equal(board.ai_enabled, 1);
  assert.equal(board.agent_instructions, "");
  assert.deepEqual(lanes.map((lane) => lane.name), ["Backlog", "Todo", "AI Ready", "In Progress", "Review", "Done", "Cancelled"]);
  assert.equal(lanes[2].role, "ai_ready");
});

test("orbit init --example creates onboarding tickets", () => {
  const h = makeHarness();
  const stdout = runOrbit(["init", "--example", "--cwd", h.projectRoot], h);
  const db = openBoard(h);
  const tickets = db
    .prepare(`SELECT t.number, t.title, s.name AS state_name
              FROM tickets t JOIN states s ON s.id = t.state_id
              ORDER BY t.number`)
    .all();

  assert.match(stdout, /Example ticket #12/);
  assert.deepEqual(tickets.map((ticket) => ticket.number), [1, 2, 3, 12]);
  assert.equal(tickets.at(-1).title, "Try Orbit MCP on this ticket");
  assert.equal(tickets.at(-1).state_name, "AI Ready");
});

test("orbit --example is rejected because init is required", () => {
  const h = makeHarness();
  const result = spawnSync(process.execPath, [orbitCli, "--example", "--cwd", h.projectRoot], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir },
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

test("orbit init enables AI collaboration and creates AI Ready lane without examples", () => {
  const h = makeHarness();
  const stdout = runOrbit(["init", "--cwd", h.projectRoot], h);
  const db = openBoard(h);
  const board = db.prepare("SELECT ai_enabled FROM boards LIMIT 1").get();
  const lane = db.prepare("SELECT id, role, position FROM states WHERE name = 'AI Ready'").get();
  const ticketCount = db.prepare("SELECT COUNT(*) AS count FROM tickets").get().count;

  assert.match(stdout, /AI collaboration enabled/);
  assert.equal(board.ai_enabled, 1);
  assert.equal(lane.role, "ai_ready");
  assert.equal(lane.position, 2);
  assert.equal(ticketCount, 0);
});

test("orbit init --no-ai creates a board without the AI Ready lane", () => {
  const h = makeHarness();
  const stdout = runOrbit(["init", "--no-ai", "--cwd", h.projectRoot], h);
  const db = openBoard(h);
  const board = db.prepare("SELECT ai_enabled FROM boards LIMIT 1").get();
  const lanes = db.prepare("SELECT name FROM states ORDER BY position").all();

  assert.doesNotMatch(stdout, /AI collaboration enabled/);
  assert.equal(board.ai_enabled, 0);
  assert.deepEqual(lanes.map((lane) => lane.name), ["Backlog", "Todo", "In Progress", "Review", "Done", "Cancelled"]);
});

test("orbit init --no-ai disables AI on an existing board", () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);
  const stdout = runOrbit(["init", "--no-ai", "--cwd", h.projectRoot], h);
  const db = openBoard(h);
  const board = db.prepare("SELECT ai_enabled FROM boards LIMIT 1").get();
  const aiReady = db.prepare("SELECT name, position FROM states WHERE role = 'ai_ready'").get();

  assert.match(stdout, /AI collaboration disabled/);
  assert.equal(board.ai_enabled, 0);
  assert.equal(aiReady.name, "AI Ready");
  assert.equal(aiReady.position, 2);
});

test("orbit init enables AI on an existing non-AI board", () => {
  const h = makeHarness();
  runOrbit(["init", "--no-ai", "--cwd", h.projectRoot], h);
  const stdout = runOrbit(["init", "--cwd", h.projectRoot], h);
  const db = openBoard(h);
  const board = db.prepare("SELECT ai_enabled FROM boards LIMIT 1").get();
  const lanes = db.prepare("SELECT name FROM states ORDER BY position").all();

  assert.match(stdout, /AI collaboration enabled/);
  assert.equal(board.ai_enabled, 1);
  assert.deepEqual(lanes.map((lane) => lane.name), ["Backlog", "Todo", "AI Ready", "In Progress", "Review", "Done", "Cancelled"]);
});

test("orbit reset removes board artifacts after backing up the board", () => {
  const h = makeHarness();
  runOrbit(["init", "--example", "--cwd", h.projectRoot], h);
  const db = openBoard(h);
  const board = db.prepare("SELECT id FROM boards LIMIT 1").get();
  db.close();

  // Capture the central db path before reset so we can verify it's gone.
  const reg0 = new DatabaseSync(join(h.dataDir, "registry.db"));
  const { db_path: boardDbPath } = reg0.prepare("SELECT db_path FROM boards LIMIT 1").get();
  const boardDir = dirname(boardDbPath);
  reg0.close();

  const stdout = runOrbit(["reset", "--cwd", h.projectRoot], h);

  assert.match(stdout, /Removed/);
  assert.equal(existsSync(boardDbPath), false, "central board db should be deleted");
  assert.equal(existsSync(boardDir), false, "central board dir should be deleted");
  assert.equal(existsSync(join(h.projectRoot, ".orbit")), false);
  assert.equal(existsSync(join(h.projectRoot, "SKILL-ORBIT.md")), false);
  const agents = readFileSync(join(h.projectRoot, "AGENTS.md"), "utf8");
  assert.doesNotMatch(agents, /ORBIT:AGENTS-START/);

  const registry = new DatabaseSync(join(h.dataDir, "registry.db"));
  assert.equal(registry.prepare("SELECT COUNT(*) AS count FROM boards").get().count, 0);
  registry.close();

  const backupDir = join(h.dataDir, "backups", "boards", board.id);
  assert.ok(readdirSync(backupDir).some((name) => name.includes("pre-cli-reset") && name.endsWith(".board.db")));
});

test("orbit docker --dry-run prints build and isolated container run commands", () => {
  const h = makeHarness();
  const stdout = runOrbit(
    ["docker", "--dry-run", "--cwd", h.projectRoot, "--port", "4567", "--image", "orbit-test:local"],
    h
  );
  const dockerDataDir = join(h.projectRoot, ".orbit", "docker-data");
  const containerProjectRoot = process.platform === "win32" ? "/workspace" : h.projectRoot;
  const containerDataDir = process.platform === "win32" ? "/data" : dockerDataDir;

  assert.match(stdout, /Docker build:/);
  assert.match(stdout, /docker build -t orbit-test:local/);
  assert.match(stdout, /Docker run:/);
  assert.match(stdout, /docker run --rm --detach/);
  assert.match(stdout, /-p 4567:4567/);
  assert.match(stdout, new RegExp(`-e DATA_DIR=${escapeRegex(containerDataDir)}`));
  assert.match(stdout, new RegExp(`-v ${commandArgRegex(`${h.projectRoot}:${containerProjectRoot}`)}`));
  assert.match(stdout, new RegExp(`-v ${commandArgRegex(`${dockerDataDir}:${containerDataDir}`)}`));
  assert.match(stdout, /serve --cwd .* --port 4567/);
});

test("orbit docker -d maps to Docker detach mode", () => {
  const h = makeHarness();
  const stdout = runOrbit(["docker", "--dry-run", "-d", "--cwd", h.projectRoot], h);

  assert.match(stdout, /Docker run:/);
  assert.match(stdout, /docker run --rm --detach/);
  assert.doesNotMatch(stdout, / -it /);
});

test("orbit docker --foreground runs attached", () => {
  const h = makeHarness();
  const stdout = runOrbit(["docker", "--dry-run", "--foreground", "--cwd", h.projectRoot], h);

  assert.match(stdout, /Docker run:/);
  assert.doesNotMatch(stdout, /--detach/);
});

test("orbit init --example enables AI collaboration, creates AI Ready lane, and stages ticket 12", () => {
  const h = makeHarness();
  const stdout = runOrbit(["init", "--example", "--cwd", h.projectRoot], h);
  const db = openBoard(h);
  const board = db.prepare("SELECT ai_enabled FROM boards LIMIT 1").get();
  const lane = db.prepare("SELECT id, role FROM states WHERE name = 'AI Ready'").get();
  const ticket = db
    .prepare(`SELECT t.number, s.name AS state_name, s.role AS state_role
              FROM tickets t JOIN states s ON s.id = t.state_id
              WHERE t.number = 12`)
    .get();

  assert.match(stdout, /AI collaboration enabled/);
  assert.equal(board.ai_enabled, 1);
  assert.equal(lane.role, "ai_ready");
  assert.equal(ticket.state_name, "AI Ready");
  assert.equal(ticket.state_role, "ai_ready");
});

test("orbit mcp --cwd selects the requested project root instead of process cwd", async () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);

  const child = spawn(process.execPath, [orbitCli, "mcp", "--cwd", h.projectRoot], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir, MAB_MCP_STDERR_LOG: "1" },
    stdio: ["ignore", "ignore", "pipe"]
  });

  const stderr = await new Promise((resolvePromise, rejectPromise) => {
    let buffer = "";
    const timer = setTimeout(() => resolvePromise(buffer), 2000);
    child.stderr.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("Starscape Orbit MCP ready")) {
        clearTimeout(timer);
        resolvePromise(buffer);
      }
    });
    child.on("error", rejectPromise);
  });
  child.kill("SIGTERM");

  assert.match(stderr, new RegExp(escapeRegex(h.projectRoot), "i"));
  assert.match(stderr, /board\.db/);
});

function waitForLine(child, timeoutMs = 2000) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = "";
    const timer = setTimeout(() => rejectPromise(new Error(`timed out waiting for JSON line; got ${buffer}`)), timeoutMs);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd !== -1) {
        clearTimeout(timer);
        resolvePromise(buffer.slice(0, lineEnd));
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

test("orbit mcp honors PROJECT_ROOT env when --cwd is omitted", async () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);

  const child = spawn(process.execPath, [orbitCli, "mcp"], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir, PROJECT_ROOT: h.projectRoot, MAB_MCP_STDERR_LOG: "1" },
    stdio: ["ignore", "ignore", "pipe"]
  });

  const stderr = await new Promise((resolvePromise, rejectPromise) => {
    let buffer = "";
    const timer = setTimeout(() => resolvePromise(buffer), 2000);
    child.stderr.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("Starscape Orbit MCP ready")) {
        clearTimeout(timer);
        resolvePromise(buffer);
      }
    });
    child.on("error", rejectPromise);
  });
  child.kill("SIGTERM");

  assert.match(stderr, new RegExp(escapeRegex(h.projectRoot), "i"));
});

test("orbit mcp speaks newline-delimited JSON-RPC for Hermes native MCP", async () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);

  const child = spawn(process.execPath, [orbitCli, "mcp", "--cwd", h.projectRoot], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir },
    stdio: ["pipe", "pipe", "pipe"]
  });

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n");
  let tools;
  try {
    const init = JSON.parse(await waitForLine(child));
    assert.equal(init.id, 1);
    assert.equal(init.result.serverInfo.name, "minimal-agent-board");

    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    tools = JSON.parse(await waitForLine(child));
  } finally {
    child.kill("SIGTERM");
  }

  assert.equal(tools.id, 2);
  assert.ok(tools.result.tools.some((tool) => tool.name === "board_context"));
});

test("orbit mcp exposes board_create_ticket and creates cards through core API", async () => {
  const h = makeHarness();
  runOrbit(["init", "--cwd", h.projectRoot], h);

  const child = spawn(process.execPath, [orbitCli, "mcp", "--cwd", h.projectRoot], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: h.dataDir },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let created;
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n");
    const init = JSON.parse(await waitForLine(child));
    assert.equal(init.id, 1);

    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    const tools = JSON.parse(await waitForLine(child));
    assert.ok(tools.result.tools.some((tool) => tool.name === "board_create_ticket"));

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "board_create_ticket",
          arguments: {
            title: "MCP-created task",
            type: "task",
            description: "Created via MCP, not direct SQLite editing.",
            labels: ["mcp"]
          }
        }
      }) + "\n"
    );
    const call = JSON.parse(await waitForLine(child));
    assert.equal(call.id, 3);
    assert.equal(call.result.isError, undefined);
    created = JSON.parse(call.result.content[0].text);
  } finally {
    child.kill("SIGTERM");
  }

  assert.equal(created.title, "MCP-created task");
  assert.equal(created.type, "task");

  const db = openBoard(h);
  const ticket = db.prepare("SELECT id, title, type, created_by FROM tickets WHERE title = ?").get("MCP-created task");
  assert.ok(ticket);
  assert.equal(ticket.id, created.id);
  assert.equal(ticket.title, "MCP-created task");
  assert.equal(ticket.type, "task");
  assert.equal(ticket.created_by, "agent");

  const event = db.prepare("SELECT type, actor FROM events WHERE ticket_id = ? AND type = 'ticket_created'").get(ticket.id);
  assert.ok(event);
  assert.equal(event.actor, "agent");
});
