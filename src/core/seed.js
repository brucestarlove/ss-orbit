import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { addComment } from "./queries.js";
import { recordEvent } from "./events.js";
import { id, now, normalizeTicketType, slugify, titleize } from "./util.js";

/**
 * Seed a fresh per-board DB with the universal first-run profile. Caller
 * supplies the connection and the repo path the board lives in. Returns the
 * new board row, or null if the DB already had a board.
 */
export function seedIfEmpty(db, repoPath, options = {}) {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM boards").get().count;
  if (existing > 0) return null;

  const time = now();
  const boardId = id();
  const seed = buildBoardFromRepo(repoPath);

  db.exec("BEGIN;");
  try {
    db.prepare(
      `INSERT INTO boards
       (id, slug, name, repo_url, system_path, default_branch,
        project_notes, agent_instructions, ai_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      boardId,
      seed.boardSlug,
      seed.boardName,
      seed.repoUrl,
      seed.systemPath,
      seed.defaultBranch,
      seed.projectNotes,
      seed.agentInstructions,
      options.enableAi === false ? 0 : 1,
      time,
      time
    );

    const states = options.enableAi === false ? [
      ["Backlog", null],
      ["Todo", null],
      ["In Progress", "in_progress"],
      ["Review", "review"],
      ["Done", "done"],
      ["Cancelled", null]
    ] : [
      ["Backlog", null],
      ["Todo", null],
      ["AI Ready", "ai_ready"],
      ["In Progress", "in_progress"],
      ["Review", "review"],
      ["Done", "done"],
      ["Cancelled", null]
    ];
    const stateIds = new Map();
    states.forEach(([name, role], position) => {
      const stateId = id();
      stateIds.set(name, stateId);
      db.prepare(
        `INSERT INTO states
         (id, board_id, name, position, is_default, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(stateId, boardId, name, position, name === "Todo" ? 1 : 0, role, time);
    });

    // User-defined labels only at seed time.
    const labelIds = new Map();
    [
      ["human-only", "#7c2d12"],
      ["needs-human-input", "#dc2626"],
      ["needs-decomposition", "#9333ea"],
      ["needs-followup", "#b45309"],
      ["tech-debt", "#64748b"],
      ["security", "#991b1b"],
      ["onboarding", "#0f766e"]
    ].forEach(([name, color]) => {
      const labelId = id();
      labelIds.set(name, labelId);
      db.prepare(
        "INSERT INTO labels (id, board_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(labelId, boardId, name, color, time);
    });

    if (options.includeExamples) {
      const epicTicket = insertSeedTicket(db, boardId, 1, {
        title: `Onboard ${seed.boardName} into this board`,
        description:
          "First-run onboarding epic. Use this to turn the generic seed into a useful repo-specific project context and work queue.",
        type: "epic",
        aiPlan:
          "1. Fill Settings → AI (Agent Instructions) and Settings → Notes (Notes For You).\n2. Capture initial decisions and lessons in the Journal.\n3. Create the first real epic or AI-ready implementation ticket.",
        stateId: stateIds.get("Todo"),
        priority: 4,
        labels: [labelIds.get("human-only"), labelIds.get("needs-decomposition"), labelIds.get("onboarding")]
      });

      const firstTicket = insertSeedTicket(db, boardId, 2, {
        title: "Fill agent context & personal notes",
        description:
          "Open Settings → AI (Agent Instructions) and Settings → Notes, and add real project context plus your own reminders.",
        type: "feature",
        parentTicketId: epicTicket,
        stateId: stateIds.get("Todo"),
        priority: 3,
        labels: [labelIds.get("human-only"), labelIds.get("onboarding")]
      });

      insertSeedTicket(db, boardId, 3, {
        title: "Create the first real implementation ticket",
        description:
          "Create a focused feature, task, or bug card with acceptance criteria, labels, and enough context for an agent or human to execute.",
        type: "feature",
        parentTicketId: epicTicket,
        stateId: stateIds.get("Backlog"),
        priority: 1,
        labels: [labelIds.get("human-only"), labelIds.get("onboarding")]
      });

      // #12 is a stable “try the agent on this card” handle for docs and `orbit init` next steps (MCP + claim-next).
      insertSeedTicket(db, boardId, 12, {
        title: "Try Orbit MCP on this ticket",
        description:
          "After `orbit init` and registering MCP, ask your agent from this repo to use the Orbit MCP tools on ticket 12 (claim context, update fields, move lanes). Read SKILL-ORBIT.md first.",
        type: "task",
        stateId: stateIds.get("Backlog"),
        priority: 2,
        labels: [labelIds.get("onboarding")]
      });

      addComment(db, epicTicket, "system", "note", "Universal first-run seed. Delete or complete these onboarding cards once this board reflects the repo.");
      addComment(db, firstTicket, "system", "note", "Settings → AI: agent_instructions (ticket context). Settings → Notes: project_notes (you only).");
    }
    recordEvent(db, boardId, "seed", null, "system", { board: seed.boardSlug });
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }

  return db.prepare("SELECT * FROM boards WHERE id = ?").get(boardId);
}

function insertSeedTicket(db, boardId, number, ticket) {
  const ticketId = id();
  const time = now();
  db.prepare(
    `INSERT INTO tickets
     (id, board_id, number, title, description, type, parent_ticket_id, ai_plan,
      implementation_summary, implementation_updates, state_id, priority, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ticketId,
    boardId,
    number,
    ticket.title,
    ticket.description,
    normalizeTicketType(ticket.type || (ticket.parentTicketId ? "feature" : "task")),
    ticket.parentTicketId || null,
    ticket.aiPlan || "",
    ticket.implementationSummary || "",
    ticket.implementationUpdates || "",
    ticket.stateId,
    ticket.priority,
    "system",
    time,
    time
  );

  for (const labelId of ticket.labels || []) {
    db.prepare("INSERT OR IGNORE INTO ticket_labels (ticket_id, label_id) VALUES (?, ?)").run(ticketId, labelId);
  }
  return ticketId;
}

/** Sniff repo metadata for a new board (package.json, git, env). */
export function buildBoardFromRepo(projectRoot) {
  const packageInfo = readPackageInfo(projectRoot);
  const directoryName = basename(projectRoot);
  const boardName =
    readSeedValue("board_name") || titleize(packageInfo.name || directoryName || "My Board");
  const boardSlug = slugify(
    readSeedValue("board_slug") || packageInfo.name || boardName || "my-board"
  );
  const repoUrl = readSeedValue("repo_url") || gitValue(["config", "--get", "remote.origin.url"], projectRoot) || "";
  const systemPath = readSeedValue("system_path") || projectRoot;
  const defaultBranch =
    readSeedValue("default_branch") ||
    gitValue(["branch", "--show-current"], projectRoot) ||
    gitValue(["symbolic-ref", "--short", "HEAD"], projectRoot) ||
    "main";
  const defaultProjectNotes =
    "Personal reminders (Settings → Notes: Notes For You). Point yourself at SKILL-ORBIT.md, runbooks, or nudges for your tools.";
  return {
    boardName,
    boardSlug,
    repoUrl,
    systemPath,
    defaultBranch,
    projectNotes: readSeedValue("project_notes") || defaultProjectNotes,
    agentInstructions: readSeedValue("agent_instructions") || ""
  };
}

function readPackageInfo(root) {
  const path = join(root, "package.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function readSeedValue(key) {
  const envValue = process.env[key.toUpperCase()];
  if (typeof envValue === "string" && envValue.trim()) return envValue.trim();
  return "";
}

function gitValue(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000
    }).trim();
  } catch {
    return "";
  }
}
