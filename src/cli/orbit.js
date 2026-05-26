#!/usr/bin/env node
/**
 * Orbit CLI — `orbit init` provisions `.orbit/board.db`, registry row, and
 * copies managed SKILL-ORBIT.md into the target repo. Does not import board.js.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeOrbitAgentsSection, syncAgentsMd, syncSkillOrbitMd } from "../core/agents-md.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function printUsage() {
  console.log(`Usage:
  orbit -v, --version      Print the Orbit CLI version
  orbit init  [options]    Provision .orbit/board.db + SKILL-ORBIT.md + AGENTS.md
  orbit reset [options]    Delete .orbit/ + SKILL-ORBIT.md + registry row
  orbit serve [options]    Start the Orbit web app + HTTP API
  orbit docker [options]   Build/run Orbit's web app in Docker
  orbit mcp   [options]    Start the stdio MCP server (for agent clients)
  orbit dispatch [options] Dispatch a Hermes profile on a ticket

Options (init / reset / serve / docker / mcp / dispatch):
  --cwd <dir>           Project root (default: process.cwd())

Options (init only):
  --no-ai               Create the board with AI collaboration disabled
  --example             Create example onboarding tickets

Options (serve / docker):
  --port <n>            HTTP port (default: 3337, or $PORT)

Options (dispatch):
  --board <slug-or-id>  Local board to dispatch against (default: board for --cwd)
  --ticket <number-id>  Ticket number or id to dispatch
  --profile <name>      Hermes profile to run (default: agent)
  --policy <name>       Autonomous policy wrappers to apply (default: agent-safe; use none to disable)
  --server-url <url>    Refused for now; dispatch is local-board only
  --remote              Refused for now; use remote MCP/manual orchestration for hosted boards
  --worktree            Create and preserve a git worktree for review/testing
  --worktree-path <dir> Worktree path when --worktree is used
  --branch <name>       Branch name for the preserved worktree
  --hermes-bin <cmd>    Hermes executable (default: hermes)
  --verify-command <cmd> Declare an expected verification command (repeatable)
  --no-spawn            Prepare card/worktree/run record but do not start Hermes or move In Progress
  --no-yolo             Do not pass --yolo to Hermes (default dispatch passes --yolo)
  --foreground          Attach spawned Hermes process to this terminal
  --keep-handoff-file   Keep duplicate handoff file under DATA_DIR/dispatch-runs/<board>
  --force               Dispatch even when blockers exist
  --dry-run             Preview only; no files, worktrees, ticket fields, comments, or agents change

Options (docker only):
  --image <name>        Docker image tag (default: starscape-orbit:local)
  --data-dir <dir>      Docker registry/export data dir (default: <cwd>/.orbit/docker-data)
  --name <name>         Optional Docker container name
  -d, --detach          Run the container in the background (default)
  --foreground          Run attached in the foreground
  --no-build            Skip docker build and run an existing image
  --dry-run             Print docker commands without running them`);
}

function printVersion() {
  const packageJson = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8"));
  console.log(packageJson.version);
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

async function loadCliCore() {
  const [
    { disableAiCollaboration, enableAiCollaboration },
    { backupBoardDatabase, backupRegistry },
    { closeConnection, createRegistrySchema, openConnection },
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
    closeConnection,
    createRegistrySchema,
    deleteBoard,
    disableAiCollaboration,
    enableAiCollaboration,
    getBoardByRepoPath,
    normalizePath,
    openConnection,
    provisionRepoBoard
  };
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
  const { disableAiCollaboration, openConnection } = core;
  const db = openConnection(registryRow.db_path);
  disableAiCollaboration(db, registryRow.id, { actor: "orbit init" });
  console.log("AI collaboration disabled for this board.");
}

function isBusyFilesystemError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    ["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code) ||
    (error?.code === "ERR_SQLITE_ERROR" && (message.includes("locked") || message.includes("busy")))
  );
}

function resetBusyError(error, projectRoot) {
  if (!isBusyFilesystemError(error)) return error;
  const message = [
    `Orbit could not remove local board files under ${projectRoot}.`,
    "",
    "On Windows this usually means an Orbit web server, MCP helper, editor, or terminal still has .orbit/board.db open.",
    "Close Orbit server terminals and restart any AI client with Orbit MCP enabled, then rerun:",
    `  orbit reset --cwd ${shellQuote(projectRoot)}`,
    "",
    `Original error: ${error.message}`
  ].join("\n");
  const wrapped = new Error(message);
  wrapped.code = error.code;
  wrapped.cause = error;
  return wrapped;
}

function invalidArgs(args, message) {
  console.error(message);
  args.command = "help";
  args.invalid = true;
  return args;
}

function parseArgs(argv) {
  const args = {
    command: null,
    cwd: process.env.PROJECT_ROOT ? resolve(process.env.PROJECT_ROOT) : process.cwd(),
    cwdProvided: false,
    ai: true,
    example: false,
    port: null,
    image: "starscape-orbit:local",
    dataDir: null,
    containerName: null,
    buildImage: true,
    detach: true,
    dryRun: false,
    board: null,
    ticket: null,
    profile: "agent",
    policy: "agent-safe",
    serverUrl: null,
    worktree: false,
    worktreePath: null,
    branch: null,
    hermesBin: "hermes",
    verifyCommands: [],
    noSpawn: false,
    yolo: true,
    keepHandoffFile: false,
    force: false,
    foreground: false,
    remote: false,
    help: false,
    invalid: false
  };
  const rest = argv.slice(2);
  if (rest.length === 0 || rest[0] === "-h" || rest[0] === "--help") {
    args.command = "help";
    return args;
  }
  if (rest[0] === "-v" || rest[0] === "--version") {
    args.command = "version";
    return args;
  }
  if (rest[0] === "dispatch" && (rest[1] === "-h" || rest[1] === "--help")) {
    args.command = "dispatch";
    args.help = true;
    return args;
  }
  args.command = rest[0];
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--no-ai") args.ai = false;
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
    } else if (a === "--board" && rest[i + 1]) {
      args.board = rest[++i];
    } else if (a.startsWith("--board=")) {
      args.board = a.slice("--board=".length);
    } else if (a === "--ticket" && rest[i + 1]) {
      args.ticket = rest[++i];
    } else if (a.startsWith("--ticket=")) {
      args.ticket = a.slice("--ticket=".length);
    } else if (a === "--profile" && rest[i + 1]) {
      args.profile = rest[++i];
    } else if (a.startsWith("--profile=")) {
      args.profile = a.slice("--profile=".length);
    } else if (a === "--policy" && rest[i + 1]) {
      args.policy = rest[++i];
    } else if (a.startsWith("--policy=")) {
      args.policy = a.slice("--policy=".length);
    } else if (a === "--server-url" && rest[i + 1]) {
      args.serverUrl = rest[++i];
    } else if (a.startsWith("--server-url=")) {
      args.serverUrl = a.slice("--server-url=".length);
    } else if (a === "--remote") {
      args.remote = true;
    } else if (a === "--worktree") {
      args.worktree = true;
    } else if (a === "--worktree-path" && rest[i + 1]) {
      args.worktreePath = resolve(rest[++i]);
    } else if (a.startsWith("--worktree-path=")) {
      args.worktreePath = resolve(a.slice("--worktree-path=".length));
    } else if (a === "--branch" && rest[i + 1]) {
      args.branch = rest[++i];
    } else if (a.startsWith("--branch=")) {
      args.branch = a.slice("--branch=".length);
    } else if (a === "--hermes-bin" && rest[i + 1]) {
      args.hermesBin = rest[++i];
    } else if (a.startsWith("--hermes-bin=")) {
      args.hermesBin = a.slice("--hermes-bin=".length);
    } else if (a === "--verify-command") {
      const value = rest[i + 1];
      if (!value || value.startsWith("--")) {
        return invalidArgs(args, "--verify-command requires a non-empty value. Use --verify-command=<cmd> for values that start with --.");
      }
      args.verifyCommands.push(rest[++i]);
    } else if (a.startsWith("--verify-command=")) {
      const value = a.slice("--verify-command=".length);
      if (!value) {
        return invalidArgs(args, "--verify-command requires a non-empty value.");
      }
      args.verifyCommands.push(value);
    } else if (a === "--no-spawn") {
      args.noSpawn = true;
    } else if (a === "--no-yolo") {
      args.yolo = false;
    } else if (a === "--yolo") {
      args.yolo = true;
    } else if (a === "--keep-handoff-file") {
      args.keepHandoffFile = true;
    } else if (a === "--force") {
      args.force = true;
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
      args.foreground = true;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else {
      console.error(`Unknown argument: ${a}`);
      args.command = "help";
      args.invalid = true;
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
    const skillSync = syncSkillOrbitMd(projectRoot, skillSrc);
    if (skillSync.status === "same_file") {
      console.log("SKILL-ORBIT.md source is already the project copy — left unchanged.");
    } else {
      console.log(`Wrote ${skillDest}`);
    }
    syncAgentsMd(projectRoot);
  }

  enableAiIfEnabled(options, result.registryRow, core);
  disableAiIfRequested(options, result.registryRow, core);

  if (result.message && result.status === "skipped") {
    console.log(result.message);
  } else if (result.status === "created") {
    console.log(`Initialized Orbit board at ${result.registryRow?.db_path ?? "(unknown path)"}`);
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
    closeConnection,
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
    const db = openConnection(registryRow.db_path);
    try {
      backupBoardDatabase(registryRow, db, "pre-cli-reset");
    } catch (error) {
      throw resetBusyError(error, projectRoot);
    } finally {
      closeConnection(registryRow.db_path);
    }
  }
  if (registryRow) backupRegistry("pre-cli-reset");

  try {
    // Remove the board database. With central storage the db lives outside the
    // project directory; with legacy in-repo storage it is inside orbitDir below.
    const isCentralDb = registryRow && !registryRow.db_path.startsWith(projectRoot + "/");
    if (isCentralDb && existsSync(registryRow.db_path)) {
      const boardDir = dirname(registryRow.db_path);
      rmSync(boardDir, { recursive: true, force: true });
      removed.push(boardDir);
    }

    // Remove central dispatch-runs for this board.
    if (registryRow) {
      const dispatchRunsDir = join(DATA_DIR, "dispatch-runs", registryRow.slug);
      if (existsSync(dispatchRunsDir)) {
        rmSync(dispatchRunsDir, { recursive: true, force: true });
        removed.push(dispatchRunsDir);
      }
    }

    // Remove the in-repo .orbit/ directory (covers legacy db, residual dispatch-runs, etc.).
    if (existsSync(orbitDir)) {
      rmSync(orbitDir, { recursive: true, force: true });
      removed.push(orbitDir);
    }
    if (existsSync(skillMd)) {
      unlinkSync(skillMd);
      removed.push(skillMd);
    }
    const agentsCleanup = removeOrbitAgentsSection(projectRoot);
    if (agentsCleanup.removed) {
      removed.push(`${agentsCleanup.path} Orbit section`);
    } else if (!agentsCleanup.ok) {
      console.warn(`Warning: skipped AGENTS.md cleanup (${agentsCleanup.reason}) in ${agentsCleanup.path}`);
    }
  } catch (error) {
    throw resetBusyError(error, projectRoot);
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
  process.env.ORBIT_SYNC_MANAGED_SKILL_ORBIT = "1";
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

async function runDispatch(options) {
  if (options.help) {
    printUsage();
    return;
  }
  process.env.PROJECT_ROOT = resolve(options.cwd);
  const { dispatchTicket } = await import("../core/dispatch.js");
  const result = dispatchTicket(options);
  if (result.dry_run) {
    console.log(`Dry run: would dispatch ticket #${result.ticket.number} ${result.ticket.title}`);
    console.log(`Board: ${result.board.slug}`);
    console.log(`Profile: ${result.profile}`);
    console.log(`Mode: ${result.no_spawn ? "prepare-only" : "spawn"}`);
    console.log("No files, worktrees, ticket fields, comments, or agents were changed.");
    return;
  }
  console.log(`Dispatch ${result.spawned ? "started" : "prepared"}: ${result.run_id}`);
  console.log(`Board: ${result.board.slug}`);
  console.log(`Ticket: #${result.ticket.number} ${result.ticket.title}`);
  console.log(`Profile: ${result.profile}`);
  console.log(`Policy: ${result.policy}`);
  console.log(`Worktree: ${result.worktree_path}`);
  if (result.branch) console.log(`Branch: ${result.branch}`);
  if (result.run_record_path) console.log(`Run record: ${result.run_record_path}`);
  if (result.pid) console.log(`PID: ${result.pid}`);
  console.log("AI Written-Plan updated with the generated handoff.");
  console.log("Run record comment added to the ticket.");
  if (result.no_spawn) console.log("No agent spawned; ticket state left unchanged.");
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
    } else if (args.command === "dispatch") {
      await runDispatch(args);
    } else if (args.command === "version") {
      printVersion();
    } else {
      printUsage();
      process.exitCode = args.command === "help" && !args.invalid ? 0 : 1;
    }
  } catch (err) {
    console.error(err?.message || err);
    process.exitCode = 1;
  }
}

await main();
await new Promise((resolvePromise) => process.stdout.write("", resolvePromise));
await new Promise((resolvePromise) => process.stderr.write("", resolvePromise));
