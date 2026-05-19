#!/usr/bin/env node
/**
 * Orbit CLI — `orbit init` provisions `.orbit/board.db`, registry row, and
 * copies SKILL-ORBIT.md into the target repo. Does not import board.js.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function printUsage() {
  console.log(`Usage:
  orbit init  [options]    Provision .orbit/board.db + SKILL-ORBIT.md + AGENTS.md
  orbit reset [options]    Delete .orbit/ + SKILL-ORBIT.md + registry row
  orbit serve [options]    Start the Orbit web app + HTTP API
  orbit docker [options]   Build/run Orbit's web app in Docker
  orbit mcp   [options]    Start the stdio MCP server (for agent clients)

Options (init / reset / serve / docker / mcp):
  --cwd <dir>           Project root (default: process.cwd())

Options (init only):
  --no-ai               Create the board with AI collaboration disabled
  --example             Create example onboarding tickets
  --refresh-agents-md   Overwrite SKILL-ORBIT.md and refresh Orbit section in AGENTS.md

Options (serve / docker):
  --port <n>            HTTP port (default: 3337, or $PORT)

Options (docker only):
  --image <name>        Docker image tag (default: starscape-orbit:local)
  --data-dir <dir>      Docker registry/export data dir (default: <cwd>/.orbit/docker-data)
  --name <name>         Optional Docker container name
  -d, --detach          Run the container in the background (default)
  --foreground          Run attached in the foreground
  --no-build            Skip docker build and run an existing image
  --dry-run             Print docker commands without running them`);
}

function shellQuote(value) {
  return `"${String(value || "").replace(/"/g, '\\"')}"`;
}

function commandQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function formatCommand(executable, args) {
  return [executable, ...args].map(commandQuote).join(" ");
}

const ORBIT_AGENTS_START = "<!-- ORBIT:AGENTS-START -->";
const ORBIT_AGENTS_END = "<!-- ORBIT:AGENTS-END -->";

async function loadCliCore() {
  const [
    { enableAiCollaboration },
    { backupBoardDatabase, backupRegistry },
    { createRegistrySchema, openConnection },
    { DATA_DIR, ROOT_DIR },
    { provisionRepoBoard },
    { deleteBoard, getBoardByRepoPath },
    { normalizePath }
  ] = await Promise.all([
    import("../core/boards.js"),
    import("../core/backups.js"),
    import("../core/db.js"),
    import("../core/paths.js"),
    import("../core/provision-repo-board.js"),
    import("../core/registry.js"),
    import("../core/util.js")
  ]);

  return {
    DATA_DIR,
    ROOT_DIR,
    backupBoardDatabase,
    backupRegistry,
    createRegistrySchema,
    deleteBoard,
    enableAiCollaboration,
    getBoardByRepoPath,
    normalizePath,
    openConnection,
    provisionRepoBoard
  };
}

function orbitAgentsSection() {
  return `${ORBIT_AGENTS_START}
When work mentions Orbit, kanban, board, lane, ticket, card, epic, blocker, claim, AI Ready, implementation fields, planning state, project memory, or handoff: read \`SKILL-ORBIT.md\` first and follow it.
${ORBIT_AGENTS_END}\n`;
}

function buildAgentsMd() {
  return `# AGENTS.md

Git is canonical for code. \`SKILL-ORBIT.md\` is canonical for Orbit/kanban/ticket/card workflow.

${orbitAgentsSection()}`;
}

function syncAgentsMd(projectRoot, options) {
  const agentsPath = resolve(projectRoot, "AGENTS.md");
  const section = orbitAgentsSection();

  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, buildAgentsMd(), "utf8");
    console.log(`Wrote ${agentsPath}`);
    return;
  }

  const current = readFileSync(agentsPath, "utf8");
  const startIndex = current.indexOf(ORBIT_AGENTS_START);
  const endIndex = current.indexOf(ORBIT_AGENTS_END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    if (!options.refreshAgentsMd) {
      console.log("AGENTS.md already includes Orbit instructions — left unchanged (use --refresh-agents-md to replace).");
      return;
    }
    const before = current.slice(0, startIndex).replace(/\s*$/, "\n\n");
    const after = current.slice(endIndex + ORBIT_AGENTS_END.length).replace(/^\s*/, "");
    writeFileSync(agentsPath, `${before}${section}${after}`, "utf8");
    console.log(`Refreshed Orbit instructions inside ${agentsPath}`);
    return;
  }

  writeFileSync(agentsPath, `${current.replace(/\s*$/, "\n\n")}${section}`, "utf8");
  console.log(`Appended Orbit instructions to ${agentsPath}`);
}

function enableAiIfEnabled(options, registryRow, core) {
  if (!options.ai || !registryRow) return;
  const { enableAiCollaboration, openConnection } = core;
  const db = openConnection(registryRow.db_path);
  enableAiCollaboration(db, registryRow.id, { stageOnboardingTicket: options.example, actor: "orbit init" });
  const suffix = options.example ? "; example ticket #12 is staged in AI Ready." : ".";
  console.log(`AI collaboration enabled — AI Ready, In Progress, and Review lanes are present${suffix}`);
}

function disableAiIfRequested(options, registryRow, core) {
  if (options.ai || !registryRow) return;
  const { openConnection } = core;
  const db = openConnection(registryRow.db_path);
  db.prepare("UPDATE boards SET ai_enabled = 0, updated_at = ? WHERE id = ?").run(new Date().toISOString(), registryRow.id);
  console.log("AI collaboration disabled for this board.");
}

function parseArgs(argv) {
  const args = {
    command: null,
    cwd: process.env.PROJECT_ROOT ? resolve(process.env.PROJECT_ROOT) : process.cwd(),
    cwdProvided: false,
    refreshAgentsMd: false,
    ai: true,
    example: false,
    port: null,
    image: "starscape-orbit:local",
    dataDir: null,
    containerName: null,
    buildImage: true,
    detach: true,
    dryRun: false
  };
  const rest = argv.slice(2);
  if (rest.length === 0 || rest[0] === "-h" || rest[0] === "--help") {
    args.command = "help";
    return args;
  }
  args.command = rest[0];
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--refresh-agents-md") args.refreshAgentsMd = true;
    else if (a === "--no-ai") args.ai = false;
    else if (a === "--example") args.example = true;
    else if (a === "--cwd" && rest[i + 1]) {
      args.cwdProvided = true;
      args.cwd = resolve(rest[++i]);
    } else if (a.startsWith("--cwd=")) {
      args.cwdProvided = true;
      args.cwd = resolve(a.slice("--cwd=".length));
    } else if (a === "--port" && rest[i + 1]) {
      args.port = rest[++i];
    } else if (a.startsWith("--port=")) {
      args.port = a.slice("--port=".length);
    } else if (a === "--image" && rest[i + 1]) {
      args.image = rest[++i];
    } else if (a.startsWith("--image=")) {
      args.image = a.slice("--image=".length);
    } else if (a === "--data-dir" && rest[i + 1]) {
      args.dataDir = resolve(rest[++i]);
    } else if (a.startsWith("--data-dir=")) {
      args.dataDir = resolve(a.slice("--data-dir=".length));
    } else if (a === "--name" && rest[i + 1]) {
      args.containerName = rest[++i];
    } else if (a.startsWith("--name=")) {
      args.containerName = a.slice("--name=".length);
    } else if (a === "--no-build") {
      args.buildImage = false;
    } else if (a === "-d" || a === "--detach") {
      args.detach = true;
    } else if (a === "--foreground") {
      args.detach = false;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else {
      console.error(`Unknown argument: ${a}`);
      args.command = "help";
      return args;
    }
  }
  return args;
}

async function runInit(options) {
  const core = await loadCliCore();
  const { DATA_DIR, ROOT_DIR, createRegistrySchema, normalizePath, provisionRepoBoard } = core;
  const projectRoot = normalizePath(resolve(options.cwd));
  mkdirSync(DATA_DIR, { recursive: true });
  createRegistrySchema();

  const result = provisionRepoBoard(projectRoot, { enableAi: options.ai, includeExamples: options.example });
  const skillSrc = resolve(ROOT_DIR, "SKILL-ORBIT.md");
  const skillDest = resolve(projectRoot, "SKILL-ORBIT.md");

  if (!existsSync(skillSrc)) {
    console.warn(`Warning: missing ${skillSrc} — skipped copying SKILL-ORBIT.md and AGENTS.md Orbit section.`);
  } else {
    if (skillSrc === skillDest) {
      console.log("SKILL-ORBIT.md source is already the project copy — left unchanged.");
    } else if (existsSync(skillDest) && !options.refreshAgentsMd) {
      console.log(`SKILL-ORBIT.md already exists — left unchanged (use --refresh-agents-md to replace).`);
    } else {
      copyFileSync(skillSrc, skillDest);
      console.log(`Wrote ${skillDest}`);
    }
    syncAgentsMd(projectRoot, options);
  }

  enableAiIfEnabled(options, result.registryRow, core);
  disableAiIfRequested(options, result.registryRow, core);

  if (result.message && result.status === "skipped") {
    console.log(result.message);
  } else if (result.status === "created") {
    console.log(`Initialized Orbit board at ${resolve(projectRoot, ".orbit", "board.db")}`);
  } else if (result.status === "repaired") {
    console.log(result.message || "Linked existing board database to the registry.");
  }

  const cliPath = resolve(ROOT_DIR, "src", "cli", "orbit.js");
  const mcpLine = ["claude mcp add starscape-orbit", "--", "node", shellQuote(cliPath), "mcp", "--cwd", shellQuote(projectRoot)].join(" ");
  console.log(`
--- Next: MCP (run once per Claude Code install) ---
${mcpLine}

--- Next: agent prompt (from this repo) ---
Read AGENTS.md in this repository, then use the Orbit MCP tools. Use board_list, board_set_active, and ticket context tools per docs/AGENT_PROTOCOL.md before claiming or updating work.

${options.example ? (options.ai ? "Example ticket #12 is \"Try Orbit MCP on this ticket\" in AI Ready — good first exercise after MCP is connected." : "Example tickets were created. AI collaboration was disabled with `--no-ai`, so ticket #12 remains in Backlog.") : "No example tickets were created. Rerun on a fresh board with `orbit init --example` if you want the onboarding examples."}
`);

  if (result.registryRow) {
    console.log(`Board: ${result.registryRow.name} (${result.registryRow.slug})  registry id: ${result.registryRow.id}`);
  }
}

async function runReset(options) {
  const {
    DATA_DIR,
    backupBoardDatabase,
    backupRegistry,
    createRegistrySchema,
    deleteBoard,
    getBoardByRepoPath,
    normalizePath,
    openConnection
  } = await loadCliCore();
  const projectRoot = normalizePath(resolve(options.cwd));
  mkdirSync(DATA_DIR, { recursive: true });
  createRegistrySchema();

  const orbitDir = resolve(projectRoot, ".orbit");
  const skillMd = resolve(projectRoot, "SKILL-ORBIT.md");
  const removed = [];
  const registryRow = getBoardByRepoPath(projectRoot);

  if (registryRow && existsSync(registryRow.db_path)) {
    backupBoardDatabase(registryRow, openConnection(registryRow.db_path), "pre-cli-reset");
  }
  if (registryRow) backupRegistry("pre-cli-reset");

  if (existsSync(orbitDir)) {
    rmSync(orbitDir, { recursive: true, force: true });
    removed.push(orbitDir);
  }
  if (existsSync(skillMd)) {
    unlinkSync(skillMd);
    removed.push(skillMd);
  }

  if (registryRow) {
    deleteBoard(registryRow.id);
    removed.push(`registry row "${registryRow.slug}"`);
  }

  if (removed.length === 0) {
    console.log(`Nothing to reset under ${projectRoot}.`);
  } else {
    for (const item of removed) console.log(`Removed ${item}`);
    console.log(`\nRun \`orbit init\` from ${projectRoot} to provision a fresh board.`);
  }
}

async function runServe(options) {
  // PROJECT_ROOT must be set BEFORE importing the server, because src/core/paths.js
  // captures it at module load. cwd defaults are equivalent for most users, but
  // an explicit --cwd lets a global install target a board outside cwd.
  process.env.PROJECT_ROOT = resolve(options.cwd);
  if (options.port) process.env.PORT = String(options.port);
  await import("../server.js");
}

function containerPathFor(hostPath, fallbackPath) {
  // Linux/macOS Docker can mount the same absolute path into the container,
  // which keeps existing Orbit board metadata meaningful. Windows paths are
  // not valid Linux container paths, so use stable in-container fallbacks.
  return process.platform === "win32" ? fallbackPath : hostPath;
}

function buildDockerPlan(options) {
  const projectRoot = resolve(options.cwd);
  const dataDir = resolve(options.dataDir || resolve(projectRoot, ".orbit", "docker-data"));
  const containerProjectRoot = containerPathFor(projectRoot, "/workspace");
  const containerDataDir = containerPathFor(dataDir, "/data");
  const port = String(options.port || process.env.PORT || 3337);

  if (!existsSync(projectRoot)) {
    throw new Error(`Project root does not exist: ${projectRoot}`);
  }
  if (!existsSync(resolve(PACKAGE_ROOT, "Dockerfile"))) {
    throw new Error(`Dockerfile not found in Orbit package root: ${PACKAGE_ROOT}`);
  }

  const buildArgs = ["build", "-t", options.image, PACKAGE_ROOT];
  const runArgs = ["run", "--rm"];
  if (options.detach) {
    runArgs.push("--detach");
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    runArgs.push("-it");
  }
  if (options.containerName) runArgs.push("--name", options.containerName);
  runArgs.push(
    "-p",
    `${port}:${port}`,
    "-e",
    `PORT=${port}`,
    "-e",
    `PROJECT_ROOT=${containerProjectRoot}`,
    "-e",
    `DATA_DIR=${containerDataDir}`,
    "-e",
    `SYSTEM_PATH=${projectRoot}`,
    "-v",
    `${projectRoot}:${containerProjectRoot}`,
    "-v",
    `${dataDir}:${containerDataDir}`,
    "-w",
    containerProjectRoot,
    options.image,
    "serve",
    "--cwd",
    containerProjectRoot,
    "--port",
    port
  );

  return { buildArgs, containerDataDir, containerProjectRoot, dataDir, port, projectRoot, runArgs };
}

function runDockerCommand(args) {
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.error) {
    throw new Error(`Failed to run docker: ${result.error.message}`);
  }
  if (result.signal) {
    process.exitCode = 1;
    return false;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return false;
  }
  return true;
}

async function runDocker(options) {
  const plan = buildDockerPlan(options);
  const dryRun = options.dryRun || process.env.ORBIT_DOCKER_DRY_RUN === "1";

  if (dryRun) {
    console.log(`Project root: ${plan.projectRoot}`);
    console.log(`Docker data: ${plan.dataDir}`);
    if (options.buildImage) {
      console.log(`Docker build:\n  ${formatCommand("docker", plan.buildArgs)}`);
    }
    console.log(`Docker run:\n  ${formatCommand("docker", plan.runArgs)}`);
    return;
  }

  mkdirSync(plan.dataDir, { recursive: true });
  if (options.buildImage && !runDockerCommand(plan.buildArgs)) return;
  runDockerCommand(plan.runArgs);
}

async function runMcp(options) {
  process.env.PROJECT_ROOT = resolve(options.cwd);
  await import("../mcp-server.js");
}

async function main() {
  const args = parseArgs(process.argv);
  try {
    if (args.command === "init") {
      await runInit(args);
    } else if (args.command === "reset") {
      await runReset(args);
    } else if (args.command === "serve") {
      await runServe(args);
    } else if (args.command === "docker") {
      await runDocker(args);
    } else if (args.command === "mcp") {
      await runMcp(args);
    } else {
      printUsage();
      process.exitCode = args.command === "help" ? 0 : 1;
    }
  } catch (err) {
    console.error(err?.message || err);
    process.exitCode = 1;
  }
}

main();
