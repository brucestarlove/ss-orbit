import { resetBoard, tx, getRegistry } from "./db.js";
import { backupBoardDatabase } from "./backups.js";
import { boardById, labelsForTicket } from "./queries.js";
import { requireBoardAccess } from "./auth.js";
import { recordEvent } from "./events.js";
import { computeNewBoardDbPath, ensureBoardDbFileAndSchema, syncRegistryFromBoardDb } from "./registry.js";
import {
  httpError,
  id,
  normalizePriority,
  normalizeProjectEntryType,
  normalizeTicketType,
  now,
  normalizePath,
  requiredString,
  slugify
} from "./util.js";
import { reindexAllTickets } from "./tickets.js";
import {
  attachmentRowsForBoard,
  importAttachmentRows,
  serializeAttachmentForExport
} from "./attachments.js";

export function exportBoard(boardId, ctx, options = {}) {
  const { db, board, actor } = ctx;
  if (boardId !== board.id) throw httpError(404, "board_not_found");
  const innerBoard = boardById(db, boardId);
  if (!innerBoard) throw httpError(404, "board_not_found");
  requireBoardAccess(actor, innerBoard);

  const states = db.prepare("SELECT * FROM states WHERE board_id = ? ORDER BY position").all(boardId);
  const tickets = db
    .prepare("SELECT * FROM tickets WHERE board_id = ? ORDER BY number ASC")
    .all(boardId)
    .map((ticket) => ({ ...ticket, labels: labelsForTicket(db, ticket.id) }));
  const ticketIds = tickets.map((ticket) => ticket.id);
  const comments = ticketIds.length
    ? db
        .prepare("SELECT * FROM comments WHERE ticket_id IN (SELECT id FROM tickets WHERE board_id = ?) ORDER BY created_at ASC")
        .all(boardId)
    : [];
  const reviewVerdicts = ticketIds.length
    ? db
        .prepare("SELECT * FROM review_verdicts WHERE ticket_id IN (SELECT id FROM tickets WHERE board_id = ?) ORDER BY created_at ASC")
        .all(boardId)
    : [];
  const relations = ticketIds.length
    ? db
        .prepare(
          `SELECT *
           FROM relations
           WHERE source_ticket_id IN (SELECT id FROM tickets WHERE board_id = ?)
              OR target_ticket_id IN (SELECT id FROM tickets WHERE board_id = ?)
           ORDER BY created_at ASC`
        )
        .all(boardId, boardId)
    : [];
  const entries = db
    .prepare("SELECT * FROM board_entries WHERE board_id = ? ORDER BY created_at ASC")
    .all(boardId);
  const labels = db.prepare("SELECT * FROM labels WHERE board_id = ? ORDER BY name ASC").all(boardId);
  const events = db
    .prepare(
      `SELECT *
       FROM events
       WHERE ticket_id IS NULL
          OR ticket_id IN (SELECT id FROM tickets WHERE board_id = ?)
       ORDER BY created_at ASC`
    )
    .all(boardId);
  const attachments = attachmentRowsForBoard(db, boardId).map((row) =>
    serializeAttachmentForExport(board, row, Boolean(options.includeAttachments))
  );

  return {
    format: "orbit-board-export",
    version: 7,
    exported_at: now(),
    include_attachments: Boolean(options.includeAttachments),
    board: { ...innerBoard },
    states,
    labels,
    tickets,
    comments,
    review_verdicts: reviewVerdicts,
    relations,
    attachments,
    board_entries: entries,
    events
  };
}

export function importBoardSnapshot(body, ctx) {
  const { db, actor, board } = ctx;
  const snapshot = normalizeImportSnapshot(body?.snapshot || body, ctx);
  const format = snapshot?.format;
  if (!snapshot || format !== "orbit-board-export") throw httpError(400, "invalid_import_snapshot");
  if (!snapshot.board) throw httpError(400, "snapshot_missing_board");

  const replaceExisting = Boolean(body?.replace_existing);
  const existingCount = db.prepare("SELECT COUNT(*) AS count FROM boards").get().count;
  if (existingCount > 0 && !replaceExisting) {
    throw httpError(409, "import_requires_empty_board_or_replace_existing");
  }

  // Snapshot the existing DB file before a destructive replace, outside the
  // transaction (it copies the file on disk, not rows).
  if (existingCount > 0 && replaceExisting) {
    backupBoardDatabase(ctx.board, db, "pre-import-replace");
  }

  const targetBoardId = board.id;
  const importedBoard = {
    ...snapshot.board,
    id: targetBoardId
  };

  const result = tx(db, () => {
    if (existingCount > 0 && replaceExisting) resetBoard(db);

    db.prepare(
      `INSERT INTO boards
       (id, slug, name, repo_url, system_path, default_branch,
        project_notes, agent_instructions, ai_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      importedBoard.id,
      importedBoard.slug,
      importedBoard.name,
      importedBoard.repo_url || "",
      importedBoard.system_path || "",
      importedBoard.default_branch || "main",
      importedBoard.project_notes || "",
      importedBoard.agent_instructions || "",
      importedBoard.ai_enabled === 0 ? 0 : 1,
      importedBoard.created_at || now(),
      importedBoard.updated_at || now()
    );

    for (const state of snapshot.states || []) {
      db.prepare(
        `INSERT INTO states
         (id, board_id, name, position, is_default, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        state.id,
        targetBoardId,
        state.name,
        state.position,
        state.is_default || 0,
        state.role || null,
        state.created_at || now()
      );
    }

    for (const label of snapshot.labels || []) {
      db.prepare("INSERT INTO labels (id, board_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)").run(
        label.id,
        targetBoardId,
        label.name,
        label.color || "#64748b",
        label.created_at || now()
      );
    }

    for (const ticket of snapshot.tickets || []) {
      db.prepare(
        `INSERT INTO tickets
         (id, board_id, number, title, description, type, parent_ticket_id, ai_plan,
          implementation_summary, implementation_updates, state_id, priority,
          created_by, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        ticket.id,
        targetBoardId,
        ticket.number,
        ticket.title,
        ticket.description || "",
        normalizeTicketType(ticket.type || "task"),
        ticket.parent_ticket_id || null,
        ticket.ai_plan || "",
        ticket.implementation_summary || "",
        ticket.implementation_updates || "",
        ticket.state_id,
        normalizePriority(ticket.priority),
        ticket.created_by || "import",
        ticket.created_at || now(),
        ticket.updated_at || now(),
        ticket.archived_at || null
      );

      for (const label of ticket.labels || []) {
        db.prepare("INSERT OR IGNORE INTO ticket_labels (ticket_id, label_id) VALUES (?, ?)").run(ticket.id, label.id);
      }
    }

    for (const comment of snapshot.comments || []) {
      db.prepare(
        "INSERT INTO comments (id, ticket_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        comment.id,
        comment.ticket_id,
        comment.author || "import",
        comment.kind || "comment",
        comment.body || "",
        comment.created_at || now()
      );
    }

    for (const review of snapshot.review_verdicts || []) {
      db.prepare(
        `INSERT INTO review_verdicts
         (id, ticket_id, verdict, blocking_findings_json, optional_findings_json,
          evidence_commands_json, reviewer_profile, reviewer_session_id,
          reviewed_commit_sha, dispatch_run_id, supersedes_prior_review_id,
          created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        review.id,
        review.ticket_id,
        review.verdict,
        review.blocking_findings_json || "[]",
        review.optional_findings_json || "[]",
        review.evidence_commands_json || "[]",
        review.reviewer_profile || "",
        review.reviewer_session_id || "",
        review.reviewed_commit_sha || "",
        review.dispatch_run_id || "",
        review.supersedes_prior_review_id || null,
        review.created_by || "import",
        review.created_at || now()
      );
    }

    for (const relation of snapshot.relations || []) {
      db.prepare(
        "INSERT OR IGNORE INTO relations (id, source_ticket_id, target_ticket_id, type, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(
        relation.id,
        relation.source_ticket_id,
        relation.target_ticket_id,
        relation.type || "relates_to",
        relation.created_at || now()
      );
    }

    importAttachmentRows(snapshot, ctx, targetBoardId);

    for (const entry of snapshot.board_entries || []) {
      db.prepare(
        `INSERT INTO board_entries
         (id, board_id, type, title, body, ticket_id, created_by, created_at, updated_at, struck_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entry.id,
        targetBoardId,
        normalizeProjectEntryType(entry.type),
        requiredString(entry.title, "entry_title"),
        entry.body || "",
        entry.ticket_id || null,
        entry.created_by || "import",
        entry.created_at || now(),
        entry.updated_at || now(),
        entry.struck_at || null
      );
    }

    for (const event of snapshot.events || []) {
      db.prepare(
        "INSERT INTO events (id, ticket_id, actor, type, body_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        event.id,
        event.ticket_id || null,
        event.actor || "import",
        event.type || "imported_event",
        event.body_json || "{}",
        event.created_at || now()
      );
    }

    // Reindex inside the transaction: a committed import must never leave the
    // FTS table empty/stale (previously this ran after COMMIT and a throw here
    // left search broken on otherwise-imported data).
    reindexAllTickets(db);
    recordEvent(db, targetBoardId, "board_imported", null, actor.name, {
      board_id: targetBoardId,
      replace_existing: replaceExisting
    });
    return {
      ok: true,
      imported_board_id: targetBoardId,
      imported_board_slug: importedBoard.slug,
      replace_existing: replaceExisting,
      source_format: snapshot.source_format || "orbit-board-export",
      imported_counts: snapshot.imported_counts || {
        states: (snapshot.states || []).length,
        tickets: (snapshot.tickets || []).length,
        comments: (snapshot.comments || []).length,
        labels: (snapshot.labels || []).length
      }
    };
  });

  // Registry sync writes the separate registry DB (a different connection), so
  // it runs after the board-DB transaction commits, not inside it.
  syncRegistryFromBoardDb(board, db);
  return result;
}

export function importBoardSnapshotAsNewBoard(body, ctx) {
  const rawSnapshot = body?.snapshot || body;
  const actor = ctx.actor;
  const sourceBoard = ctx.board || {};
  const repoPath = normalizePath(body?.repo_path || body?.system_path || sourceBoard.repo_path || sourceBoard.system_path || process.cwd());
  const sourceFormatSnapshot = normalizeImportSnapshot(rawSnapshot, {
    ...ctx,
    board: {
      id: id(),
      slug: "",
      name: "",
      repo_path: repoPath,
      system_path: repoPath,
      repo_url: sourceBoard.repo_url || "",
      default_branch: sourceBoard.default_branch || "main"
    }
  });
  const format = sourceFormatSnapshot?.format;
  if (!sourceFormatSnapshot || format !== "orbit-board-export") throw httpError(400, "invalid_import_snapshot");
  if (!sourceFormatSnapshot.board) throw httpError(400, "snapshot_missing_board");

  const boardName = cleanText(sourceFormatSnapshot.board.name) || cleanText(rawSnapshot?.name) || "Imported Board";
  const boardSlug = uniqueImportedBoardSlug(body?.slug || sourceFormatSnapshot.board.slug || rawSnapshot?.name || boardName);
  const boardId = id();
  const dbPath = computeNewBoardDbPath(repoPath, boardSlug);
  const db = ensureBoardDbFileAndSchema(dbPath);
  const newBoardCtx = {
    actor,
    board: {
      id: boardId,
      slug: boardSlug,
      name: boardName,
      repo_path: repoPath,
      db_path: dbPath,
      system_path: repoPath,
      repo_url: sourceBoard.repo_url || sourceFormatSnapshot.board.repo_url || "",
      default_branch: sourceBoard.default_branch || sourceFormatSnapshot.board.default_branch || "main"
    },
    db
  };
  const normalizedSnapshot = normalizeImportSnapshot(rawSnapshot, newBoardCtx);
  const snapshotForNewBoard = {
    ...normalizedSnapshot,
    board: {
      ...normalizedSnapshot.board,
      id: boardId,
      slug: boardSlug,
      name: cleanText(normalizedSnapshot.board?.name) || boardName,
      repo_url: normalizedSnapshot.board?.repo_url || sourceBoard.repo_url || "",
      system_path: normalizedSnapshot.board?.system_path || repoPath,
      default_branch: normalizedSnapshot.board?.default_branch || sourceBoard.default_branch || "main"
    }
  };

  return {
    ...importBoardSnapshot({ snapshot: snapshotForNewBoard, replace_existing: false }, newBoardCtx),
    created_new_board: true
  };
}

function uniqueImportedBoardSlug(value) {
  const base = slugify(value) || `imported-board-${id().slice(0, 8)}`;
  const reg = getRegistry();
  if (!reg.prepare("SELECT id FROM boards WHERE slug = ?").get(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!reg.prepare("SELECT id FROM boards WHERE slug = ?").get(candidate)) return candidate;
  }
  return `${base}-${id().slice(0, 8)}`;
}

function normalizeImportSnapshot(snapshot, ctx) {
  if (snapshot?.format === "orbit-board-export") return snapshot;
  if (looksLikeTrelloExport(snapshot)) return trelloExportToOrbitSnapshot(snapshot, ctx);
  return snapshot;
}

function looksLikeTrelloExport(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray(value.cards) &&
      Array.isArray(value.lists) &&
      (typeof value.id === "string" || typeof value.name === "string")
  );
}

const TRELLO_LABEL_COLORS = {
  green: "#61bd4f",
  yellow: "#f2d600",
  orange: "#ff9f1a",
  red: "#eb5a46",
  purple: "#c377e0",
  blue: "#0079bf",
  sky: "#00c2e0",
  lime: "#51e898",
  pink: "#ff78cb",
  black: "#344563"
};

function trelloExportToOrbitSnapshot(trello, ctx) {
  const time = now();
  const targetBoard = ctx.board || {};
  const boardName = cleanText(trello.name) || "Imported Trello Board";
  const boardSlug = targetBoard.slug || slugify(boardName) || `trello-${id().slice(0, 8)}`;
  const labelsById = buildTrelloLabelMap(trello, time);
  const checklistsByCard = groupTrelloChecklists(trello);
  const commentsByCard = groupTrelloComments(trello);
  const sortedLists = [...(trello.lists || [])].sort(compareTrelloPosition);
  const states = buildTrelloStates(sortedLists, time);
  const fallbackStateId = states[0]?.id;
  const stateIdsByTrelloListId = new Map(sortedLists.map((list, index) => [list.id, states[index]?.id || fallbackStateId]));
  const sortedCards = [...(trello.cards || [])].sort(compareTrelloPosition);
  const tickets = [];
  const comments = [];

  sortedCards.forEach((card, index) => {
    const ticketId = trelloScopedId("card", card.id || `${index + 1}`);
    const stateId = stateIdsByTrelloListId.get(card.idList) || fallbackStateId;
    if (!stateId) return;
    const cardUpdatedAt = cleanText(card.dateLastActivity) || time;
    const cardCreatedAt = dateFromTrelloObjectId(card.id) || cardUpdatedAt;
    const cardComments = commentsByCard.get(card.id) || [];
    const ticketLabels = trelloLabelsForCard(card, labelsById);
    const importedDescription = renderTrelloCardDescription(card, {
      listName: listNameForCard(trello.lists, card.idList),
      checklists: checklistsByCard.get(card.id) || []
    });
    tickets.push({
      id: ticketId,
      number: index + 1,
      title: cleanText(card.name) || `Untitled Trello card ${index + 1}`,
      description: importedDescription,
      type: "task",
      parent_ticket_id: null,
      ai_plan: "",
      implementation_summary: "",
      implementation_updates: "",
      state_id: stateId,
      priority: priorityFromTrelloCard(card),
      created_by: "trello-import",
      created_at: cardCreatedAt,
      updated_at: cardUpdatedAt,
      archived_at: card.closed ? cardUpdatedAt : null,
      labels: ticketLabels
    });

    cardComments.forEach((action, commentIndex) => {
      const commentId = trelloScopedId("comment", action.id || `${card.id}-${commentIndex + 1}`);
      comments.push({
        id: commentId,
        ticket_id: ticketId,
        author: trelloMemberName(action.memberCreator),
        kind: "human_comment",
        body: cleanText(action.data?.text) || "",
        created_at: cleanText(action.date) || cardUpdatedAt
      });
    });
  });

  return {
    format: "orbit-board-export",
    source_format: "trello-board-export",
    version: 7,
    exported_at: time,
    include_attachments: false,
    imported_counts: {
      states: states.length,
      tickets: tickets.length,
      comments: comments.length,
      labels: labelsById.size
    },
    board: {
      id: targetBoard.id || trelloScopedId("board", trello.id || id()),
      slug: boardSlug,
      name: boardName,
      repo_url: targetBoard.repo_url || "",
      system_path: targetBoard.system_path || targetBoard.repo_path || "",
      default_branch: targetBoard.default_branch || "main",
      project_notes: cleanText(trello.desc) ? `Imported from Trello.\n\n${cleanText(trello.desc)}` : "Imported from Trello.",
      agent_instructions: "",
      ai_enabled: 1,
      created_at: cleanText(trello.dateLastActivity) || time,
      updated_at: time
    },
    states,
    labels: [...labelsById.values()],
    tickets,
    comments: comments.filter((comment) => comment.body),
    review_verdicts: [],
    relations: [],
    attachments: [],
    board_entries: [],
    events: []
  };
}

function buildTrelloStates(lists = [], time) {
  const sorted = [...lists].sort(compareTrelloPosition);
  const rolesSeen = new Set();
  const firstOpenIndex = sorted.findIndex((list) => !list.closed);
  const defaultIndex = firstOpenIndex >= 0 ? firstOpenIndex : 0;
  return sorted.map((list, index) => {
    const role = uniqueTrelloStateRole(inferTrelloStateRole(list.name), rolesSeen);
    return {
      id: trelloScopedId("list", list.id || `${index + 1}`),
      name: cleanText(list.name) || `Trello List ${index + 1}`,
      position: index,
      is_default: index === defaultIndex ? 1 : 0,
      role,
      created_at: dateFromTrelloObjectId(list.id) || time
    };
  });
}

function buildTrelloLabelMap(trello, time) {
  const labels = new Map();
  const addLabel = (raw) => {
    if (!raw) return;
    const key = raw.id || `${raw.color || "label"}-${raw.name || ""}`;
    const name = trelloLabelName(raw, trello.labelNames);
    if (!name || labels.has(key)) return;
    labels.set(key, {
      id: trelloScopedId("label", key),
      name,
      color: TRELLO_LABEL_COLORS[String(raw.color || "").toLowerCase()] || "#64748b",
      created_at: dateFromTrelloObjectId(raw.id) || time
    });
  };
  for (const label of trello.labels || []) addLabel(label);
  for (const card of trello.cards || []) for (const label of card.labels || []) addLabel(label);
  return labels;
}

function groupTrelloChecklists(trello) {
  const grouped = new Map();
  const add = (cardId, checklist) => {
    if (!cardId || !checklist) return;
    if (!grouped.has(cardId)) grouped.set(cardId, []);
    grouped.get(cardId).push(checklist);
  };
  for (const checklist of trello.checklists || []) add(checklist.idCard, checklist);
  for (const card of trello.cards || []) for (const checklist of card.checklists || []) add(card.id, checklist);
  return grouped;
}

function groupTrelloComments(trello) {
  const grouped = new Map();
  for (const action of trello.actions || []) {
    if (action.type !== "commentCard") continue;
    const cardId = action.data?.card?.id;
    if (!cardId) continue;
    if (!grouped.has(cardId)) grouped.set(cardId, []);
    grouped.get(cardId).push(action);
  }
  for (const actions of grouped.values()) actions.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  return grouped;
}

function trelloLabelsForCard(card, labelsById) {
  const result = [];
  const seen = new Set();
  const addByRawId = (rawId) => {
    const label = labelsById.get(rawId);
    if (label && !seen.has(label.id)) {
      seen.add(label.id);
      result.push(label);
    }
  };
  for (const label of card.labels || []) addByRawId(label.id || `${label.color || "label"}-${label.name || ""}`);
  for (const labelId of card.idLabels || []) addByRawId(labelId);
  return result;
}

function renderTrelloCardDescription(card, { listName, checklists }) {
  const parts = [];
  const desc = cleanText(card.desc);
  if (desc) parts.push(desc);
  const meta = [];
  if (card.idShort) meta.push(`Trello card #${card.idShort}`);
  if (listName) meta.push(`List: ${listName}`);
  if (card.shortUrl || card.url) meta.push(`URL: ${card.shortUrl || card.url}`);
  if (card.due) meta.push(`Due: ${card.due}${card.dueComplete ? " (complete)" : ""}`);
  if (card.closed) meta.push("Archived in Trello: yes");
  if (meta.length) parts.push(["Imported from Trello:", ...meta.map((line) => `- ${line}`)].join("\n"));

  const checklistText = renderTrelloChecklists(checklists);
  if (checklistText) parts.push(checklistText);
  const attachmentText = renderTrelloAttachments(card.attachments || []);
  if (attachmentText) parts.push(attachmentText);
  return parts.join("\n\n");
}

function renderTrelloChecklists(checklists = []) {
  const rendered = checklists
    .map((checklist) => {
      const items = [...(checklist.checkItems || [])].sort(compareTrelloPosition);
      if (!items.length) return "";
      return [`Checklist: ${cleanText(checklist.name) || "Untitled"}`, ...items.map((item) => `- [${item.state === "complete" ? "x" : " "}] ${cleanText(item.name) || "Untitled item"}`)].join("\n");
    })
    .filter(Boolean);
  return rendered.join("\n\n");
}

function renderTrelloAttachments(attachments = []) {
  const rendered = attachments
    .map((attachment) => {
      const name = cleanText(attachment.name) || cleanText(attachment.fileName) || "Attachment";
      const url = cleanText(attachment.url);
      return url ? `- ${name}: ${url}` : `- ${name}`;
    })
    .filter(Boolean);
  return rendered.length ? ["Trello attachments:", ...rendered].join("\n") : "";
}

function trelloLabelName(label, labelNames = {}) {
  const explicit = cleanText(label.name);
  if (explicit) return explicit;
  const color = cleanText(label.color);
  const namedColor = color ? cleanText(labelNames[color]) : "";
  if (namedColor) return namedColor;
  return color ? `Trello ${color}` : "";
}

function listNameForCard(lists = [], idList) {
  return cleanText(lists.find((list) => list.id === idList)?.name);
}

function priorityFromTrelloCard(card) {
  const names = (card.labels || []).map((label) => cleanText(label.name || label.color).toLowerCase()).join(" ");
  if (/urgent|critical|blocker|high|red/.test(names)) return 4;
  if (/low|someday|backlog/.test(names)) return 1;
  return 2;
}

function inferTrelloStateRole(name) {
  const normalized = cleanText(name).toLowerCase();
  if (!normalized) return null;
  if (/^ai ready$|ai[- ]ready/.test(normalized)) return "ai_ready";
  if (/review|qa|verify|validation/.test(normalized)) return "review";
  if (/doing|in progress|active|working|wip/.test(normalized)) return "in_progress";
  if (/done|complete|completed|shipped|closed/.test(normalized)) return "done";
  return null;
}

function uniqueTrelloStateRole(role, rolesSeen) {
  if (!role || rolesSeen.has(role)) return null;
  rolesSeen.add(role);
  return role;
}

function trelloMemberName(member) {
  return cleanText(member?.fullName) || cleanText(member?.username) || "Trello";
}

function compareTrelloPosition(a, b) {
  const pa = Number(a?.pos ?? Number.MAX_SAFE_INTEGER);
  const pb = Number(b?.pos ?? Number.MAX_SAFE_INTEGER);
  if (pa !== pb) return pa - pb;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function dateFromTrelloObjectId(value) {
  const idValue = String(value || "");
  if (!/^[0-9a-fA-F]{8}/.test(idValue)) return null;
  const seconds = Number.parseInt(idValue.slice(0, 8), 16);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

function cleanText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function trelloScopedId(prefix, value) {
  return `trello-${prefix}-${String(value || id()).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}
