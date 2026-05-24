import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function rpcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function orbitMode(env = process.env) {
  const mode = String(env.ORBIT_MODE || "local").trim().toLowerCase();
  if (mode === "remote" || mode === "http") return "remote";
  if (mode === "local" || mode === "") return "local";
  throw rpcError(-32602, `Unsupported ORBIT_MODE: ${env.ORBIT_MODE}`);
}

export async function createOrbitClient(env = process.env) {
  return orbitMode(env) === "remote" ? createHttpOrbitClient(env) : createLocalOrbitClient(env);
}

export function createHttpOrbitClient(env = process.env, fetchImpl = globalThis.fetch) {
  const apiUrl = String(env.ORBIT_API_URL || "").trim().replace(/\/+$/, "");
  const defaultBoard = String(env.ORBIT_DEFAULT_BOARD || "").trim();
  if (!apiUrl) throw rpcError(-32602, "ORBIT_MODE=remote requires ORBIT_API_URL.");
  if (typeof fetchImpl !== "function") throw rpcError(-32603, "ORBIT_MODE=remote requires global fetch support.");

  async function request(method, path, { query = {}, body, ok = [200] } = {}) {
    const url = new URL(`${apiUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const response = await fetchImpl(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let payload = null;
    const text = await response.text();
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { message: text }; }
    }
    if (!ok.includes(response.status)) {
      const message = payload?.message || payload?.error || `Orbit API ${method} ${url.pathname} failed with HTTP ${response.status}`;
      throw rpcError(-32000, message);
    }
    return payload ?? {};
  }

  function boardArg(args = {}) {
    return args.board_id || args.board_slug || args.board || defaultBoard;
  }

  function requireBoard(args = {}) {
    const board = boardArg(args);
    if (!board) throw rpcError(-32602, "Remote Orbit MCP requires board_id/board_slug/board or ORBIT_DEFAULT_BOARD.");
    return board;
  }

  const ticketQuery = (args = {}) => ({ board_id: args.board_id, board: args.board_slug || args.board || defaultBoard });

  return {
    mode: "remote",
    sessionLabel: apiUrl,
    async boardContext(args = {}) {
      return request("GET", `/api/boards/${encodeURIComponent(requireBoard(args))}/context`, { query: { include_struck: args.include_struck ? "true" : undefined } });
    },
    async boardList() { return request("GET", "/api/boards"); },
    async boardSetActive(args = {}) { if (!args.slug) throw rpcError(-32602, "slug is required."); env.ORBIT_DEFAULT_BOARD = String(args.slug); return { ok: true, slug: String(args.slug), mode: "remote" }; },
    async claimNext(args = {}) { return request("POST", "/api/agent/claim-next", { body: { ...args, board: requireBoard(args) } }); },
    async getTicketContext(args = {}) { return request("GET", `/api/tickets/${encodeURIComponent(args.ticket_id)}/context`, { query: { ...ticketQuery(args), depth: args.depth || 1 } }); },
    async readTicket(args = {}) {
      if (args.ticket_id) return this.getTicketContext({ ...args, depth: 1 });
      const found = await this.search({ q: args.title || String(args.number || ""), limit: 10, ...args });
      return found;
    },
    async readComments(args = {}) { const ctx = await this.readTicket(args); return { comments: ctx.comments || ctx.ticket?.comments || [] }; },
    async getTicketRelations(args = {}) { return request("GET", `/api/tickets/${encodeURIComponent(args.ticket_id)}/relations`, { query: ticketQuery(args) }); },
    async getTicketBlockers(args = {}) { return request("GET", `/api/tickets/${encodeURIComponent(args.ticket_id)}/blockers`, { query: ticketQuery(args) }); },
    async search(args = {}) { return request("GET", "/api/search", { query: { q: args.q, limit: args.limit, board_id: args.board_id, board: args.board_slug || args.board || defaultBoard } }); },
    async createTicket(args = {}) { return request("POST", "/api/tickets", { body: { ...args, board: requireBoard(args) }, ok: [201] }); },
    async updateTicket({ ticket_id, ...patch }) { return request("PATCH", `/api/tickets/${encodeURIComponent(ticket_id)}`, { query: ticketQuery(patch), body: patch }); },
    async addComment({ ticket_id, ...body }) { return request("POST", `/api/tickets/${encodeURIComponent(ticket_id)}/comments`, { body, ok: [201] }); },
    async addBoardEntry(args = {}) { return request("POST", `/api/boards/${encodeURIComponent(requireBoard(args))}/entries`, { body: args, ok: [201] }); },
    async checkpoint(args = {}) { return request("POST", "/api/agent/checkpoint", { body: args }); },
    async complete(args = {}) { return request("POST", "/api/agent/complete", { body: args }); },
    async archiveTicket(args = {}) { return request("POST", `/api/tickets/${encodeURIComponent(args.ticket_id)}/archive`, { query: ticketQuery(args) }); },
    async restoreTicket(args = {}) { return request("POST", `/api/tickets/${encodeURIComponent(args.ticket_id)}/restore`, { query: ticketQuery(args) }); },
    async deleteTicket(args = {}) { return request("DELETE", `/api/tickets/${encodeURIComponent(args.ticket_id)}`, { query: ticketQuery(args) }); },
    async listArchive(args = {}) { return request("GET", `/api/boards/${encodeURIComponent(requireBoard(args))}/archive`); },
    async exportBoard(args = {}) { return request("GET", `/api/boards/${encodeURIComponent(requireBoard(args))}/export`); },
    async updateSettings(args = {}) { const { board_id, board_slug, board, ...patch } = args; return request("PATCH", `/api/boards/${encodeURIComponent(requireBoard(args))}`, { body: patch }); }
  };
}

export async function createLocalOrbitClient(env = process.env) {
  const board = await import("../core/board.js");
  const dbMod = await import("../core/db.js");
  const registry = await import("../core/registry.js");
  const backups = await import("../core/backups.js");
  const seed = await import("../core/seed.js");
  const util = await import("../core/util.js");

  const provision = await import("../core/provision-repo-board.js");
  let sessionBoardRow = null;
  const setSessionBoard = (row) => { sessionBoardRow = row; if (row) registry.touchBoardActive(row.id); };
  const getSessionBoard = () => sessionBoardRow;
  const walkUp = (startDir, predicate) => { let dir = startDir; while (true) { if (predicate(dir)) return dir; const parent = dirname(dir); if (parent === dir) return null; dir = parent; } };

  const start = util.normalizePath(env.PROJECT_ROOT ? resolve(env.PROJECT_ROOT) : process.cwd());

  // Find repo root (walk up for .git, fall back to start).
  const gitRoot = walkUp(start, (dir) => existsSync(join(dir, ".git")));
  const repoRoot = util.normalizePath(gitRoot || start);

  // 1. Registry-first lookup: walk upward from start so we find boards regardless
  //    of whether they were registered at the git root, at PROJECT_ROOT, or at any
  //    ancestor (handles boards originally created from a subdirectory).
  let foundByRegistry = false;
  {
    let dir = start;
    while (true) {
      const row = registry.getBoardByRepoPath(dir);
      if (row && existsSync(row.db_path)) { setSessionBoard(row); foundByRegistry = true; break; }
      const parent = util.normalizePath(dirname(dir));
      if (parent === dir) break; // filesystem root
      dir = parent;
    }
  }
  if (!foundByRegistry) {
    // 2. Legacy fallback: walk up for an existing in-repo .orbit/board.db.
    const boardRoot = walkUp(start, (dir) => existsSync(join(dir, ".orbit", "board.db")));
    if (boardRoot) {
      const root = util.normalizePath(boardRoot);
      const existing = registry.getBoardByRepoPath(root);
      if (existing) {
        setSessionBoard(existing);
      } else {
        const dbPath = join(boardRoot, ".orbit", "board.db");
        const db = dbMod.openConnection(dbPath);
        dbMod.createBoardSchema(db);
        const seeded = seed.seedIfEmpty(db, root);
        if (seeded) {
          const t = util.now();
          registry.insertBoard({ id: seeded.id, slug: seeded.slug, name: seeded.name, repo_path: root, db_path: dbPath, repo_url: seeded.repo_url || "", default_branch: seeded.default_branch || "main", last_active_at: t, created_at: t, updated_at: t });
        }
        const fresh = registry.getBoardByRepoPath(root);
        if (fresh) { registry.syncRegistryFromBoardDb(fresh, db); setSessionBoard(fresh); }
      }
    } else {
      // 3. No board found — auto-create one (goes to central DATA_DIR/boards/).
      provision.provisionRepoBoard(repoRoot, { enableAi: true });
      const fresh = registry.getBoardByRepoPath(repoRoot);
      if (fresh) setSessionBoard(fresh);
    }
  }

  const ctxFor = (row, actor) => {
    if (!row) throw rpcError(-32602, "No board in session; pass board_id or board_slug, or call board_set_active first.");
    return { actor, board: row, db: registry.openBoardDb(row) };
  };
  const sessionCtx = (actor) => ctxFor(getSessionBoard(), actor);
  const backup = (ctx, result) => { backups.scheduleAutomaticBoardBackup(ctx.board, ctx.db); return result; };
  const explicit = (args = {}) => args.board_id ? registry.getBoardByRegistryId(args.board_id) : (args.board_slug || args.board ? registry.getBoardBySlug(args.board_slug || args.board) : null);
  const rowOrSession = (args = {}) => explicit(args) || getSessionBoard();
  const actor = () => board.localAgentActor();

  return {
    mode: "local",
    sessionLabel: () => {
      const b = getSessionBoard();
      return b ? `${b.repo_path}  db: ${b.db_path}` : "(none)";
    },
    boardContext: (args = {}) => { const ctx = ctxFor(rowOrSession(args), actor()); return board.getBoardContext(ctx.board.id, ctx, { includeStruck: Boolean(args.include_struck) }); },
    boardList: () => ({ boards: registry.listBoards().map((row) => ({ id: row.id, slug: row.slug, name: row.name, repo_path: row.repo_path })) }),
    boardSetActive: (args = {}) => { const slug = String(args.slug || "").trim(); if (!slug) throw rpcError(-32602, "slug is required."); const row = registry.getBoardBySlug(slug); if (!row) throw rpcError(-32004, `Board slug not found: ${slug}`); setSessionBoard(row); return { ok: true, board_id: row.id, slug: row.slug, name: row.name, db_path: row.db_path }; },
    claimNext: (args = {}) => { const ctx = ctxFor(rowOrSession(args), actor()); return backup(ctx, board.claimNext(args, ctx)); },
    getTicketContext: (args = {}) => board.getContextPack(args.ticket_id, sessionCtx(actor()), Number(args.depth || 1)),
    readTicket: (args = {}) => board.readTicket(args, sessionCtx(actor())),
    readComments: (args = {}) => board.readComments(args, sessionCtx(actor())),
    getTicketRelations: (args = {}) => board.getTicketRelations(args.ticket_id, sessionCtx(actor())),
    getTicketBlockers: (args = {}) => board.getTicketBlockers(args.ticket_id, sessionCtx(actor())),
    search: (args = {}) => { const ctx = ctxFor(rowOrSession(args), actor()); return board.searchTickets({ q: args.q, limit: args.limit }, ctx); },
    createTicket: (args = {}) => { const ctx = ctxFor(rowOrSession(args), actor()); const { board_slug, board: _b, ...body } = args; body.board_id = ctx.board.id; return backup(ctx, board.createTicket(body, ctx)); },
    updateTicket: ({ ticket_id, ...patch }) => { const ctx = sessionCtx(actor()); return backup(ctx, board.updateTicket(ticket_id, patch, ctx)); },
    addComment: ({ ticket_id, ...body }) => { const ctx = sessionCtx(actor()); return backup(ctx, board.createComment(ticket_id, body, ctx)); },
    addBoardEntry: (args = {}) => { const ctx = ctxFor(rowOrSession(args), actor()); return backup(ctx, board.createBoardEntry(ctx.board.id, args, ctx)); },
    checkpoint: (args = {}) => { const ctx = sessionCtx(actor()); return backup(ctx, board.checkpointTicket(args, ctx)); },
    complete: (args = {}) => { const ctx = sessionCtx(actor()); return backup(ctx, board.completeTicket(args, ctx)); },
    archiveTicket: (args = {}) => { const ctx = sessionCtx(actor()); return backup(ctx, board.archiveTicket(args.ticket_id, ctx)); },
    restoreTicket: (args = {}) => { const ctx = sessionCtx(actor()); return backup(ctx, board.restoreTicket(args.ticket_id, ctx)); },
    deleteTicket: (args = {}) => { const ctx = sessionCtx(actor()); return backup(ctx, board.deleteTicket(args.ticket_id, ctx)); },
    listArchive: (args = {}) => { const ctx = ctxFor(rowOrSession(args), actor()); return { tickets: board.archivedTicketsForBoard(ctx.db, ctx.board.id) }; },
    exportBoard: (args = {}) => { const ctx = ctxFor(rowOrSession(args), actor()); return board.exportBoard(ctx.board.id, ctx); },
    updateSettings: (args = {}) => { const ctx = ctxFor(rowOrSession(args), actor()); const { board_id, board_slug, ...patch } = args; return backup(ctx, board.updateBoard(ctx.board.id, patch, ctx)); }
  };
}
