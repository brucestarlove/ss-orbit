// Event recording and SSE fan-out. `recordEvent` is always called with the
// per-board `db` and the owning `boardId`, so events get written to the
// right per-board DB and SSE listeners only see events for the board they
// subscribed to.
//
// Same-process HTTP mutations can broadcast immediately. MCP/CLI tools mutate
// the same per-board SQLite DB from separate Node processes, so the web server
// also keeps a lightweight per-board watcher while SSE clients are connected.
// Watchers use SQLite `PRAGMA data_version` as the cheap "did another
// connection commit?" check, then drain semantic rows from the `events` table.

import { localOwnerActor } from "./auth.js";
import { getBoardByRegistryId, openBoardDb } from "./registry.js";
import { sendJson, setCors } from "./http.js";
import { id, now } from "./util.js";

const sseClients = new Set();
const boardWatchers = new Map();
const DEFAULT_SSE_POLL_MS = 500;
const MIN_SSE_POLL_MS = 25;
const MAX_SSE_POLL_MS = 30_000;
const EVENT_BATCH_LIMIT = 200;
// If a client's socket buffers more than this, it's not keeping up. We end
// the stream so the browser reconnects and replays from Last-Event-ID rather
// than letting Node's write buffer grow without bound.
const SSE_MAX_BUFFERED_BYTES = 1_000_000;

// Events written inside a tx() are not visible to other connections until
// COMMIT, so broadcasting them immediately would tell SSE listeners about a
// mutation that might still roll back. db.tx() brackets each transaction with
// __enterEventTx/__settleEventTx; while depth > 0 we queue and only fan out
// (or drop, on rollback) once the outermost transaction settles.
let eventTxDepth = 0;
const bufferedBroadcasts = [];

export function __enterEventTx() {
  eventTxDepth += 1;
}

export function __settleEventTx(committed) {
  eventTxDepth -= 1;
  if (eventTxDepth > 0) return;
  const queued = bufferedBroadcasts.splice(0, bufferedBroadcasts.length);
  if (!committed) return;
  for (const item of queued) {
    broadcastSSE(item.payload);
    advanceWatcherCursorByRowid(item.boardId, item.rowid);
  }
}

export function recordEvent(db, boardId, type, ticketId, actor, body) {
  const eventId = id();
  const timestamp = now();
  const result = db.prepare(
    "INSERT INTO events (id, ticket_id, actor, type, body_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(eventId, ticketId, actor, type, JSON.stringify(body || {}), timestamp);

  const payload = {
    id: eventId,
    type,
    ticket_id: ticketId,
    board_id: boardId,
    actor,
    data: body || {},
    timestamp
  };

  if (eventTxDepth > 0) {
    bufferedBroadcasts.push({ payload, boardId, rowid: result.lastInsertRowid });
    return;
  }
  broadcastSSE(payload);
  advanceWatcherCursorByRowid(boardId, result.lastInsertRowid);
}

export function startSSEStream(req, res, url) {
  const actor = localOwnerActor();

  const boardId = url.searchParams.get("board_id") || null;
  let board = null;
  if (boardId) {
    board = getBoardByRegistryId(boardId);
    if (!board) {
      sendJson(res, 404, { error: "board_not_found" });
      return;
    }
  }

  const lastEventId = req.headers["last-event-id"] || url.searchParams.get("last_event_id") || null;
  const watcher = board ? getOrCreateBoardWatcher(board) : null;

  setCors(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(":ok\n\n");

  if (lastEventId && board) {
    replayEventsForBoard(res, board, lastEventId);
  }

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(":heartbeat\n\n");
  }, 30_000);

  const client = { res, boardId, boardRow: board, actor, heartbeat, watcher };
  sseClients.add(client);
  if (watcher) watcher.clients.add(client);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(client);
    if (watcher) {
      watcher.clients.delete(client);
      stopBoardWatcherIfIdle(watcher);
    }
  });
}

function getOrCreateBoardWatcher(boardRow) {
  const existing = boardWatchers.get(boardRow.id);
  if (existing) {
    existing.boardRow = boardRow;
    return existing;
  }

  const watcher = {
    boardId: boardRow.id,
    boardRow,
    clients: new Set(),
    dataVersion: dataVersionForBoard(boardRow),
    cursor: latestEventCursor(boardRow),
    timer: null
  };
  watcher.timer = setInterval(() => pollBoardWatcher(watcher), ssePollIntervalMs());
  watcher.timer.unref?.();
  boardWatchers.set(boardRow.id, watcher);
  return watcher;
}

function stopBoardWatcherIfIdle(watcher) {
  if (watcher.clients.size > 0) return;
  clearInterval(watcher.timer);
  boardWatchers.delete(watcher.boardId);
}

function pollBoardWatcher(watcher) {
  if (watcher.clients.size === 0) {
    stopBoardWatcherIfIdle(watcher);
    return;
  }

  let nextDataVersion;
  try {
    nextDataVersion = dataVersionForBoard(watcher.boardRow);
  } catch (error) {
    console.warn(`[orbit] Failed to read data_version for board ${watcher.boardId}: ${error.message}`);
    return;
  }

  if (nextDataVersion === watcher.dataVersion) return;
  watcher.dataVersion = nextDataVersion;
  drainBoardWatcherEvents(watcher);
}

function drainBoardWatcherEvents(watcher) {
  try {
    while (true) {
      const rows = eventsAfterCursor(watcher.boardRow, watcher.cursor);
      if (rows.length === 0) return;

      for (const row of rows) {
        const event = eventFromRow(watcher.boardRow, row);
        for (const client of watcher.clients) {
          writeSSEFrame(client.res, event);
        }
        watcher.cursor = eventCursor(row);
      }

      if (rows.length < EVENT_BATCH_LIMIT) return;
    }
  } catch (error) {
    console.warn(`[orbit] Failed to poll events for board ${watcher.boardId}: ${error.message}`);
  }
}

function ssePollIntervalMs() {
  const raw = process.env.ORBIT_SSE_POLL_MS;
  const value = raw === undefined ? DEFAULT_SSE_POLL_MS : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SSE_POLL_MS;
  return Math.min(MAX_SSE_POLL_MS, Math.max(MIN_SSE_POLL_MS, Math.trunc(value)));
}

function dataVersionForBoard(boardRow) {
  const row = openBoardDb(boardRow).prepare("PRAGMA data_version").get();
  return Number(row?.data_version || 0);
}

function replayEventsForBoard(res, boardRow, afterId) {
  const db = openBoardDb(boardRow);
  const anchor = db.prepare("SELECT rowid AS event_rowid FROM events WHERE id = ?").get(afterId);
  if (!anchor) return latestEventCursor(boardRow);

  let cursor = eventCursor(anchor);
  const rows = db
    .prepare(
      `SELECT e.rowid AS event_rowid, e.id, e.type, e.ticket_id, e.actor, e.body_json, e.created_at
       FROM events e
       WHERE e.rowid > ?
       ORDER BY e.rowid LIMIT ${EVENT_BATCH_LIMIT}`
    )
    .all(anchor.event_rowid);

  for (const row of rows) {
    const event = eventFromRow(boardRow, row);
    writeSSEFrame(res, event);
    cursor = eventCursor(row);
  }
  return cursor;
}

function latestEventCursor(boardRow) {
  const db = openBoardDb(boardRow);
  const row = db
    .prepare("SELECT rowid AS event_rowid FROM events ORDER BY rowid DESC LIMIT 1")
    .get();
  return eventCursor(row);
}

function eventCursor(row) {
  if (!row) return null;
  return { event_rowid: Number(row.event_rowid) };
}

function compareCursors(left, right) {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  if (left.event_rowid > right.event_rowid) return 1;
  if (left.event_rowid < right.event_rowid) return -1;
  return 0;
}

function eventsAfterCursor(boardRow, cursor) {
  const db = openBoardDb(boardRow);
  if (!cursor) {
    return db
      .prepare(
        `SELECT e.rowid AS event_rowid, e.id, e.type, e.ticket_id, e.actor, e.body_json, e.created_at
         FROM events e
         ORDER BY e.rowid LIMIT ${EVENT_BATCH_LIMIT}`
      )
      .all();
  }
  return db
    .prepare(
      `SELECT e.rowid AS event_rowid, e.id, e.type, e.ticket_id, e.actor, e.body_json, e.created_at
       FROM events e
       WHERE e.rowid > ?
       ORDER BY e.rowid LIMIT ${EVENT_BATCH_LIMIT}`
    )
    .all(cursor.event_rowid);
}

function eventFromRow(boardRow, row) {
  return {
    id: row.id,
    type: row.type,
    ticket_id: row.ticket_id,
    board_id: boardRow.id,
    actor: row.actor,
    data: parseEventBody(row.body_json),
    timestamp: row.created_at
  };
}

function parseEventBody(bodyJson) {
  try {
    return JSON.parse(bodyJson || "{}");
  } catch {
    return {};
  }
}

function advanceWatcherCursorByRowid(boardId, rowid) {
  const watcher = boardWatchers.get(boardId);
  if (!watcher) return;
  const cursor = { event_rowid: Number(rowid) };
  if (cursor && compareCursors(cursor, watcher.cursor) > 0) {
    watcher.cursor = cursor;
  }
}

function broadcastSSE(event) {
  for (const client of sseClients) {
    if (client.boardId && event.board_id !== client.boardId) continue;
    writeSSEFrame(client.res, event);
  }
}

function writeSSEFrame(res, event) {
  if (res.writableEnded) return;
  // A backpressured client (closed laptop, dead tab) would otherwise make
  // Node buffer every event in memory forever. Cut it loose; the EventSource
  // client reconnects and replays missed events via Last-Event-ID.
  if (res.writableLength > SSE_MAX_BUFFERED_BYTES) {
    res.end();
    return;
  }
  res.write(`id: ${event.id}\nevent: board\ndata: ${JSON.stringify(event)}\n\n`);
}
