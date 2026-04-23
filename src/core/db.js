// Connection management. There is intentionally no module-level "active board"
// singleton: every caller resolves a per-board DB connection via openConnection
// and threads it through. This is what makes the server safe under concurrent
// HTTP requests for different boards — a global active-pointer would race
// across requests that interleave around `await readJson`.

import { DatabaseSync } from "node:sqlite";
import { REGISTRY_DB_PATH } from "./paths.js";
import { __enterEventTx, __settleEventTx } from "./events.js";

const connections = new Map();

/** Open (or return cached) per-database connection. Safe to share within a process. */
export function openConnection(dbPath) {
  if (connections.has(dbPath)) return connections.get(dbPath);
  const conn = new DatabaseSync(dbPath);
  conn.exec("PRAGMA foreign_keys = ON;");
  conn.exec("PRAGMA busy_timeout = 5000;");
  conn.exec("PRAGMA journal_mode = WAL;");
  // busy_timeout (set above) makes a second writer from another process (MCP
  // server, CLI) wait instead of failing immediately with SQLITE_BUSY when an
  // agent commit and a UI drag overlap. NORMAL is the recommended
  // durability/throughput tradeoff under WAL (a power-loss can lose the last
  // commit but never corrupts the DB).
  conn.exec("PRAGMA synchronous = NORMAL;");
  connections.set(dbPath, conn);
  return conn;
}

export function closeConnection(dbPath) {
  const conn = connections.get(dbPath);
  if (!conn) return;
  conn.close();
  connections.delete(dbPath);
}

// Reentrancy depth per connection. Only the outermost tx() issues
// BEGIN/COMMIT/ROLLBACK; inner calls (a tx-wrapped function calling another)
// fold into the enclosing transaction. Execution is synchronous and a request
// never awaits between BEGIN and COMMIT, so per-connection depth is race-free.
const txDepth = new WeakMap();

/**
 * Run `fn` inside an IMMEDIATE transaction on `db` so a multi-statement
 * mutation is atomic: it either fully lands or fully rolls back. BEGIN
 * IMMEDIATE takes the write lock up front, which also makes read-then-write
 * sequences (e.g. `MAX(number)+1` ticket numbering) safe against concurrent
 * writer processes. SSE broadcasts for events recorded inside the transaction
 * are buffered and only fan out after COMMIT (see events.js).
 */
export function tx(db, fn) {
  const depth = txDepth.get(db) || 0;
  if (depth === 0) db.exec("BEGIN IMMEDIATE;");
  txDepth.set(db, depth + 1);
  __enterEventTx();
  try {
    const result = fn();
    const next = txDepth.get(db) - 1;
    txDepth.set(db, next);
    if (next === 0) db.exec("COMMIT;");
    __settleEventTx(true);
    return result;
  } catch (error) {
    const next = txDepth.get(db) - 1;
    txDepth.set(db, next);
    if (next === 0) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // A failed BEGIN leaves no transaction to roll back; ignore.
      }
    }
    __settleEventTx(false);
    throw error;
  }
}

export function getRegistry() {
  return openConnection(REGISTRY_DB_PATH);
}

/** Registry metadata table (not the per-board `boards` content row). */
export function createRegistrySchema(reg = getRegistry()) {
  reg.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      repo_path TEXT NOT NULL DEFAULT '',
      db_path TEXT NOT NULL,
      repo_url TEXT NOT NULL DEFAULT '',
      default_branch TEXT NOT NULL DEFAULT 'main',
      last_active_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_registry_boards_repo_path ON boards(repo_path);
  `);
}

/** Full Kanban schema on a per-board database connection. */
export function createBoardSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      repo_url TEXT NOT NULL DEFAULT '',
      system_path TEXT NOT NULL DEFAULT '',
      default_branch TEXT NOT NULL DEFAULT 'main',
      project_notes TEXT NOT NULL DEFAULT '',
      agent_instructions TEXT NOT NULL DEFAULT '',
      ai_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS states (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      role TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(board_id, name)
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'task',
      parent_ticket_id TEXT,
      ai_plan TEXT NOT NULL DEFAULT '',
      implementation_summary TEXT NOT NULL DEFAULT '',
      implementation_updates TEXT NOT NULL DEFAULT '',
      state_id TEXT NOT NULL REFERENCES states(id),
      priority INTEGER NOT NULL DEFAULT 2,
      created_by TEXT NOT NULL DEFAULT 'human',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      UNIQUE(board_id, number)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'comment',
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS board_entries (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
      created_by TEXT NOT NULL DEFAULT 'human',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      struck_at TEXT
    );

    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#64748b',
      created_at TEXT NOT NULL,
      UNIQUE(board_id, name)
    );

    CREATE TABLE IF NOT EXISTS ticket_labels (
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY(ticket_id, label_id)
    );

    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      source_ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      target_ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(source_ticket_id, target_ticket_id, type)
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
      actor TEXT NOT NULL,
      type TEXT NOT NULL,
      body_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS ticket_fts USING fts5(
      ticket_id UNINDEXED,
      title,
      description,
      comments
    );

    CREATE INDEX IF NOT EXISTS idx_states_board ON states(board_id, position);
    CREATE INDEX IF NOT EXISTS idx_states_role ON states(board_id, role);
    CREATE INDEX IF NOT EXISTS idx_tickets_board_state ON tickets(board_id, state_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_archived ON tickets(board_id, archived_at);
    CREATE INDEX IF NOT EXISTS idx_tickets_parent ON tickets(parent_ticket_id);
    CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_board_entries_board ON board_entries(board_id, type, created_at);
    CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_ticket_id);
    CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_ticket_id);
    CREATE INDEX IF NOT EXISTS idx_events_ticket ON events(ticket_id, created_at);
  `);
}

export function resetBoard(db) {
  db.exec(`
    DELETE FROM ticket_fts;
    DELETE FROM ticket_labels;
    DELETE FROM relations;
    DELETE FROM comments;
    DELETE FROM board_entries;
    DELETE FROM events;
    DELETE FROM tickets;
    DELETE FROM labels;
    DELETE FROM states;
    DELETE FROM boards;
  `);
}
