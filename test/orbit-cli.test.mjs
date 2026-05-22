import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const repoRoot = resolve(import.meta.dirname, "..");
const orbitCli = join(repoRoot, "src", "cli", "orbit.js");

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), "orbit-cli-test-"));
  const projectRoot = join(root, "project");
  const dataDir = join(root, "data");
  spawnSync("mkdir", ["-p", projectRoot, dataDir], { encoding: "utf8" });
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

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandArgRegex(value) {
  const escaped = escapeRegex(value);
  return `(?:'${escaped}'|${escaped})`;
}

function openBoard(projectRoot) {
  const db = new DatabaseSync(join(projectRoot, ".orbit", "board.db"));
  return db;
}

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
  const db = openBoard(h.projectRoot);
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
  const db = openBoard(h.projectRoot);
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
  const db = openBoard(h.projectRoot);
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
  const db = openBoard(h.projectRoot);
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
  const db = openBoard(h.projectRoot);
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
  const db = openBoard(h.projectRoot);
  const board = db.prepare("SELECT ai_enabled FROM boards LIMIT 1").get();
  const lanes = db.prepare("SELECT name FROM states ORDER BY position").all();

  assert.match(stdout, /AI collaboration enabled/);
  assert.equal(board.ai_enabled, 1);
  assert.deepEqual(lanes.map((lane) => lane.name), ["Backlog", "Todo", "AI Ready", "In Progress", "Review", "Done", "Cancelled"]);
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
  const db = openBoard(h.projectRoot);
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
  assert.match(stderr, /\.orbit\/board\.db|\.orbit\\board\.db/);
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

  const db = openBoard(h.projectRoot);
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
