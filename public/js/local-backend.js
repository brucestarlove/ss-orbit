// Preview-edition local backend. Replaces transport.js at build time so the
// app's existing `api()` calls land in IndexedDB instead of an HTTP server.
// Single-board, no auth, no agent routes — just enough surface to drive the
// kanban UI for a "try it in the browser" demo.
//
// Shape parity matters more than internal cleanliness here: every response
// has to look enough like the server's JSON that the UI doesn't notice.

const DB_NAME = "starscape-orbit-preview";
const DB_VERSION = 1;
const BOARD_ID = "preview-board";

// Object stores (each is a SQL table, roughly).
const STORES = [
  "boards", // single record id=BOARD_ID
  "states", // {id, board_id, name, position, is_default, role, created_at}
  "labels", // {id, board_id, name, color, created_at}
  "tickets", // full ticket row (no joins)
  "ticket_labels", // {ticket_id, label_id} composite key as `${ticket_id}|${label_id}`
  "comments", // {id, ticket_id, author, kind, body, created_at}
  "relations", // {id, source_ticket_id, target_ticket_id, kind, created_at, ...}
  "board_entries", // {id, board_id, type, title, body, ticket_id, struck_at, created_at, updated_at}
  "events", // {id, board_id, ticket_id, type, actor, body_json, created_at}
  "meta" // {key, value} — schema_seeded, etc.
];

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (db.objectStoreNames.contains(name)) continue;
        if (name === "ticket_labels") {
          const store = db.createObjectStore(name, { keyPath: "key" });
          store.createIndex("ticket_id", "ticket_id");
          store.createIndex("label_id", "label_id");
        } else if (name === "meta") {
          db.createObjectStore(name, { keyPath: "key" });
        } else {
          const store = db.createObjectStore(name, { keyPath: "id" });
          if (name === "tickets") {
            store.createIndex("board_id", "board_id");
            store.createIndex("number", "number");
            store.createIndex("parent_ticket_id", "parent_ticket_id");
          }
          if (name === "comments" || name === "events") {
            store.createIndex("ticket_id", "ticket_id");
          }
          if (name === "relations") {
            store.createIndex("source_ticket_id", "source_ticket_id");
            store.createIndex("target_ticket_id", "target_ticket_id");
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, storeNames, mode = "readonly") {
  const t = db.transaction(storeNames, mode);
  const stores = {};
  for (const name of storeNames) stores[name] = t.objectStore(name);
  const done = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return { stores, done };
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAll(store, query, indexName) {
  const target = indexName ? store.index(indexName) : store;
  return reqPromise(target.getAll(query));
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers

function uid() {
  return crypto.randomUUID();
}
function nowIso() {
  return new Date().toISOString();
}
function tlKey(ticketId, labelId) {
  return `${ticketId}|${labelId}`;
}
function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "label";
}
function err(status, code) {
  const e = new Error(code);
  e.status = status;
  e.payload = { error: code };
  return e;
}

// ──────────────────────────────────────────────────────────────────────────
// Seed (one-shot, mirrors src/core/seed.js minus the parent-cycle business)

async function seedIfEmpty(db) {
  const { stores: ro } = tx(db, ["meta"], "readonly");
  const seeded = await reqPromise(ro.meta.get("schema_seeded"));
  if (seeded?.value) return;

  const t = nowIso();
  const stateRows = [
    ["Backlog", null],
    ["Todo", null],
    ["In Progress", "in_progress"],
    ["Review", "review"],
    ["Done", "done"],
    ["Cancelled", null]
  ].map(([name, role], position) => ({
    id: uid(),
    board_id: BOARD_ID,
    name,
    position,
    is_default: name === "Todo" ? 1 : 0,
    role,
    created_at: t
  }));
  const stateByName = Object.fromEntries(stateRows.map((s) => [s.name, s]));

  const labelRows = [
    ["human-only", "#7c2d12"],
    ["needs-human-input", "#dc2626"],
    ["needs-decomposition", "#9333ea"],
    ["needs-followup", "#b45309"],
    ["tech-debt", "#64748b"],
    ["security", "#991b1b"],
    ["onboarding", "#0f766e"]
  ].map(([name, color]) => ({
    id: uid(),
    board_id: BOARD_ID,
    name,
    color,
    created_at: t
  }));
  const labelByName = Object.fromEntries(labelRows.map((l) => [l.name, l]));

  const board = {
    id: BOARD_ID,
    slug: "preview",
    name: "Preview Board",
    repo_url: "",
    system_path: "",
    default_branch: "main",
    project_notes:
      "This preview lives entirely in your browser (IndexedDB). Use it to try the flow; export the snapshot from Settings → Repository when you want to move to a real Orbit install.",
    agent_instructions:
      "Preview edition has no agent or MCP integration. The full Orbit install (npm i -g starscape-orbit && orbit init) provides those.",
    ai_enabled: 0,
    repo_path: "",
    created_at: t,
    updated_at: t
  };

  const tickets = [];
  const ticketLabels = [];
  const comments = [];

  function addTicket(number, fields) {
    const id = uid();
    tickets.push({
      id,
      board_id: BOARD_ID,
      number,
      title: fields.title,
      description: fields.description,
      type: fields.type,
      parent_ticket_id: fields.parentTicketId || null,
      ai_plan: fields.aiPlan || "",
      implementation_summary: "",
      implementation_updates: "",
      state_id: fields.stateId,
      priority: fields.priority,
      created_by: "system",
      archived_at: null,
      created_at: t,
      updated_at: t
    });
    for (const labelId of fields.labels || []) {
      ticketLabels.push({ key: tlKey(id, labelId), ticket_id: id, label_id: labelId });
    }
    return id;
  }

  const epicId = addTicket(1, {
    title: "Try the preview kanban",
    description:
      "This onboarding card is for the in-browser preview. Drag it across lanes, edit fields, add comments — it all stays in this browser only.",
    type: "epic",
    aiPlan: "1. Drag this card to In Progress.\n2. Add a comment.\n3. Export the snapshot from Settings → Repository.",
    stateId: stateByName.Todo.id,
    priority: 4,
    labels: [labelByName["onboarding"].id, labelByName["needs-decomposition"].id]
  });

  addTicket(2, {
    title: "Edit a card and watch it persist",
    description: "Click into a card, change its title, refresh — your edit survives because it lives in IndexedDB.",
    type: "feature",
    parentTicketId: epicId,
    stateId: stateByName.Todo.id,
    priority: 3,
    labels: [labelByName["onboarding"].id]
  });

  addTicket(3, {
    title: "Move me to In Progress",
    description: "Drag this card to the In Progress lane, then to Review.",
    type: "task",
    parentTicketId: epicId,
    stateId: stateByName.Backlog.id,
    priority: 2,
    labels: [labelByName["onboarding"].id]
  });

  addTicket(4, {
    title: "Export your snapshot when ready",
    description: "Settings → Repository → Export downloads a JSON snapshot you can import into a real Orbit install.",
    type: "task",
    stateId: stateByName.Backlog.id,
    priority: 1,
    labels: [labelByName["onboarding"].id]
  });

  comments.push({
    id: uid(),
    ticket_id: epicId,
    author: "system",
    kind: "note",
    body: "Welcome to the Orbit preview. Everything lives in your browser.",
    created_at: t
  });

  const { stores, done } = tx(
    db,
    ["boards", "states", "labels", "tickets", "ticket_labels", "comments", "meta"],
    "readwrite"
  );
  stores.boards.put(board);
  stateRows.forEach((r) => stores.states.put(r));
  labelRows.forEach((r) => stores.labels.put(r));
  tickets.forEach((r) => stores.tickets.put(r));
  ticketLabels.forEach((r) => stores.ticket_labels.put(r));
  comments.forEach((r) => stores.comments.put(r));
  stores.meta.put({ key: "schema_seeded", value: true });
  await done;
}

// ──────────────────────────────────────────────────────────────────────────
// Snapshot helpers (full DB read, used by bootstrap / context / export)

async function readBoardSnapshot(db) {
  const { stores } = tx(
    db,
    [
      "boards",
      "states",
      "labels",
      "tickets",
      "ticket_labels",
      "comments",
      "relations",
      "board_entries",
      "events"
    ],
    "readonly"
  );
  const [board, states, labels, tickets, ticketLabels, comments, relations, boardEntries, events] = await Promise.all([
    reqPromise(stores.boards.get(BOARD_ID)),
    getAll(stores.states),
    getAll(stores.labels),
    getAll(stores.tickets),
    getAll(stores.ticket_labels),
    getAll(stores.comments),
    getAll(stores.relations),
    getAll(stores.board_entries),
    getAll(stores.events)
  ]);
  return { board, states, labels, tickets, ticketLabels, comments, relations, boardEntries, events };
}

function decorateTickets(snapshot, includeArchived = false) {
  const { board, states, labels, tickets, ticketLabels, comments } = snapshot;
  const labelById = Object.fromEntries(labels.map((l) => [l.id, l]));
  const stateById = Object.fromEntries(states.map((s) => [s.id, s]));
  const visible = tickets.filter((t) => includeArchived || !t.archived_at);
  const sorted = [...visible].sort((a, b) => {
    const byTime = String(b.updated_at).localeCompare(String(a.updated_at));
    if (byTime !== 0) return byTime;
    return String(a.id).localeCompare(String(b.id));
  });
  return sorted.map((ticket) => {
    const stateRow = stateById[ticket.state_id];
    const tLabels = ticketLabels
      .filter((tl) => tl.ticket_id === ticket.id)
      .map((tl) => labelById[tl.label_id])
      .filter(Boolean)
      .map((l) => ({ ticket_id: ticket.id, id: l.id, name: l.name, color: l.color }));
    const commentCount = comments.filter((c) => c.ticket_id === ticket.id).length;
    const childCount = tickets.filter((t) => t.parent_ticket_id === ticket.id && !t.archived_at).length;
    const parent = ticket.parent_ticket_id ? tickets.find((t) => t.id === ticket.parent_ticket_id) : null;
    const parentState = parent ? stateById[parent.state_id] : null;
    return {
      ...ticket,
      state_name: stateRow?.name || "",
      state_role: stateRow?.role || null,
      board_slug: board.slug,
      board_name: board.name,
      labels: tLabels,
      comment_count: commentCount,
      child_count: childCount,
      parent_ticket: parent
        ? {
            id: parent.id,
            board_id: parent.board_id,
            board_slug: board.slug,
            number: parent.number,
            title: parent.title,
            type: parent.type,
            state_name: parentState?.name || "",
            state_role: parentState?.role || null,
            priority: parent.priority
          }
        : null
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Mutation helpers

async function putAndEvent(db, mutate) {
  const { stores, done } = tx(
    db,
    ["boards", "states", "labels", "tickets", "ticket_labels", "comments", "relations", "board_entries", "events"],
    "readwrite"
  );
  const result = await mutate(stores);
  await done;
  return result;
}

function recordEvent(stores, type, ticketId, body) {
  const ev = {
    id: uid(),
    board_id: BOARD_ID,
    ticket_id: ticketId || null,
    type,
    actor: "you",
    body_json: JSON.stringify(body || {}),
    created_at: nowIso()
  };
  stores.events.put(ev);
  return ev;
}

async function ensureLabel(stores, name) {
  const all = await getAll(stores.labels);
  const existing = all.find((l) => l.name.toLowerCase() === String(name).toLowerCase());
  if (existing) return existing;
  const created = {
    id: uid(),
    board_id: BOARD_ID,
    name: slugify(name),
    color: "#64748b",
    created_at: nowIso()
  };
  stores.labels.put(created);
  return created;
}

// ──────────────────────────────────────────────────────────────────────────
// Handlers

async function handleBootstrap() {
  const db = await openDb();
  await seedIfEmpty(db);
  const snap = await readBoardSnapshot(db);
  const tickets = decorateTickets(snap);
  return {
    actor: { name: "you", role: "owner" },
    meta: { db_path: null, export_dir: null },
    boards: [snap.board],
    board_entries: [...snap.boardEntries].sort((a, b) =>
      String(b.created_at).localeCompare(String(a.created_at))
    ),
    states: [...snap.states].sort((a, b) => a.position - b.position),
    labels: [...snap.labels].sort((a, b) => a.name.localeCompare(b.name)),
    tickets
  };
}

async function handleBoardsList() {
  const db = await openDb();
  await seedIfEmpty(db);
  const { stores } = tx(db, ["boards"], "readonly");
  const board = await reqPromise(stores.boards.get(BOARD_ID));
  return {
    boards: [
      {
        id: board.id,
        slug: board.slug,
        name: board.name,
        repo_path: board.repo_path || "",
        repo_url: board.repo_url || "",
        default_branch: board.default_branch,
        db_path: null,
        last_active_at: board.updated_at
      }
    ]
  };
}

async function handleBoardContext(boardId, includeStruck) {
  if (boardId !== BOARD_ID) throw err(404, "board_not_found");
  const db = await openDb();
  await seedIfEmpty(db);
  const snap = await readBoardSnapshot(db);
  const entries = (includeStruck ? snap.boardEntries : snap.boardEntries.filter((e) => !e.struck_at)).sort(
    (a, b) => String(b.created_at).localeCompare(String(a.created_at))
  );
  return {
    board: snap.board,
    entries,
    deployment: { app_root: "browser", system_path: "", data_dir: "", mcp_server_path: "", db_path: null }
  };
}

async function handleBoardArchive(boardId) {
  if (boardId !== BOARD_ID) throw err(404, "board_not_found");
  const db = await openDb();
  const snap = await readBoardSnapshot(db);
  const tickets = decorateTickets(snap, true).filter((t) => t.archived_at);
  return { tickets };
}

async function handleBoardPatch(boardId, body) {
  if (boardId !== BOARD_ID) throw err(404, "board_not_found");
  const db = await openDb();
  return putAndEvent(db, async (stores) => {
    const board = await reqPromise(stores.boards.get(BOARD_ID));
    const ALLOWED = [
      "name",
      "slug",
      "repo_url",
      "system_path",
      "default_branch",
      "project_notes",
      "agent_instructions",
      "ai_enabled"
    ];
    for (const k of ALLOWED) if (k in body) board[k] = body[k];
    board.updated_at = nowIso();
    stores.boards.put(board);
    recordEvent(stores, "board_updated", null, { fields: Object.keys(body) });
    return board;
  });
}

async function handleBoardEntries(boardId, body) {
  if (boardId !== BOARD_ID) throw err(404, "board_not_found");
  const db = await openDb();
  return putAndEvent(db, async (stores) => {
    const entry = {
      id: uid(),
      board_id: BOARD_ID,
      type: body.type || "note",
      title: body.title || "",
      body: body.body || "",
      ticket_id: body.ticket_id || null,
      struck_at: null,
      created_by: "you",
      created_at: nowIso(),
      updated_at: nowIso()
    };
    stores.board_entries.put(entry);
    recordEvent(stores, "board_entry_created", entry.ticket_id, { entry_id: entry.id, type: entry.type });
    return entry;
  });
}

async function handleBoardEntryPatch(entryId, body) {
  const db = await openDb();
  return putAndEvent(db, async (stores) => {
    const entry = await reqPromise(stores.board_entries.get(entryId));
    if (!entry) throw err(404, "board_entry_not_found");
    const shouldStrike = Boolean(body.struck);
    entry.struck_at = shouldStrike ? entry.struck_at || nowIso() : null;
    entry.updated_at = nowIso();
    stores.board_entries.put(entry);
    return entry;
  });
}

async function handleStateCreate(boardId, body) {
  if (boardId !== BOARD_ID) throw err(404, "board_not_found");
  const db = await openDb();
  return putAndEvent(db, async (stores) => {
    const states = await getAll(stores.states);
    const maxPos = states.reduce((a, s) => Math.max(a, s.position), -1);
    const state = {
      id: uid(),
      board_id: BOARD_ID,
      name: body.name || "New",
      position: maxPos + 1,
      is_default: 0,
      role: body.role || null,
      created_at: nowIso()
    };
    stores.states.put(state);
    recordEvent(stores, "state_created", null, { state_id: state.id });
    return state;
  });
}

async function handleStatePatch(stateId, body) {
  const db = await openDb();
  return putAndEvent(db, async (stores) => {
    const state = await reqPromise(stores.states.get(stateId));
    if (!state) throw err(404, "state_not_found");
    for (const k of ["name", "role"]) if (k in body) state[k] = body[k];
    stores.states.put(state);
    return state;
  });
}

async function handleStateDelete(stateId) {
  const db = await openDb();
  return putAndEvent(db, async (stores) => {
    const state = await reqPromise(stores.states.get(stateId));
    if (!state) throw err(404, "state_not_found");
    const tickets = await getAll(stores.tickets);
    if (tickets.some((t) => t.state_id === stateId && !t.archived_at)) {
      throw err(409, "state_has_tickets");
    }
    stores.states.delete(stateId);
    recordEvent(stores, "state_deleted", null, { state_id: stateId });
    return { ok: true };
  });
}

async function handleStateReorder(boardId, body) {
  if (boardId !== BOARD_ID) throw err(404, "board_not_found");
  const db = await openDb();
  return putAndEvent(db, async (stores) => {
    const order = body.order || body.state_ids || [];
    for (let i = 0; i < order.length; i++) {
      const state = await reqPromise(stores.states.get(order[i]));
      if (!state) continue;
      state.position = i;
      stores.states.put(state);
    }
    recordEvent(stores, "states_reordered", null, { order });
    const states = await getAll(stores.states);
    return { states: states.sort((a, b) => a.position - b.position) };
  });
}

// Mirrors src/core/tickets.js#bumpTicketUpdatedAt — rolls child activity up to
// the parent epic so the column sort (updated_at DESC) keeps the epic group
// near recent child activity even when only its children changed.
async function bumpTicketUpdatedAt(stores, ticketId, time) {
  if (!ticketId) return;
  const parent = await reqPromise(stores.tickets.get(ticketId));
  if (!parent) return;
  parent.updated_at = time;
  stores.tickets.put(parent);
}

async function handleTicketCreate(body) {
  const db = await openDb();
  return putAndEvent(db, async (stores) => {
    const states = await getAll(stores.states);
    const stateId =
      body.state_id ||
      states.find((s) => s.is_default)?.id ||
      states.sort((a, b) => a.position - b.position)[0]?.id;
    if (!stateId) throw err(400, "no_states");
    const tickets = await getAll(stores.tickets);
    const nextNumber = tickets.reduce((a, t) => Math.max(a, t.number || 0), 0) + 1;
    const ticket = {
      id: uid(),
      board_id: BOARD_ID,
      number: nextNumber,
      title: body.title || "Untitled",
      description: body.description || "",
      type: body.type || (body.parent_ticket_id ? "feature" : "task"),
      parent_ticket_id: body.parent_ticket_id || null,
      ai_plan: body.ai_plan || "",
      implementation_summary: body.implementation_summary || "",
      implementation_updates: body.implementation_updates || "",
      state_id: stateId,
      priority: body.priority ?? 0,
      created_by: "you",
      archived_at: null,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    stores.tickets.put(ticket);
    for (const name of body.labels || []) {
      const label = await ensureLabel(stores, name);
      stores.ticket_labels.put({ key: tlKey(ticket.id, label.id), ticket_id: ticket.id, label_id: label.id });
    }
    recordEvent(stores, "ticket_created", ticket.id, { title: ticket.title, type: ticket.type });
    await bumpTicketUpdatedAt(stores, ticket.parent_ticket_id, ticket.updated_at);
    return ticket;
  });
}

async function handleTicketPatch(ticketId, body) {
  const db = await openDb();
  return putAndEvent(db, async (stores) => {
    const ticket = await reqPromise(stores.tickets.get(ticketId));
    if (!ticket) throw err(404, "ticket_not_found");
    const oldStateId = ticket.state_id;
    const oldParentId = ticket.parent_ticket_id;
    const SIMPLE = [
      "title",
      "description",
      "type",
      "parent_ticket_id",
      "ai_plan",
      "implementation_summary",
      "implementation_updates",
      "priority"
    ];
    for (const k of SIMPLE) if (k in body) ticket[k] = body[k];
    if ("state_id" in body) ticket.state_id = body.state_id;
    ticket.updated_at = nowIso();
    stores.tickets.put(ticket);

    if ("labels" in body) {
      const existing = await getAll(stores.ticket_labels, ticketId, "ticket_id");
      for (const row of existing) stores.ticket_labels.delete(row.key);
      for (const name of body.labels || []) {
        const label = await ensureLabel(stores, name);
        stores.ticket_labels.put({ key: tlKey(ticketId, label.id), ticket_id: ticketId, label_id: label.id });
      }
    }

    if (oldStateId !== ticket.state_id) {
      const states = await getAll(stores.states);
      const fromState = states.find((s) => s.id === oldStateId);
      const toState = states.find((s) => s.id === ticket.state_id);
      // Mirror tickets.js: when a ticket lands in role='done', auto-delete
      // every relation row that names it as a blocker.
      if (toState?.role === "done" && fromState?.role !== "done") {
        const relations = await getAll(stores.relations);
        for (const r of relations) {
          if ((r.source_ticket_id === ticketId && r.type === "blocks") ||
              (r.target_ticket_id === ticketId && r.type === "blocked_by")) {
            stores.relations.delete(r.id);
          }
        }
      }
      recordEvent(stores, "state_changed", ticketId, { from: fromState?.name || "", to: toState?.name || "" });
    } else {
      recordEvent(stores, "ticket_updated", ticketId, { fields: Object.keys(body) });
    }
    await bumpTicketUpdatedAt(stores, oldParentId, ticket.updated_at);
    if (ticket.parent_ticket_id && ticket.parent_ticket_id !== oldParentId) {
      await bumpTicketUpdatedAt(stores, ticket.parent_ticket_id, ticket.updated_at);
    }
    return ticket;
  });
}

async function handleTicketDelete(ticketId) {
  const db = await openDb();
  return putAndEvent(db, async (stores) => {
    const ticket = await reqPromise(stores.tickets.get(ticketId));
    if (!ticket) throw err(404, "ticket_not_found");
    stores.tickets.delete(ticketId);
    const tlinks = await getAll(stores.ticket_labels, ticketId, "ticket_id");
    for (const row of tlinks) stores.ticket_labels.delete(row.key);
    const cmts = await getAll(stores.comments, ticketId, "ticket_id");
    for (const c of cmts) stores.comments.delete(c.id);
    recordEvent(stores, "ticket_deleted", ticketId, {});
    await bumpTicketUpdatedAt(stores, ticket.parent_ticket_id, nowIso());
    return { ok: true };
  });
}

async function handleTicketArchive(ticketId, archive) {
  const db = await openDb();
  return putAndEvent(db, async (stores) => {
    const ticket = await reqPromise(stores.tickets.get(ticketId));
    if (!ticket) throw err(404, "ticket_not_found");
    ticket.archived_at = archive ? nowIso() : null;
    ticket.updated_at = nowIso();
    stores.tickets.put(ticket);
    recordEvent(stores, archive ? "ticket_archived" : "ticket_restored", ticketId, {});
    await bumpTicketUpdatedAt(stores, ticket.parent_ticket_id, ticket.updated_at);
    return ticket;
  });
}

async function handleTicketContext(ticketId) {
  const db = await openDb();
  const snap = await readBoardSnapshot(db);
  const ticket = snap.tickets.find((t) => t.id === ticketId);
  if (!ticket) throw err(404, "ticket_not_found");
  const labels = snap.ticketLabels
    .filter((tl) => tl.ticket_id === ticketId)
    .map((tl) => snap.labels.find((l) => l.id === tl.label_id))
    .filter(Boolean)
    .map((l) => ({ ticket_id: ticketId, id: l.id, name: l.name, color: l.color }));
  const comments = snap.comments
    .filter((c) => c.ticket_id === ticketId)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const stateById = Object.fromEntries(snap.states.map((s) => [s.id, s]));
  const compact = (t) => {
    if (!t) return null;
    const s = stateById[t.state_id];
    return {
      id: t.id,
      board_id: t.board_id,
      board_slug: snap.board.slug,
      number: t.number,
      title: t.title,
      type: t.type,
      state_name: s?.name || "",
      state_role: s?.role || null,
      priority: t.priority
    };
  };
  const parent = ticket.parent_ticket_id ? snap.tickets.find((t) => t.id === ticket.parent_ticket_id) : null;
  const childTickets = snap.tickets
    .filter((t) => t.parent_ticket_id === ticketId && !t.archived_at)
    .map((child) => ({
      ...child,
      labels: snap.ticketLabels
        .filter((tl) => tl.ticket_id === child.id)
        .map((tl) => snap.labels.find((l) => l.id === tl.label_id))
        .filter(Boolean)
        .map((l) => ({ ticket_id: child.id, id: l.id, name: l.name, color: l.color })),
      blockers: [],
      child_count: snap.tickets.filter((t) => t.parent_ticket_id === child.id && !t.archived_at).length
    }));
  const relations = snap.relations
    .filter((r) => r.source_ticket_id === ticketId || r.target_ticket_id === ticketId)
    .map((r) => {
      const otherId = r.source_ticket_id === ticketId ? r.target_ticket_id : r.source_ticket_id;
      const other = snap.tickets.find((t) => t.id === otherId);
      return {
        ...r,
        direction: r.source_ticket_id === ticketId ? "outgoing" : "incoming",
        other_ticket: compact(other)
      };
    });
  return {
    ticket: { ...ticket, labels },
    board: snap.board,
    board_manual: { entries: snap.boardEntries.filter((e) => !e.struck_at) },
    comments,
    parent_ticket: compact(parent),
    child_tickets: childTickets,
    relations,
    blockers: [],
    related_tickets: [...childTickets, ...(parent ? [parent] : [])],
    related_comments: []
  };
}

async function handleTicketHistory(ticketId) {
  const db = await openDb();
  const { stores } = tx(db, ["events"], "readonly");
  const events = await getAll(stores.events, ticketId, "ticket_id");
  return events
    .filter((e) => ["state_changed", "checkpoint_requested", "agent_completed"].includes(e.type))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map((e) => ({ ...e, body: safeJson(e.body_json) }));
}

function safeJson(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

async function handleCommentCreate(ticketId, body) {
  const db = await openDb();
  return putAndEvent(db, async (stores) => {
    const ticket = await reqPromise(stores.tickets.get(ticketId));
    if (!ticket) throw err(404, "ticket_not_found");
    const time = nowIso();
    const comment = {
      id: uid(),
      ticket_id: ticketId,
      author: "you",
      kind: body.kind || "note",
      body: body.body || "",
      created_at: time
    };
    stores.comments.put(comment);
    ticket.updated_at = time;
    stores.tickets.put(ticket);
    recordEvent(stores, "comment_created", ticketId, { kind: comment.kind });
    await bumpTicketUpdatedAt(stores, ticket.parent_ticket_id, time);
    return comment;
  });
}

async function handleRelationCreate(body) {
  const db = await openDb();
  return putAndEvent(db, async (stores) => {
    const relation = {
      id: uid(),
      board_id: BOARD_ID,
      source_ticket_id: body.source_ticket_id,
      target_ticket_id: body.target_ticket_id,
      kind: body.kind || "related",
      created_by: "you",
      created_at: nowIso()
    };
    stores.relations.put(relation);
    return relation;
  });
}

async function handleRelationDelete(relationId) {
  const db = await openDb();
  return putAndEvent(db, async (stores) => {
    stores.relations.delete(relationId);
    return { ok: true };
  });
}

async function handleSearch(query) {
  const db = await openDb();
  const snap = await readBoardSnapshot(db);
  const q = String(query || "").toLowerCase().trim();
  if (!q) return { tickets: [] };
  const tickets = decorateTickets(snap).filter((t) => {
    const haystack = [t.title, t.description, t.ai_plan, t.implementation_summary, `#${t.number}`]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
  return { tickets: tickets.slice(0, 50) };
}

async function handleExport(boardId) {
  if (boardId !== BOARD_ID) throw err(404, "board_not_found");
  const db = await openDb();
  const snap = await readBoardSnapshot(db);
  return {
    schema: "orbit.board.snapshot/v1",
    exported_at: nowIso(),
    board: snap.board,
    states: snap.states,
    labels: snap.labels,
    tickets: snap.tickets,
    ticket_labels: snap.ticketLabels,
    comments: snap.comments,
    relations: snap.relations,
    board_entries: snap.boardEntries
  };
}

async function handleImport(body) {
  const snapshot = body.snapshot || body;
  if (!snapshot || !snapshot.board) throw err(400, "invalid_snapshot");
  const db = await openDb();
  return putAndEvent(db, async (stores) => {
    // Replace within this single browser-board: clear stores then load.
    for (const name of [
      "states",
      "labels",
      "tickets",
      "ticket_labels",
      "comments",
      "relations",
      "board_entries"
    ]) {
      const all = await getAll(stores[name]);
      for (const row of all) stores[name].delete(row.key ?? row.id);
    }
    const incomingBoard = { ...snapshot.board, id: BOARD_ID };
    stores.boards.put(incomingBoard);
    (snapshot.states || []).forEach((s) => stores.states.put({ ...s, board_id: BOARD_ID }));
    (snapshot.labels || []).forEach((l) => stores.labels.put({ ...l, board_id: BOARD_ID }));
    (snapshot.tickets || []).forEach((t) => stores.tickets.put({ ...t, board_id: BOARD_ID }));
    (snapshot.ticket_labels || []).forEach((tl) =>
      stores.ticket_labels.put({ ...tl, key: tl.key || tlKey(tl.ticket_id, tl.label_id) })
    );
    (snapshot.comments || []).forEach((c) => stores.comments.put(c));
    (snapshot.relations || []).forEach((r) => stores.relations.put({ ...r, board_id: BOARD_ID }));
    (snapshot.board_entries || []).forEach((e) => stores.board_entries.put({ ...e, board_id: BOARD_ID }));
    recordEvent(stores, "board_imported", null, { source: snapshot.board?.slug });
    return { imported: true };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Dispatch — match transport.js's contract: request({method, path, body})

const ROUTES = [
  { m: "GET", re: /^\/api\/bootstrap$/, fn: () => handleBootstrap() },
  { m: "GET", re: /^\/api\/boards$/, fn: () => handleBoardsList() },
  { m: "POST", re: /^\/api\/boards$/, fn: () => { throw err(403, "preview_is_single_board"); } },
  { m: "GET", re: /^\/api\/boards\/([^/]+)\/context$/, fn: (m, u) => handleBoardContext(decodeURIComponent(m[1]), u.searchParams.get("include_struck") === "true") },
  { m: "GET", re: /^\/api\/boards\/([^/]+)\/archive$/, fn: (m) => handleBoardArchive(decodeURIComponent(m[1])) },
  { m: "GET", re: /^\/api\/boards\/([^/]+)\/export$/, fn: (m) => handleExport(decodeURIComponent(m[1])) },
  { m: "PATCH", re: /^\/api\/boards\/([^/]+)$/, fn: (m, u, body) => handleBoardPatch(decodeURIComponent(m[1]), body) },
  { m: "POST", re: /^\/api\/boards\/([^/]+)\/entries$/, fn: (m, u, body) => handleBoardEntries(decodeURIComponent(m[1]), body) },
  { m: "POST", re: /^\/api\/boards\/([^/]+)\/states$/, fn: (m, u, body) => handleStateCreate(decodeURIComponent(m[1]), body) },
  { m: "PATCH", re: /^\/api\/boards\/([^/]+)\/states$/, fn: (m, u, body) => handleStateReorder(decodeURIComponent(m[1]), body) },
  { m: "PATCH", re: /^\/api\/board-entries\/([^/]+)$/, fn: (m, u, body) => handleBoardEntryPatch(decodeURIComponent(m[1]), body) },
  { m: "POST", re: /^\/api\/states$/, fn: (m, u, body) => handleStateCreate(BOARD_ID, body) },
  { m: "PATCH", re: /^\/api\/states\/([^/]+)$/, fn: (m, u, body) => handleStatePatch(decodeURIComponent(m[1]), body) },
  { m: "DELETE", re: /^\/api\/states\/([^/]+)$/, fn: (m) => handleStateDelete(decodeURIComponent(m[1])) },
  { m: "POST", re: /^\/api\/tickets$/, fn: (m, u, body) => handleTicketCreate(body) },
  { m: "PATCH", re: /^\/api\/tickets\/([^/]+)$/, fn: (m, u, body) => handleTicketPatch(decodeURIComponent(m[1]), body) },
  { m: "DELETE", re: /^\/api\/tickets\/([^/]+)$/, fn: (m) => handleTicketDelete(decodeURIComponent(m[1])) },
  { m: "POST", re: /^\/api\/tickets\/([^/]+)\/archive$/, fn: (m) => handleTicketArchive(decodeURIComponent(m[1]), true) },
  { m: "POST", re: /^\/api\/tickets\/([^/]+)\/restore$/, fn: (m) => handleTicketArchive(decodeURIComponent(m[1]), false) },
  { m: "GET", re: /^\/api\/tickets\/([^/]+)\/context$/, fn: (m) => handleTicketContext(decodeURIComponent(m[1])) },
  { m: "GET", re: /^\/api\/tickets\/([^/]+)\/history$/, fn: (m) => handleTicketHistory(decodeURIComponent(m[1])) },
  { m: "POST", re: /^\/api\/tickets\/([^/]+)\/comments$/, fn: (m, u, body) => handleCommentCreate(decodeURIComponent(m[1]), body) },
  { m: "POST", re: /^\/api\/relations$/, fn: (m, u, body) => handleRelationCreate(body) },
  { m: "DELETE", re: /^\/api\/relations\/([^/]+)$/, fn: (m) => handleRelationDelete(decodeURIComponent(m[1])) },
  { m: "GET", re: /^\/api\/search$/, fn: (m, u) => handleSearch(u.searchParams.get("q")) },
  { m: "POST", re: /^\/api\/admin\/import$/, fn: (m, u, body) => handleImport(body) }
];

export async function request({ method = "GET", path, body }) {
  const url = new URL(path, "http://local");
  for (const route of ROUTES) {
    if (route.m !== method) continue;
    const m = url.pathname.match(route.re);
    if (!m) continue;
    return route.fn(m, url, body || {});
  }
  throw err(404, "not_found");
}
