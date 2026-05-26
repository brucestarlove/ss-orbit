// MCP server. One process = one session = (usually) one board, but the
// per-process board lives in a closure variable that every tool reads
// explicitly — never via a hidden global. Each tool builds its own ctx for
// the call it's about to make, so adding new tools never has to think about
// "active board" state.

import { createOrbitClient } from "./mcp/orbit-client.js";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  archivedTicketsForBoard,
  archiveTicket,
  checkpointTicket,
  claimNext,
  completeTicket,
  createBoardEntry,
  createComment,
  createTicket,
  deleteTicket,
  exportBoard,
  getBoardContext,
  getAgentDispatchPacket,
  getContextPack,
  readComments,
  readTicket,
  getTicketBlockers,
  getTicketRelations,
  localAgentActor,
  restoreTicket,
  searchTickets,
  updateBoard,
  updateTicket
} from "./core/board.js";
import { closeAllConnections, createBoardSchema, openConnection } from "./core/db.js";
import {
  getBoardByRegistryId,
  getBoardBySlug,
  getBoardByRepoPath,
  insertBoard,
  listBoards,
  openBoardDb,
  syncRegistryFromBoardDb,
  touchBoardActive
} from "./core/registry.js";
import { scheduleAutomaticBoardBackup } from "./core/backups.js";
import { provisionRepoBoard } from "./core/provision-repo-board.js";
import { seedIfEmpty } from "./core/seed.js";
import { now, normalizePath } from "./core/util.js";

const SERVER_INFO = {
  name: "minimal-agent-board",
  version: "0.1.0"
};

const orbitClient = await createOrbitClient();
// Per-process session board. Set on init by walking up from cwd, mutable via
// `board_set_active`. NEVER read by anything outside this file — every
// downstream call receives an explicit ctx.
let sessionBoardRow = null;

function setSessionBoard(row) {
  sessionBoardRow = row;
  if (row) touchBoardActive(row.id);
}

function getSessionBoard() {
  return sessionBoardRow;
}

/**
 * Walk up from `startDir` toward the filesystem root, returning the first
 * directory that satisfies `predicate`. Returns null if none found.
 */
function walkUp(startDir, predicate) {
  let dir = startDir;
  while (true) {
    if (predicate(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Initialise the MCP session board. Resolution order:
 *   1. Walk up from PROJECT_ROOT (cwd unless `orbit mcp --cwd` or env overrides it)
 *      for an existing `.orbit/board.db` — finds the board even when the agent
 *      is launched from a subdirectory or MCP config uses an absolute command.
 *   2. Walk up from PROJECT_ROOT for a `.git/` directory — auto-creates a board at
 *      the git root on first launch.
 *   3. Fall back to PROJECT_ROOT itself — supports non-git projects and global installs.
 */
function initMcpSessionBoard() {
  const start = normalizePath(process.env.PROJECT_ROOT ? resolve(process.env.PROJECT_ROOT) : process.cwd());

  // 1. Prefer the registry row for PROJECT_ROOT (or one of its ancestors). New
  // Orbit boards live in central DATA_DIR storage, so there may be no in-repo
  // .orbit/board.db to discover.
  const registeredRoot = walkUp(start, (dir) => Boolean(getBoardByRepoPath(normalizePath(dir))));
  if (registeredRoot) {
    setSessionBoard(getBoardByRepoPath(normalizePath(registeredRoot)));
    return;
  }

  // 2. Walk up for an existing legacy board db.
  const boardRoot = walkUp(start, (dir) => existsSync(join(dir, ".orbit", "board.db")));
  if (boardRoot) {
    const root = normalizePath(boardRoot);
    const existing = getBoardByRepoPath(root);
    if (existing) { setSessionBoard(existing); return; }
    // db exists on disk but isn't in the registry yet — register it.
    const dbPath = join(boardRoot, ".orbit", "board.db");
    const db = openConnection(dbPath);
    createBoardSchema(db);
    const seeded = seedIfEmpty(db, root);
    if (seeded) {
      const t = now();
      insertBoard({ id: seeded.id, slug: seeded.slug, name: seeded.name, repo_path: root, db_path: dbPath, repo_url: seeded.repo_url || "", default_branch: seeded.default_branch || "main", last_active_at: t, created_at: t, updated_at: t });
    }
    const fresh = getBoardByRepoPath(root);
    if (fresh) { syncRegistryFromBoardDb(fresh, db); setSessionBoard(fresh); }
    return;
  }

  // 3. Walk up for a git root; fall back to cwd for non-git projects.
  const gitRoot = walkUp(start, (dir) => existsSync(join(dir, ".git")));
  const result = provisionRepoBoard(normalizePath(gitRoot || start));
  if (result.registryRow) setSessionBoard(result.registryRow);
}

function createBoardAtRoot(root) {
  const dbPath = join(root, ".orbit", "board.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openConnection(dbPath);
  createBoardSchema(db);
  const seeded = seedIfEmpty(db, root);
  if (seeded) {
    const t = now();
    insertBoard({ id: seeded.id, slug: seeded.slug, name: seeded.name, repo_path: root, db_path: dbPath, repo_url: seeded.repo_url || "", default_branch: seeded.default_branch || "main", last_active_at: t, created_at: t, updated_at: t });
  }
  const fresh = getBoardByRepoPath(root);
  if (fresh) { syncRegistryFromBoardDb(fresh, db); setSessionBoard(fresh); }
}

initMcpSessionBoard();
closeAllConnections();

/** Build a ctx for the session board (or a board the tool argument selected). */
function ctxFor(boardRow, actor) {
  if (!boardRow) throw rpcError(-32602, "No board in session; pass board_id or board_slug, or call board_set_active first.");
  return { actor, board: boardRow, db: openBoardDb(boardRow) };
}

function sessionCtx(actor) {
  return ctxFor(getSessionBoard(), actor);
}

function withAutomaticBackup(ctx, result) {
  scheduleAutomaticBoardBackup(ctx.board, ctx.db);
  return result;
}

/** Resolve a registry row from explicit args (no session fallback). */
function resolveExplicitBoard(args) {
  if (args.board_id) {
    const row = getBoardByRegistryId(args.board_id);
    if (!row) throw rpcError(-32004, "Board id not found.");
    return row;
  }
  if (args.board_slug || args.board) {
    const row = getBoardBySlug(args.board_slug || args.board);
    if (!row) throw rpcError(-32004, "Board slug not found.");
    return row;
  }
  return null;
}

/** Resolve a board for a tool that accepts board_id/board_slug AND can fall
 *  back to the session board. */
function resolveBoardOrSession(args) {
  return resolveExplicitBoard(args) || getSessionBoard();
}

const TOOL_DEFS = [
  {
    name: "board_context",
    description:
      "Board/project context pack: board metadata, agent_instructions, journal entries (board_entries), and deployment paths. Complements the lean board_get_ticket_context. Resolves board from board_id / board_slug / board first; the MCP session board is only a fallback convenience. Set include_struck true to include struck journal rows (default false). Same payload as GET /api/boards/:id/context.",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" },
        include_struck: { type: "boolean", description: "When true, journal entries include struck items." }
      },
      additionalProperties: false
    },
    handler: (args) => orbitClient.boardContext(args)
  },
  {
    name: "board_list",
    description:
      "Tiny registry index: id, slug, name, repo_path per board. Does not open board databases or load tickets. Pair with board_set_active and board_context / ticket tools; the web UI loads full rows via GET /api/bootstrap.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    handler: () => orbitClient.boardList()
  },
  {
    name: "board_set_active",
    description:
      "Switch the MCP session fallback to another board by slug (updates last_active_at for multi-board repos). Tools that accept board_id / board_slug / board use those explicit selectors first; this session board is only the convenience fallback when selectors are omitted.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" }
      },
      required: ["slug"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.boardSetActive(args)
  },
  {
    name: "board_claim_next",
    description:
      "Claim the next schedulable AI-ready ticket on a specific board. Resolves board from board_id / board_slug / board first; the MCP session board is only a fallback convenience when selectors are omitted, and omitted selectors never scan other boards.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string" },
        board_slug: { type: "string" },
        board_id: { type: "string" },
        type: { type: "string" },
        include_epics: { type: "boolean" }
      },
      additionalProperties: false
    },
    handler: (args) => orbitClient.claimNext(args)
  },
  {
    name: "board_get_ticket_context",
    description:
      "Return the default lean context pack for a ticket: ticket fields, board identity only, relations, blockers, parent/children, and related ticket summaries. Resolves board from board_id / board_slug / board first; the MCP session board is only a fallback convenience. Project manual/journal and comments are intentionally omitted; use board_context for board manual/journal and board_read_comments for comment threads.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" },
        depth: { type: "integer", minimum: 1, maximum: 3 },
        max_chars_per_field: { type: "integer", minimum: 1 },
        include_parent_full: { type: "boolean" },
        include_related_full: { type: "boolean" }
      },
      required: ["ticket_id"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.getTicketContext(args)
  },
  {
    name: "board_get_ticket_context_full",
    description:
      "Return the explicit heavy ticket context pack, preserving the historical board_get_ticket_context shape: ticket, full board row, board_manual/journal, relations, blockers, parent/children, and related tickets. Resolves board from board_id / board_slug / board first; the MCP session board is only a fallback convenience. Comments are still intentionally omitted; use board_read_comments for comment threads.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" },
        depth: { type: "integer", minimum: 1, maximum: 3 },
        max_chars_per_field: { type: "integer", minimum: 1 },
        include_parent_full: { type: "boolean" },
        include_related_full: { type: "boolean" }
      },
      required: ["ticket_id"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.getTicketContextFull(args)
  },
  {
    name: "board_get_agent_dispatch_packet",
    description:
      "Return a lean agent dispatch packet for one ticket: board identity/instructions, capped ticket description/acceptance/AI plan, blockers, shallow parent, relevant workflow state IDs, repo path/default branch, recent capped comments, and label names. Resolves board from board_id / board_slug / board first; the MCP session board is only a fallback convenience. Parent/related/implementation bodies are intentionally omitted.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" },
        max_chars_per_field: { type: "integer", minimum: 1 },
        comment_limit: { type: "integer", minimum: 0, maximum: 20 }
      },
      required: ["ticket_id"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.getAgentDispatchPacket(args)
  },
  {
    name: "board_read_ticket",
    description:
      "Look up a ticket by ticket_id, number, or exact title (case-insensitive), and return its title, description, labels, state, and the board manual (agent_instructions + journal + deployment paths). Resolves board from board_id / board_slug / board first; the MCP session board is only a fallback convenience. Ticket comments are intentionally omitted; use board_read_comments for explicit comment retrieval.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        number: { type: "integer" },
        title: { type: "string" },
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" }
      },
      additionalProperties: false
    },
    handler: (args) => orbitClient.readTicket(args)
  },
  {
    name: "board_read_comments",
    description:
      "Return every comment on a ticket (oldest → newest). Look up by ticket_id, number, or exact title (case-insensitive). Resolves board from board_id / board_slug / board first; the MCP session board is only a fallback convenience. Comment kinds include human_comment, agent_note, checkpoint, completion, note.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        number: { type: "integer" },
        title: { type: "string" },
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" }
      },
      additionalProperties: false
    },
    handler: (args) => orbitClient.readComments(args)
  },
  {
    name: "board_get_ticket_relations",
    description: "List every link touching a ticket. Resolves board from board_id / board_slug / board first; the MCP session board is only a fallback convenience. Each entry has `type`, `direction`, `other_ticket`, and `source`. `source='relation'` rows come from the relations table (`relates_to` / `blocks` / `blocked_by`) and are the SSOT for peer dependencies — write via `POST /api/relations`, delete via `DELETE /api/relations/:id`. `source='hierarchy'` rows are read-only synthetic entries surfacing epic ownership (`child_of` toward the parent epic, `parent_of` toward each child); they have `id: null` and are mutated by patching the ticket's `parent_ticket_id`, not by calling the relations endpoints.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" }
      },
      required: ["ticket_id"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.getTicketRelations(args)
  },
  {
    name: "board_get_ticket_blockers",
    description: "Return unresolved blockers for a ticket and a can_start boolean. Resolves board from board_id / board_slug / board first; the MCP session board is only a fallback convenience. The single source of truth for dependencies is the per-card `blocked_by` row in the relations table; if a row exists the blocker is unresolved. Rows are removed two ways: (1) automatically when the blocking ticket moves into the Done lane (state role='done'), or (2) manually by the user in the UI. A ticket with can_start=false must not be worked on until its blockers resolve. Epic blocker targets expand to that epic's open children (children in any lane whose role is not 'done', not archived); each expanded entry carries via_epic_id.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" }
      },
      required: ["ticket_id"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.getTicketBlockers(args)
  },
  {
    name: "board_search",
    description:
      "Search tickets, comments, and implementation records by text on a specific board. Resolves board from board_id / board_slug / board first; the MCP session board is only a fallback convenience when selectors are omitted, and omitted selectors never merge results from other boards.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        board: { type: "string" },
        board_slug: { type: "string" },
        board_id: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        mode: { type: "string", enum: ["ids", "summary", "full"] },
        include_full: { type: "boolean" },
        fields: { type: "array", items: { type: "string" } },
        max_chars_per_field: { type: "integer", minimum: 1 }
      },
      required: ["q"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.search(args)
  },
  {
    name: "board_create_ticket",
    description:
      "Create a new Orbit ticket/card. Resolves board from board_id / board_slug / board first; the MCP session board is only a fallback convenience. Use this instead of editing .orbit/board.db directly. Same operation as POST /api/tickets.",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        type: { type: "string", enum: ["epic", "feature", "task", "bug"] },
        parent_ticket_id: { type: ["string", "null"] },
        ai_plan: { type: "string" },
        implementation_summary: { type: "string" },
        implementation_updates: { type: "string" },
        state_id: { type: "string" },
        priority: { type: "integer" },
        labels: { type: "array", items: { type: "string" } }
      },
      required: ["title"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.createTicket(args)
  },
  {
    name: "board_update_ticket",
    description:
      "Update ticket fields such as AI plan, implementation summary, implementation updates, state, type, priority, or labels (full replace: array of label names). Resolves board from board_id / board_slug / board; the MCP session board is only a fallback convenience.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        type: { type: "string" },
        parent_ticket_id: { type: ["string", "null"] },
        ai_plan: { type: "string" },
        implementation_summary: { type: "string" },
        implementation_updates: { type: "string" },
        state_id: { type: "string" },
        priority: { type: "integer" },
        labels: { type: "array", items: { type: "string" }, description: "Replaces all ticket labels when provided." }
      },
      required: ["ticket_id"],
      additionalProperties: false
    },
    handler: ({ ticket_id, ...patch }) => orbitClient.updateTicket({ ticket_id, ...patch })
  },
  {
    name: "board_add_comment",
    description: "Add a ticket comment or agent breadcrumb. Resolves board from board_id / board_slug / board; the MCP session board is only a fallback convenience.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" },
        body: { type: "string" },
        kind: { type: "string" }
      },
      required: ["ticket_id", "body"],
      additionalProperties: false
    },
    handler: ({ ticket_id, ...body }) => orbitClient.addComment({ ticket_id, ...body })
  },
  {
    name: "board_create_review_verdict",
    description: "Create a durable Sentinel/agent review verdict for a ticket. Verdict must be PASS, BLOCK, or QUESTION. Findings and evidence commands are stored as structured arrays; comments may mirror the data for humans but are not the source of truth. Resolves board from board_id / board_slug / board; the active session board is only a fallback convenience.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" },
        verdict: { type: "string", enum: ["PASS", "BLOCK", "QUESTION"] },
        blocking_findings: { type: "array" },
        optional_findings: { type: "array" },
        evidence_commands: { type: "array" },
        reviewer_profile: { type: "string" },
        reviewer_session_id: { type: "string" },
        reviewed_commit_sha: { type: "string" },
        dispatch_run_id: { type: "string" },
        supersedes_prior_review_id: { type: ["string", "null"] }
      },
      required: ["ticket_id", "verdict"],
      additionalProperties: false
    },
    handler: ({ ticket_id, ...body }) => orbitClient.createReviewVerdict({ ticket_id, ...body })
  },
  {
    name: "board_list_review_verdicts",
    description: "List durable review verdict records for a ticket, newest first. Use this for repair/re-review tooling instead of parsing prose comments.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 }
      },
      required: ["ticket_id"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.listReviewVerdicts(args)
  },
  {
    name: "board_get_review_verdict",
    description: "Read one durable review verdict record by id.",
    inputSchema: {
      type: "object",
      properties: {
        review_id: { type: "string" },
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" }
      },
      required: ["review_id"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.getReviewVerdict(args)
  },
  {
    name: "board_add_board_entry",
    description: "Add a durable board-level decision or lesson for future agents. Resolves board from board_id / board_slug / board first; the MCP session board is only a fallback convenience.",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" },
        type: { type: "string", enum: ["decision", "lesson"] },
        title: { type: "string" },
        body: { type: "string" },
        ticket_id: { type: "string" }
      },
      required: ["type", "title"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.addBoardEntry(args)
  },
  {
    name: "board_checkpoint",
    description:
      "Pause mid-flight for a human: moves the ticket to Review (same lane as board_complete; checkpoint distinguishes a blocking question) and posts a checkpoint-kind comment with your message. Use when you cannot proceed without the user—not for normal 'work is done' handoff (use board_complete). Resolves board from board_id / board_slug / board; the MCP session board is only a fallback convenience.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" },
        message: { type: "string" }
      },
      required: ["ticket_id", "message"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.checkpoint(args)
  },
  {
    name: "board_complete",
    description:
      "Hand off finished work for human review: moves the ticket to the Review lane (by role or name), writes a completion comment (summary, optional PR URL), and optional implementation_updates. This is the usual 'ready for you to look' path; use board_checkpoint only when blocked mid-flight. Resolves board from board_id / board_slug / board; the MCP session board is only a fallback convenience.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" },
        summary: { type: "string" },
        updates: { type: "string" },
        pr_url: { type: "string" },
        next_state: { type: "string" }
      },
      required: ["ticket_id", "summary"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.complete(args)
  },
  {
    name: "board_archive_ticket",
    description:
      "Archive (soft-delete) a ticket. The ticket is moved off the board into the Archive: it is excluded from bootstrap, search, claim-next, blockers, and relations, but its data and comments are preserved. Reverse with board_restore_ticket; permanently remove with board_delete_ticket. Resolves board from board_id / board_slug / board; the MCP session board is only a fallback convenience.",
    inputSchema: {
      type: "object",
      properties: { ticket_id: { type: "string" }, board_id: { type: "string" }, board_slug: { type: "string" }, board: { type: "string" } },
      required: ["ticket_id"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.archiveTicket(args)
  },
  {
    name: "board_restore_ticket",
    description: "Restore an archived ticket back to the board in its previous lane (state). Resolves board from board_id / board_slug / board; the MCP session board is only a fallback convenience.",
    inputSchema: {
      type: "object",
      properties: { ticket_id: { type: "string" }, board_id: { type: "string" }, board_slug: { type: "string" }, board: { type: "string" } },
      required: ["ticket_id"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.restoreTicket(args)
  },
  {
    name: "board_delete_ticket",
    description:
      "Permanently delete a ticket. The ticket MUST already be archived (call board_archive_ticket first) — otherwise this returns 409 ticket_not_archived. This cannot be undone: comments, labels, and relations are removed via cascade. Events for this ticket are kept but their ticket_id becomes NULL. Resolves board from board_id / board_slug / board; the MCP session board is only a fallback convenience.",
    inputSchema: {
      type: "object",
      properties: { ticket_id: { type: "string" }, board_id: { type: "string" }, board_slug: { type: "string" }, board: { type: "string" } },
      required: ["ticket_id"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.deleteTicket(args)
  },
  {
    name: "board_list_archive",
    description: "List archived tickets for a board, ordered by archive time (most recent first). Identify the board with board_id or board_slug.",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        board_slug: { type: "string" }
      },
      additionalProperties: false
    },
    handler: (args) => orbitClient.listArchive(args)
  },
  {
    name: "board_export_board",
    description: "Export a board snapshot as JSON for backup or transfer. Resolves board from board_id / board_slug / board first; the MCP session board is only a fallback convenience.",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" },
        include_attachments: { type: "boolean", description: "Embed attached image bytes in the JSON snapshot." },
        include_images: { type: "boolean", description: "Alias for include_attachments." }
      },
      additionalProperties: false
    },
    handler: (args) => orbitClient.exportBoard(args)
  },
  {
    name: "board_update_settings",
    description:
      "PATCH-equivalent for board settings: name (display rename only; slug/canonical URLs stay unchanged), repo_url, system_path, default_branch, agent_instructions (project-level agent context), and project_notes (Notes For You). Resolves board from board_id / board_slug / board; the MCP session board is only a fallback convenience.",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" },
        name: { type: "string" },
        repo_url: { type: "string" },
        system_path: { type: "string" },
        default_branch: { type: "string" },
        project_notes: { type: "string" },
        agent_instructions: { type: "string" }
      },
      additionalProperties: false
    },
    handler: (args) => orbitClient.updateSettings(args)
  }
];

const tools = new Map(TOOL_DEFS.map((tool) => [tool.name, tool]));

let inputBuffer = Buffer.alloc(0);
let expectedBodyLength = -1;
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  orbitClient.close?.();
  process.exit(code);
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  drainInput();
});

process.stdin.on("end", () => shutdown(0));
process.stdin.resume();

function drainInput() {
  while (true) {
    if (expectedBodyLength >= 0) {
      if (inputBuffer.byteLength < expectedBodyLength) return;
      const body = inputBuffer.slice(0, expectedBodyLength);
      inputBuffer = inputBuffer.slice(expectedBodyLength);
      expectedBodyLength = -1;
      handleMessage(body.toString("utf8"), "content-length");
      continue;
    }

    const preview = inputBuffer.slice(0, Math.min(inputBuffer.byteLength, 32)).toString("utf8").toLowerCase();
    if (preview.startsWith("content-length:")) {
      const headerEnd = inputBuffer.indexOf(Buffer.from("\r\n\r\n"));
      if (headerEnd === -1) return;

      const headerText = inputBuffer.slice(0, headerEnd).toString("utf8");
      inputBuffer = inputBuffer.slice(headerEnd + 4);
      const headers = parseHeaders(headerText);
      expectedBodyLength = Number(headers["content-length"] || -1);
      if (!Number.isFinite(expectedBodyLength) || expectedBodyLength < 0) {
        writeMessage(errorResponse(null, -32700, "Missing Content-Length header."), "content-length");
        expectedBodyLength = -1;
      }
      continue;
    }

    const lineEnd = inputBuffer.indexOf(Buffer.from("\n"));
    if (lineEnd === -1) return;
    const line = inputBuffer.slice(0, lineEnd).toString("utf8").replace(/\r$/, "");
    inputBuffer = inputBuffer.slice(lineEnd + 1);
    if (!line.trim()) continue;
    handleMessage(line, "line");
  }
}

function parseHeaders(text) {
  const headers = {};
  for (const line of text.split("\r\n")) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers[key] = value;
  }
  return headers;
}

async function handleMessage(body, transport = "content-length") {
  let message;
  try {
    message = JSON.parse(body);
  } catch {
    writeMessage(errorResponse(null, -32700, "Invalid JSON."), transport);
    return;
  }

  if (!message || typeof message !== "object") {
    writeMessage(errorResponse(null, -32600, "Invalid request."), transport);
    return;
  }

  if (!("id" in message)) {
    if (message.method === "notifications/initialized") return;
    return;
  }

  try {
    const result = await dispatch(message);
    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result
    }, transport);
  } catch (error) {
    writeMessage(errorResponse(message.id, error.code || -32000, error.message || "Internal error."), transport);
  } finally {
    orbitClient.close?.();
  }
}

async function dispatch(message) {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: message.params?.protocolVersion || "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: SERVER_INFO
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: TOOL_DEFS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema
        }))
      };
    case "tools/call":
      return callTool(message.params || {});
    default:
      throw rpcError(-32601, `Method not found: ${message.method}`);
  }
}

async function callTool(params) {
  const name = params.name;
  const args = params.arguments || {};
  const tool = tools.get(name);
  if (!tool) throw rpcError(-32601, `Unknown tool: ${name}`);

  let result;
  try {
    result = await tool.handler(args);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: error.message || "Tool call failed."
        }
      ],
      isError: true
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ]
  };
}

function writeMessage(message, transport = "content-length") {
  const json = JSON.stringify(message);
  if (transport === "line") {
    process.stdout.write(`${json}\n`);
    return;
  }
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
}

function errorResponse(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  };
}

function rpcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

process.on("uncaughtException", (error) => {
  writeMessage(errorResponse(null, -32000, error.message || "Uncaught exception."));
});

process.on("unhandledRejection", (error) => {
  writeMessage(errorResponse(null, -32000, error?.message || "Unhandled rejection."));
});

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));
process.once("exit", () => orbitClient.close?.());

if (process.env.MAB_MCP_STDERR_LOG === "1") {
  const target = typeof orbitClient.sessionLabel === "function" ? orbitClient.sessionLabel() : orbitClient.sessionLabel;
  console.error(`Starscape Orbit MCP ready. Mode: ${orbitClient.mode}. Target: ${target}`);
}
