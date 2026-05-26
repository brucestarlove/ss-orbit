import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { localOwnerActor } from "./auth.js";
import { DISPATCH_RUNS_DIR } from "./paths.js";
import { getContextPackFull } from "./agent.js";
import { openBoardDb, getBoardByRegistryId, getBoardByRepoPath, getBoardBySlug, touchBoardActive } from "./registry.js";
import { stateByName, stateByRole, ticketById, ticketByNumber, unresolvedBlockers } from "./queries.js";
import { createRegistrySchema } from "./db.js";
import { createComment, updateTicket } from "./tickets.js";
import { id, normalizePath, slugify } from "./util.js";

const DEFAULT_POLICY = "agent-safe";
const DEFAULT_VERIFICATION_COMMANDS = [
  "npm test",
  "npm run build (when public/ or browser bundle assets change)",
  "node src/cli/orbit.js dispatch --help",
  "git diff --check",
  "git diff --cached --check before commit"
];

function shortId() {
  return id().replace(/-/g, "").slice(0, 10);
}

function cleanName(value, fallback = "agent") {
  const cleaned = slugify(String(value || fallback)).replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function resolveBoard(options) {
  if (options.board) {
    const row = getBoardByRegistryId(options.board) || getBoardBySlug(options.board);
    if (!row) throw new Error(`Board not found: ${options.board}`);
    return row;
  }
  const cwd = normalizePath(resolve(options.cwd));
  const row = getBoardByRepoPath(cwd);
  if (!row) throw new Error(`No Orbit board registered for ${cwd}; pass --board <slug-or-id>.`);
  return row;
}

function resolveTicket(db, boardId, ticketRef) {
  if (ticketRef === undefined || ticketRef === null || ticketRef === "") {
    throw new Error("--ticket <number-or-id> is required");
  }
  const text = String(ticketRef);
  const byNumber = /^\d+$/.test(text) ? ticketByNumber(db, boardId, Number(text)) : null;
  const ticket = byNumber || ticketById(db, text);
  if (!ticket || ticket.board_id !== boardId) throw new Error(`Ticket not found on board: ${ticketRef}`);
  if (ticket.archived_at) throw new Error(`Ticket #${ticket.number} is archived and cannot be dispatched.`);
  return ticket;
}

function remoteDispatchError(options) {
  if (!options.remote && !options.serverUrl) return null;
  const target = options.serverUrl ? ` (${options.serverUrl})` : "";
  return [
    `Remote dispatch is not supported by the local CLI path yet${target}.`,
    "`orbit dispatch` currently mutates a board through the local registry and SQLite board file only.",
    "Run it on the board host without --server-url/--remote, or use remote MCP/manual orchestration for hosted boards."
  ].join("\n");
}

function resolveExecutable(command) {
  const executable = command || "hermes";
  if ((executable.includes("/") || executable.includes("\\")) && existsSync(executable)) return executable;
  const result = spawnSync("sh", ["-lc", `command -v ${q(executable)}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function resolveCommandSpec(command) {
  const executable = resolveExecutable(command);
  if (!executable) return null;
  if (process.platform === "win32" && existsSync(executable)) {
    const extension = extname(executable).toLowerCase();
    if (!extension || extension === ".js") {
      try {
        const firstLine = readFileSync(executable, "utf8").split(/\r?\n/, 1)[0] || "";
        if (/^#!.*\bnode\b/i.test(firstLine)) {
          return { command: process.execPath, argsPrefix: [executable], display: executable };
        }
      } catch {
        // Fall through to direct execution for non-text executables.
      }
    }
  }
  return { command: executable, argsPrefix: [], display: executable };
}

function preflightHermes(options, profile) {
  const hermes = resolveCommandSpec(options.hermesBin || "hermes");
  if (!hermes) {
    throw new Error(
      `Hermes binary not found: ${options.hermesBin || "hermes"}. Install Hermes or pass --hermes-bin <path>. ` +
        "For prepare-only handoff without spawning, rerun with --no-spawn."
    );
  }
  const result = spawnSync(hermes.command, [...hermes.argsPrefix, "-p", profile, "--help"], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`Hermes preflight failed for profile ${profile}: ${result.error.message}. Try --no-spawn for prepare-only.`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `Hermes preflight failed for profile ${profile}${detail ? `: ${detail}` : ""}. ` +
        "Check the profile name or rerun with --no-spawn for prepare-only."
    );
  }
  return hermes;
}

function resolveRepoRoot(options, boardRow) {
  const cwd = normalizePath(resolve(options.cwd));
  if (options.cwdProvided || existsSync(join(cwd, ".git"))) return cwd;
  if (boardRow.repo_path && existsSync(join(boardRow.repo_path, ".git"))) return boardRow.repo_path;
  return cwd;
}

function commandOutput(command, args, options = {}) {
  const executable = command === "git" ? findExecutable("git") || command : command;
  const result = spawnSync(executable, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `\n${detail}` : ""}`);
  }
  return String(result.stdout || "").trim();
}

function optionalCommandOutput(command, args, options = {}) {
  try {
    return commandOutput(command, args, options);
  } catch {
    return "";
  }
}

function normalizeVerificationCommands(commands) {
  const values = Array.isArray(commands) ? commands : commands ? [commands] : [];
  const cleaned = values.map((value) => String(value || "").trim()).filter(Boolean);
  return cleaned.length ? cleaned : [...DEFAULT_VERIFICATION_COMMANDS];
}

const REDACTED_URL_PRESENT = "[redacted-url-present]";
const URL_ENV_KEYS = new Set(["ORBIT_API_URL", "ORBIT_SERVER_URL"]);

function sanitizeUrlBearingValue(value) {
  if (value === undefined || value === null || value === "") return "";
  return REDACTED_URL_PRESENT;
}

function sanitizeEnvironmentValue(key, value) {
  if (URL_ENV_KEYS.has(key)) return sanitizeUrlBearingValue(value);
  return value;
}

function collectEnvironmentVariance() {
  const envKeys = ["HOME", "PROJECT_ROOT", "DATA_DIR", "ORBIT_MODE", "ORBIT_API_URL", "ORBIT_DEFAULT_BOARD", "ORBIT_SERVER_URL"];
  const env = {};
  for (const key of envKeys) {
    if (process.env[key] !== undefined) env[key] = sanitizeEnvironmentValue(key, process.env[key]);
  }
  return {
    platform: process.platform,
    node: process.version,
    cwd: process.cwd(),
    path_format: process.platform === "win32" ? "windows" : "posix",
    env
  };
}

function buildRunRecordJson({
  runId,
  status,
  boardRow,
  ticket,
  profile,
  policyName,
  repoRoot,
  worktreePath,
  branchName,
  baseCommit,
  handoffPath,
  policyBin,
  child,
  hermesArgs,
  verificationCommands,
  options,
  serverUrl,
  environmentVariance
}) {
  return {
    schema: "orbit.dispatch.run.v1",
    run_id: runId,
    ticket_id: ticket.id,
    ticket_number: ticket.number,
    board_id: boardRow.id,
    board_slug: boardRow.slug,
    profile,
    prompt_path: handoffPath,
    worktree: worktreePath || repoRoot,
    repo_root: repoRoot,
    branch: branchName || optionalCommandOutput("git", ["-C", repoRoot, "branch", "--show-current"]),
    base_commit: baseCommit,
    process_id: child?.pid || null,
    policy: policyName || "none",
    status,
    verification_commands: verificationCommands,
    commit_shas: [],
    residual_risks: [],
    server_url: sanitizeUrlBearingValue(serverUrl),
    mode: options.noSpawn ? "prepare-only" : "spawn",
    command: `${options.hermesBin || "hermes"} ${hermesArgs.map((arg) => (arg.includes(" ") ? q(arg) : arg)).join(" ")}`,
    created_at: new Date().toISOString(),
    environment_variance: environmentVariance
  };
}

function findExecutable(name) {
  const filteredPath = String(process.env.PATH || "")
    .split(process.platform === "win32" ? ";" : ":")
    .filter((entry) => entry && !/(^|[/\\])policy-bin$/i.test(entry))
    .join(process.platform === "win32" ? ";" : ":");
  const result = spawnSync("sh", ["-lc", `command -v ${name}`], { encoding: "utf8", env: { ...process.env, PATH: filteredPath } });
  return result.status === 0 ? result.stdout.trim() : "";
}

function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function createWrapper(path, content) {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function createWindowsCmdWrapper(path, blockedMessage) {
  writeFileSync(
    `${path}.cmd`,
    `@echo off\r\necho ${blockedMessage} 1>&2\r\nexit /b 126\r\n`,
    "utf8"
  );
  chmodSync(`${path}.cmd`, 0o755);
}

function createPolicyBin(runDir, policyName) {
  if (!policyName || policyName === "none") return null;
  const binDir = join(runDir, "policy-bin");
  mkdirSync(binDir, { recursive: true });

  const realGit = findExecutable("git") || "/usr/bin/git";
  const realNpm = findExecutable("npm") || "/usr/bin/npm";
  const realPnpm = findExecutable("pnpm") || "/usr/bin/pnpm";
  const realYarn = findExecutable("yarn") || "/usr/bin/yarn";
  const realRm = findExecutable("rm") || "/usr/bin/rm";

  createWrapper(
    join(binDir, "git"),
    `#!/bin/sh
cmd="\${1:-}"
shift 2>/dev/null || true
block() {
  echo "Blocked by Orbit ${policyName} policy: git $cmd $*" >&2
  exit 126
}
case "$cmd" in
  status|diff|log|show|add|rev-parse|describe|ls-files|grep|merge-base)
    exec ${q(realGit)} "$cmd" "$@"
    ;;
  commit)
    for arg in "$@"; do
      case "$arg" in --amend|--fixup=*|--squash=*) block "$@" ;; esac
    done
    exec ${q(realGit)} "$cmd" "$@"
    ;;
  branch)
    for arg in "$@"; do
      case "$arg" in -d|-D|--delete|-m|-M|--move) block "$@" ;; esac
    done
    exec ${q(realGit)} "$cmd" "$@"
    ;;
  push|reset|clean|rebase|merge|checkout|switch|restore|tag|cherry-pick|worktree)
    block "$@"
    ;;
  *)
    echo "Blocked by Orbit ${policyName} policy: git $cmd (allowed: status, diff, log, show, add, commit, safe branch inspection/creation, rev-parse, describe, ls-files, grep, merge-base)" >&2
    exit 126
    ;;
esac
`
  );
  if (process.platform === "win32") {
    createWindowsCmdWrapper(join(binDir, "git"), `Blocked by Orbit ${policyName} policy: git %~1`);
  }

  const packageWrapper = (realCommand, name) => `#!/bin/sh
cmd="\${1:-}"
script="\${2:-}"
case "$cmd" in
  test)
    exec ${q(realCommand)} "$@"
    ;;
  run)
    case "$script" in
      test|test:*|build|build:*|lint|lint:*|check|check:*|typecheck|typecheck:*)
        exec ${q(realCommand)} "$@"
        ;;
    esac
    ;;
  publish|version|deploy|release)
    echo "Blocked by Orbit ${policyName} policy: ${name} $cmd" >&2
    exit 126
    ;;
esac
echo "Blocked by Orbit ${policyName} policy: ${name} $cmd (allowed package commands: test, run test/build/lint/check/typecheck)" >&2
exit 126
`;

  createWrapper(join(binDir, "npm"), packageWrapper(realNpm, "npm"));
  createWrapper(join(binDir, "pnpm"), packageWrapper(realPnpm, "pnpm"));
  createWrapper(join(binDir, "yarn"), packageWrapper(realYarn, "yarn"));
  if (process.platform === "win32") {
    createWindowsCmdWrapper(join(binDir, "npm"), `Blocked by Orbit ${policyName} policy: npm %1 (allowed package commands: test)`);
    createWindowsCmdWrapper(join(binDir, "pnpm"), `Blocked by Orbit ${policyName} policy: pnpm %1 (allowed package commands: test)`);
    createWindowsCmdWrapper(join(binDir, "yarn"), `Blocked by Orbit ${policyName} policy: yarn %1 (allowed package commands: test)`);
  }

  createWrapper(
    join(binDir, "docker"),
    `#!/bin/sh
echo "Blocked by Orbit ${policyName} policy: Docker requires explicit human approval." >&2
exit 126
`
  );
  if (process.platform === "win32") {
    createWindowsCmdWrapper(join(binDir, "docker"), `Blocked by Orbit ${policyName} policy: Docker requires explicit human approval.`);
  }

  for (const name of ["kubectl", "vercel", "netlify", "fly", "railway", "scp", "rsync", "ssh", "sudo", "gh", "curl", "wget", "aws", "gcloud", "az"]) {
    createWrapper(
      join(binDir, name),
      `#!/bin/sh
echo "Blocked by Orbit ${policyName} policy: ${name} is outside this autonomous run." >&2
exit 126
`
    );
  }

  createWrapper(
    join(binDir, "rm"),
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    -r|-R|-f|-rf|-fr|-Rf|-fR|--recursive|--force)
      echo "Blocked by Orbit ${policyName} policy: recursive/force rm requires human approval." >&2
      exit 126
      ;;
  esac
done
exec ${q(realRm)} "$@"
`
  );

  return binDir;
}

function buildHandoff({ boardRow, context, profile, repoRoot, worktreePath, branchName, baseCommit, policyName, runId, serverUrl, verificationCommands }) {
  const { ticket, board, board_manual: manual, parent_ticket: parent, child_tickets: children, blockers } = context;
  const boardEntries = (manual.entries || [])
    .slice(0, 12)
    .map((entry) => `- ${entry.type}: ${entry.title}\n  ${entry.body}`)
    .join("\n");
  const blockerText = blockers.length
    ? blockers.map((blocker) => `- #${blocker.number} ${blocker.title} (${blocker.state_name})`).join("\n")
    : "None.";
  const childText = children.length
    ? children.map((child) => `- #${child.number} ${child.title} (${child.state_name})`).join("\n")
    : "None.";
  const verificationText = verificationCommands.map((command) => `- ${command}`).join("\n");

  return `# Orbit Agent Handoff

Run ID: ${runId}
Agent profile: ${profile}
Board: ${board.slug} — ${board.name}
Ticket: #${ticket.number} — ${ticket.title}
Ticket id: ${ticket.id}
Ticket type: ${ticket.type}
Initial state: ${ticket.state_name}
Repository root: ${repoRoot}
Worktree: ${worktreePath || repoRoot}
Branch: ${branchName || "current branch"}
Base commit: ${baseCommit || "unknown"}
${serverUrl ? `Orbit server: ${serverUrl}` : ""}

## Mission
Implement the ticket faithfully. Treat this ticket as the source of truth for communication between the human, orchestrator, and dispatched agent.

## Read first
1. AGENTS.md in the repository.
2. SKILL-ORBIT.md in the repository.
3. This AI Written-Plan handoff.
4. The ticket description, implementation fields, blockers, parent/child cards, and board journal entries below.

## Ticket description
${ticket.description || "(No description.)"}

## Implementation records
AI Written-Plan: ${ticket.ai_plan || "(Empty.)"}

AI Implementation Summary: ${ticket.implementation_summary || "(Empty.)"}

Implementation Updates/Lessons: ${ticket.implementation_updates || "(Empty.)"}

## Board agent instructions
${board.agent_instructions || "(No board-level agent instructions.)"}

## Board notes
${board.project_notes || "(No board notes.)"}

## Board journal: lessons and decisions
Board journal entries are project constraints and lessons, not persona or roleplay instructions. Apply them only when they clarify architecture, workflow, product boundaries, or reusable pitfalls.

${boardEntries || "(No active board journal entries.)"}

## Parent ticket
${parent ? `#${parent.number} ${parent.title} (${parent.state_name})` : "None."}

## Child tickets
${childText}

## Unresolved blockers
${blockerText}

## Scope boundaries
- Keep changes local to this repository/worktree.
- Do not push, deploy, publish, or open/merge PRs.
- Do not run Docker unless the human operator explicitly approves it outside this autonomous run.
- Do not expose secrets, tokens, credentials, private keys, or connection strings.
- Prefer small, reviewable commits.

## Autonomous policy: ${policyName}
Allowed without asking: read/search files, inspect git status/diff/log, edit files for this ticket, run package test/build/lint/check/typecheck commands, and create a local git commit.
Blocked or requires explicit human approval: Docker, git push, deploy/publish/release commands, destructive git operations (reset/clean/rebase/force checkout/worktree removal), package install/publish/version commands, recursive/force filesystem deletion, SSH/SCP/rsync, cloud CLIs, GitHub CLI, direct curl/wget network calls, sudo, and secret exfiltration.

## Declared verification commands
Run the commands that apply before handoff. If a conditional command does not apply, say why in Implementation Updates.

${verificationText}

## Environment variance checklist
- HOME / DATA_DIR / PROJECT_ROOT / ORBIT_* inherited env vars
- Existing local board DB/files and central registry state
- Port availability when touching serve/SSE/API flows
- OS path format and shell differences
- Accidental use of real user state in tests or dispatch artifacts

## Completion protocol
When done:
1. Run the relevant automated tests and any focused manual/API sanity checks.
2. Commit the work locally on the dispatch branch.
3. Update the ticket's AI Implementation Summary with what changed, commit SHA, branch/worktree, verification, and manual checks still needed.
4. Add Implementation Updates/Lessons for pitfalls, remediation, or future-agent guidance.
5. Add a completion comment/run record on the ticket.
6. Move the ticket to Review, not Done, unless the human operator explicitly requested auto-completion.
`;
}

function buildShortPrompt({ boardRow, ticket, profile, serverUrl }) {
  return [
    `You are ${profile}, dispatched by Orbit.`,
    `Work board ${boardRow.slug}, ticket #${ticket.number}: ${ticket.title}.`,
    "Read AGENTS.md and SKILL-ORBIT.md in this repository first.",
    "The full generated handoff is stored on the ticket in AI Written-Plan; treat the Orbit ticket as source of truth.",
    serverUrl ? `Orbit server URL: ${serverUrl}` : "Use local Orbit/MCP/API access available from this repo.",
    "Follow the autonomous policy in the handoff. Do not push, deploy, publish, run Docker, or expose secrets.",
    "When complete, commit locally, update AI Implementation Summary/Implementation Updates on the ticket, comment the run record, and move the ticket to Review."
  ].join("\n");
}

function ensureWorktree({ repoRoot, boardSlug, ticketNumber, profile, branchName, worktreePath }) {
  commandOutput("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"]);
  const runBranch = branchName || `orbit/${cleanName(boardSlug)}-${ticketNumber}-${cleanName(profile)}-${shortId()}`;
  const runWorktree = worktreePath || join(repoRoot, ".worktrees", `${cleanName(boardSlug)}-${ticketNumber}-${cleanName(profile)}-${shortId()}`);
  mkdirSync(resolve(runWorktree, ".."), { recursive: true });
  if (!existsSync(runWorktree)) {
    commandOutput("git", ["-C", repoRoot, "worktree", "add", "-b", runBranch, runWorktree, "HEAD"]);
  }
  return { branchName: runBranch, worktreePath: runWorktree };
}

export function dispatchTicket(options) {
  const remoteError = remoteDispatchError(options);
  if (remoteError) throw new Error(remoteError);

  const profile = options.profile || "agent";
  const policyName = options.policy === undefined ? DEFAULT_POLICY : options.policy;
  const verificationCommands = normalizeVerificationCommands(options.verifyCommands);
  createRegistrySchema();
  const actor = localOwnerActor();
  const boardRow = resolveBoard(options);
  const db = openBoardDb(boardRow);
  const ctx = { actor, board: boardRow, db };

  const ticket = resolveTicket(db, boardRow.id, options.ticket);
  const blockers = unresolvedBlockers(db, ticket.id);
  if (blockers.length && !options.force) {
    throw new Error(`Ticket #${ticket.number} is blocked: ${blockers.map((b) => `#${b.number} ${b.title}`).join(", ")}`);
  }

  const repoRoot = resolveRepoRoot(options, boardRow);
  const inProgress = stateByRole(db, boardRow.id, "in_progress") || stateByName(db, boardRow.id, "In Progress");
  if (!options.noSpawn && !options.dryRun && !inProgress) throw new Error("Board is missing an In Progress state.");

  if (options.dryRun) {
    return {
      dry_run: true,
      no_spawn: Boolean(options.noSpawn),
      run_id: null,
      board: { id: boardRow.id, slug: boardRow.slug, name: boardRow.name },
      ticket: { id: ticket.id, number: ticket.number, title: ticket.title },
      profile,
      policy: policyName || "none",
      repo_root: repoRoot,
      worktree_path: repoRoot,
      branch: options.branch || "",
      handoff_path: null,
      policy_bin: null,
      pid: null,
      spawned: false,
      prompt: "",
      run_record: "",
      run_record_path: null,
      verification_commands: verificationCommands
    };
  }

  const hermesExecutable = options.noSpawn ? null : preflightHermes(options, profile);
  const runId = `orbit-${ticket.number}-${profile}-${shortId()}`;
  const runDir = join(DISPATCH_RUNS_DIR, boardRow.slug, runId);
  const serverUrl = options.serverUrl || process.env.ORBIT_SERVER_URL || "";
  const displayServerUrl = sanitizeUrlBearingValue(serverUrl);
  const baseCommit = optionalCommandOutput("git", ["-C", repoRoot, "rev-parse", "HEAD"]);
  const environmentVariance = collectEnvironmentVariance();
  let branchName = options.branch || "";
  let worktreePath = "";

  if (options.worktree) {
    const worktree = ensureWorktree({
      repoRoot,
      boardSlug: boardRow.slug,
      ticketNumber: ticket.number,
      profile,
      branchName: options.branch,
      worktreePath: options.worktreePath
    });
    branchName = worktree.branchName;
    worktreePath = worktree.worktreePath;
  }

  mkdirSync(runDir, { recursive: true });
  const policyBin = createPolicyBin(runDir, policyName);
  const context = getContextPackFull(ticket.id, ctx, 1);
  const handoff = buildHandoff({
    boardRow,
    context,
    profile,
    repoRoot,
    worktreePath,
    branchName,
    baseCommit,
    policyName,
    runId,
    serverUrl: displayServerUrl,
    verificationCommands
  });
  const prompt = buildShortPrompt({ boardRow, ticket, profile, serverUrl: displayServerUrl });
  const handoffPath = join(runDir, "handoff.md");
  writeFileSync(handoffPath, handoff, "utf8");

  const hermesArgs = [];
  if (profile) hermesArgs.push("-p", profile);
  if (options.yolo) hermesArgs.push("--yolo");
  hermesArgs.push("chat", "-q", prompt);
  const runRecordPath = join(runDir, "run-record.json");
  const writeRunRecordFile = options.writeRunRecordFile || ((path, runRecordJson) => {
    writeFileSync(path, `${JSON.stringify(runRecordJson, null, 2)}\n`, "utf8");
  });
  const writeRunRecordJson = (status, childProcess = null) => {
    const runRecordJson = buildRunRecordJson({
      runId,
      status,
      boardRow,
      ticket,
      profile,
      policyName,
      repoRoot,
      worktreePath,
      branchName,
      baseCommit,
      handoffPath,
      policyBin,
      child: childProcess,
      hermesArgs,
      verificationCommands,
      options,
      serverUrl,
      environmentVariance
    });
    writeRunRecordFile(runRecordPath, runRecordJson);
    return runRecordJson;
  };

  let status = "prepared";
  writeRunRecordJson(status, null);

  touchBoardActive(boardRow.id);
  if (options.noSpawn) {
    updateTicket(ticket.id, { ai_plan: handoff }, ctx);
  } else {
    updateTicket(ticket.id, { ai_plan: handoff, state_id: inProgress.id }, ctx);
  }

  const cwd = worktreePath || repoRoot;
  const env = {
    ...process.env,
    ORBIT_DISPATCH_RUN_ID: runId,
    ORBIT_BOARD: boardRow.slug,
    ORBIT_TICKET: String(ticket.number),
    ORBIT_TICKET_ID: ticket.id,
    ORBIT_HANDOFF_PATH: handoffPath,
    ORBIT_AUTONOMOUS_POLICY: policyName || "none",
    ...(policyBin ? { PATH: `${policyBin}:${process.env.PATH || ""}` } : {})
  };

  let child = null;
  if (!options.noSpawn) {
    child = spawn(hermesExecutable.command, [...hermesExecutable.argsPrefix, ...hermesArgs], {
      cwd,
      env,
      detached: !options.foreground,
      stdio: options.foreground ? "inherit" : "ignore"
    });
    if (!options.foreground) child.unref();
    status = "launched";
    writeRunRecordJson(status, child);
  }

  const runRecord = [
    `Orbit dispatch run ${options.noSpawn ? "prepared" : "started"}.`,
    `- run_id: ${runId}`,
    `- profile: ${profile}`,
    `- status: ${status}`,
    `- policy: ${policyName || "none"}`,
    `- ticket: #${ticket.number} ${ticket.title}`,
    `- branch: ${branchName || "current branch"}`,
    `- base_commit: ${baseCommit || "unknown"}`,
    `- worktree: ${worktreePath || repoRoot}`,
    `- handoff: AI Written-Plan field${options.keepHandoffFile ? ` and ${handoffPath}` : ""}`,
    `- run_record_json: ${runRecordPath}`,
    `- policy_bin: ${policyBin || "none"}`,
    `- pid: ${child?.pid || "not spawned"}`,
    `- verification_commands: ${verificationCommands.join("; ")}`,
    `- command: ${options.hermesBin || "hermes"} ${hermesArgs.map((arg) => (arg.includes(" ") ? q(arg) : arg)).join(" ")}`,
    options.noSpawn ? "- mode: prepare-only; no agent spawned and ticket state left unchanged" : "- mode: spawned; ticket moved to In Progress"
  ].join("\n");

  createComment(ticket.id, { author: "orbit dispatch", kind: "agent_note", body: runRecord }, ctx);

  if (!options.keepHandoffFile) {
    // The canonical copy is the ticket's AI Written-Plan. Keep run metadata and
    // policy wrappers. Local-only agents may still use ORBIT_HANDOFF_PATH as a
    // bootstrap hint before they read the card, so leave the file in place.
  }

  return {
    dry_run: false,
    no_spawn: Boolean(options.noSpawn),
    run_id: runId,
    board: { id: boardRow.id, slug: boardRow.slug, name: boardRow.name },
    ticket: { id: ticket.id, number: ticket.number, title: ticket.title },
    profile,
    policy: policyName || "none",
    repo_root: repoRoot,
    worktree_path: worktreePath || repoRoot,
    branch: branchName || "",
    handoff_path: handoffPath,
    policy_bin: policyBin,
    pid: child?.pid || null,
    spawned: Boolean(child),
    prompt,
    run_record: runRecord,
    run_record_path: runRecordPath,
    verification_commands: verificationCommands
  };
}
