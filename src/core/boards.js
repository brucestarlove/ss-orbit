import { getRegistry, tx } from "./db.js";
import { boardById } from "./queries.js";
import {
  computeNewBoardDbPath,
  ensureBoardDbFileAndSchema,
  insertBoard,
  updateBoardMeta
} from "./registry.js";
import { requireBoardAccess, requirePermission } from "./auth.js";
import { recordEvent } from "./events.js";
import { buildBoardFromRepo } from "./seed.js";
import { httpError, id, now, normalizePath, normalizeProjectEntryType, requiredString, slugify } from "./util.js";
import { DATA_DIR, MCP_SERVER_PATH, ROOT_DIR } from "./paths.js";

/** Create a brand-new board on disk + register it. Does not require an
 *  existing ctx.board / ctx.db: this is registry-only. */
export function createBoard(body, ctx) {
  const { actor } = ctx;
  requirePermission(actor, "owner");

  const name = requiredString(body.name, "name");
  const slug = slugify(body.slug || name);
  const repoPath = normalizePath(requiredString(body.repo_path || body.system_path, "repo_path"));
  const reg = getRegistry();
  if (reg.prepare("SELECT id FROM boards WHERE slug = ?").get(slug)) {
    throw httpError(409, "board_slug_taken");
  }

  const dbPath = computeNewBoardDbPath(repoPath, slug);
  const db = ensureBoardDbFileAndSchema(dbPath);

  const boardId = id();
  const time = now();
  const sniff = buildBoardFromRepo(repoPath);

  const defaultStates = body.states || [
    ["Backlog", null],
    ["Todo", null],
    ["In Progress", "in_progress"],
    ["Review", "review"],
    ["Done", "done"],
    ["Cancelled", null]
  ];

  // Board row + lanes + creation event land atomically in the board DB. The
  // registry insert below is a different database (can't share this
  // transaction); syncRegistryFromBoardDb repairs it idempotently if that
  // second write is ever lost.
  tx(db, () => {
    db.prepare(
      `INSERT INTO boards
       (id, slug, name, repo_url, system_path, default_branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      boardId,
      slug,
      name,
      body.repo_url || sniff.repoUrl || "",
      repoPath,
      body.default_branch || sniff.defaultBranch || "main",
      time,
      time
    );

    defaultStates.forEach(([stateName, role], position) => {
      db.prepare(
        `INSERT INTO states
         (id, board_id, name, position, is_default, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id(), boardId, stateName, position, stateName === "Todo" ? 1 : 0, role || null, time);
    });

    recordEvent(db, boardId, "board_created", null, actor.name, { board_id: boardId, slug });
  });

  insertBoard({
    id: boardId,
    slug,
    name,
    repo_path: repoPath,
    db_path: dbPath,
    repo_url: body.repo_url || sniff.repoUrl || "",
    default_branch: body.default_branch || sniff.defaultBranch || "main",
    last_active_at: time,
    created_at: time,
    updated_at: time
  });

  return boardById(db, boardId);
}

const AGENT_LANES = [
  { name: "AI Ready", role: "ai_ready" },
  { name: "In Progress", role: "in_progress" },
  { name: "Review", role: "review" }
];

/** Ensure the three role-bearing lanes that agent flow depends on
 *  (ai_ready / in_progress / review) exist on the board. Missing lanes are
 *  appended at the end of the lane order. Idempotent. */
export function ensureAgentLanes(db, boardId) {
  const time = now();
  for (const lane of AGENT_LANES) {
    const existing = db
      .prepare("SELECT id FROM states WHERE board_id = ? AND role = ?")
      .get(boardId, lane.role);
    if (existing) continue;
    const maxPosition = db
      .prepare("SELECT MAX(position) AS value FROM states WHERE board_id = ?")
      .get(boardId).value;
    db.prepare(
      `INSERT INTO states
       (id, board_id, name, position, is_default, role, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    ).run(id(), boardId, lane.name, Number(maxPosition || 0) + 1, lane.role, time);
  }
}

export function enableAiCollaboration(db, boardId, options = {}) {
  const innerBoard = boardById(db, boardId);
  if (!innerBoard) throw httpError(404, "board_not_found");

  const time = now();
  tx(db, () => {
    db.prepare("UPDATE boards SET ai_enabled = 1, updated_at = ? WHERE id = ?").run(time, boardId);
    ensureAgentLanes(db, boardId);

    if (options.stageOnboardingTicket) {
      const aiReadyLane = db.prepare("SELECT id FROM states WHERE board_id = ? AND role = 'ai_ready'").get(boardId);
      if (aiReadyLane) {
        db.prepare(
          `UPDATE tickets
           SET state_id = ?, updated_at = ?
           WHERE board_id = ?
             AND number = 12
             AND title = 'Try Orbit MCP on this ticket'`
        ).run(aiReadyLane.id, time, boardId);
      }
    }

    recordEvent(db, boardId, "ai_enabled", null, options.actor || "system", { board_id: boardId });
  });
  return boardById(db, boardId);
}

export function updateBoard(boardId, body, ctx) {
  const { db, board, actor } = ctx;
  if (boardId !== board.id) throw httpError(404, "board_not_found");
  const innerBoard = boardById(db, boardId);
  if (!innerBoard) throw httpError(404, "board_not_found");
  requireBoardAccess(actor, innerBoard);
  requirePermission(actor, "write");

  const allowed = [
    "name",
    "repo_url",
    "system_path",
    "default_branch",
    "project_notes",
    "agent_instructions"
  ];
  const sets = [];
  const values = [];

  for (const field of allowed) {
    if (body[field] !== undefined) {
      sets.push(`${field} = ?`);
      values.push(String(body[field] ?? ""));
    }
  }

  const aiTurningOn = body.ai_enabled !== undefined && Boolean(body.ai_enabled);
  if (body.ai_enabled !== undefined) {
    sets.push("ai_enabled = ?");
    values.push(body.ai_enabled ? 1 : 0);
  }

  if (sets.length === 0) return innerBoard;
  sets.push("updated_at = ?");
  values.push(now(), boardId);
  tx(db, () => {
    db.prepare(`UPDATE boards SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    if (aiTurningOn) ensureAgentLanes(db, boardId);
    recordEvent(db, boardId, "board_updated", null, actor.name, { board_id: boardId, fields: Object.keys(body) });
  });

  // Mirror the changed fields into the registry row so cross-board listings
  // stay coherent without needing a second source of truth.
  const after = boardById(db, boardId);
  updateBoardMeta(boardId, {
    name: after.name,
    repo_url: after.repo_url,
    default_branch: after.default_branch,
    repo_path: normalizePath(after.system_path || "")
  });

  return after;
}

export function getBoardContext(boardId, ctx, options = {}) {
  const { db, board, actor } = ctx;
  if (boardId !== board.id) throw httpError(404, "board_not_found");
  const innerBoard = boardById(db, boardId);
  if (!innerBoard) throw httpError(404, "board_not_found");
  requireBoardAccess(actor, innerBoard);
  return boardManual(boardId, ctx, options);
}

export function boardManual(boardId, ctx, options = {}) {
  const { db } = ctx;
  const innerBoard = boardById(db, boardId);
  if (!innerBoard) throw httpError(404, "board_not_found");
  const includeStruck = Boolean(options.includeStruck);
  const allEntries = db
    .prepare("SELECT * FROM board_entries WHERE board_id = ? ORDER BY created_at DESC")
    .all(boardId);
  const activeEntries = allEntries.filter((entry) => !entry.struck_at);
  const entries = includeStruck ? allEntries : activeEntries;
  return {
    board: {
      id: innerBoard.id,
      slug: innerBoard.slug,
      name: innerBoard.name,
      repo_url: innerBoard.repo_url,
      system_path: innerBoard.system_path || ctx.board.repo_path || "",
      default_branch: innerBoard.default_branch,
      project_notes: innerBoard.project_notes,
      agent_instructions: innerBoard.agent_instructions,
      ai_enabled: innerBoard.ai_enabled,
      created_at: innerBoard.created_at,
      updated_at: innerBoard.updated_at
    },
    entries,
    deployment: {
      app_root: ROOT_DIR,
      system_path: innerBoard.system_path || ctx.board.repo_path || "",
      data_dir: DATA_DIR,
      mcp_server_path: MCP_SERVER_PATH,
      db_path: ctx.board.db_path
    }
  };
}

export function createBoardEntry(boardId, body, ctx) {
  const { db, board, actor } = ctx;
  if (boardId !== board.id) throw httpError(404, "board_not_found");
  const innerBoard = boardById(db, boardId);
  if (!innerBoard) throw httpError(404, "board_not_found");
  requireBoardAccess(actor, innerBoard);
  requirePermission(actor, "write");

  const entryType = normalizeProjectEntryType(body.type);
  const entryTitle = requiredString(body.title, "title");
  return tx(db, () => {
    const entry = insertBoardEntry(
      db,
      boardId,
      entryType,
      entryTitle,
      body.body || "",
      actor.name,
      body.ticket_id || null
    );
    recordEvent(db, boardId, "board_entry_created", body.ticket_id || null, actor.name, {
      board_id: boardId,
      entry_id: entry.id,
      type: entry.type
    });
    return entry;
  });
}

export function updateBoardEntry(entryId, body, ctx) {
  const { db, board, actor } = ctx;
  const entry = db.prepare("SELECT * FROM board_entries WHERE id = ?").get(entryId);
  if (!entry || entry.board_id !== board.id) throw httpError(404, "board_entry_not_found");

  const innerBoard = boardById(db, entry.board_id);
  if (!innerBoard) throw httpError(404, "board_not_found");
  requireBoardAccess(actor, innerBoard);
  requirePermission(actor, "write");

  const shouldStrike = Boolean(body.struck);
  const struckAt = shouldStrike ? entry.struck_at || now() : null;
  const updatedAt = now();
  return tx(db, () => {
    db.prepare("UPDATE board_entries SET struck_at = ?, updated_at = ? WHERE id = ?").run(struckAt, updatedAt, entryId);
    const updated = db.prepare("SELECT * FROM board_entries WHERE id = ?").get(entryId);
    recordEvent(
      db,
      entry.board_id,
      shouldStrike ? "board_entry_struck" : "board_entry_restored",
      entry.ticket_id || null,
      actor.name,
      { board_id: entry.board_id, entry_id: entry.id, type: entry.type }
    );
    return updated;
  });
}

export function insertBoardEntry(db, boardId, type, title, body, createdBy, ticketId = null) {
  const entryId = id();
  const time = now();
  db.prepare(
    `INSERT INTO board_entries
     (id, board_id, type, title, body, ticket_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(entryId, boardId, normalizeProjectEntryType(type), title, body || "", ticketId, createdBy, time, time);
  return db.prepare("SELECT * FROM board_entries WHERE id = ?").get(entryId);
}
