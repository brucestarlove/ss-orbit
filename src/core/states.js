import { boardById, compactStatePositions, stateById } from "./queries.js";
import { tx } from "./db.js";
import { requireBoardAccess, requirePermission } from "./auth.js";
import { recordEvent } from "./events.js";
import {
  httpError,
  id,
  normalizeStateRole,
  now,
  requiredString
} from "./util.js";

export function createState(boardId, body, ctx) {
  const { db, actor } = ctx;
  const board = boardById(db, boardId);
  if (!board) throw httpError(404, "board_not_found");
  requireBoardAccess(actor, board);
  requirePermission(actor, "write");

  const role = body.role !== undefined ? normalizeStateRole(body.role) : null;
  // role='ai_ready' implies canonical name; reject mismatches so the AI tab
  // checkbox always lands a lane named exactly "AI Ready".
  const name =
    role === "ai_ready"
      ? body.name && body.name !== "AI Ready"
        ? (() => { throw httpError(409, "ai_ready_lane_must_be_named_ai_ready"); })()
        : "AI Ready"
      : requiredString(body.name, "name");
  const stateId = id();
  return tx(db, () => {
    if (role) {
      db.prepare("UPDATE states SET role = NULL WHERE board_id = ? AND role = ?").run(boardId, role);
    }
    const maxPosition = db.prepare("SELECT MAX(position) AS value FROM states WHERE board_id = ?").get(boardId).value;
    db.prepare(
      `INSERT INTO states
       (id, board_id, name, position, is_default, role, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    ).run(stateId, boardId, name, Number(maxPosition || 0) + 1, role, now());
    recordEvent(db, boardId, "state_created", null, actor.name, {
      board_id: boardId,
      state_id: stateId,
      name,
      role
    });
    return stateById(db, stateId);
  });
}

export function updateState(stateId, body, ctx) {
  const { db, actor } = ctx;
  const before = stateById(db, stateId);
  if (!before) throw httpError(404, "state_not_found");
  const board = boardById(db, before.board_id);
  requireBoardAccess(actor, board);
  requirePermission(actor, "write");

  return tx(db, () => {
  const sets = [];
  const values = [];
  if (body.name !== undefined) {
    const nextName = requiredString(body.name, "name");
    // The AI Ready lane is the canonical anchor for agent claim-next. Locking
    // its name removes a whole class of silent breakage; users who want a
    // different label can disable the AI Ready column from Settings → AI.
    if (before.role === "ai_ready" && nextName !== "AI Ready") {
      throw httpError(409, "cannot_rename_ai_ready_lane");
    }
    sets.push("name = ?");
    values.push(nextName);
  }
  if (body.is_default !== undefined) {
    const nextDefault = body.is_default ? 1 : 0;
    if (nextDefault) db.prepare("UPDATE states SET is_default = 0 WHERE board_id = ?").run(before.board_id);
    sets.push("is_default = ?");
    values.push(nextDefault);
  }
  if (body.role !== undefined) {
    const nextRole = normalizeStateRole(body.role);
    // Roles are unique per board: at most one lane plays each role. If another
    // lane already holds it, clear that one first so the new assignment wins.
    if (nextRole) {
      db.prepare("UPDATE states SET role = NULL WHERE board_id = ? AND role = ? AND id != ?")
        .run(before.board_id, nextRole, stateId);
    }
    // Assigning role='ai_ready' implies the lane name must be "AI Ready" (the
    // canonical name agents key off). If the caller is also renaming via
    // body.name above, that took precedence; otherwise force it here.
    if (nextRole === "ai_ready") {
      const finalName = body.name !== undefined ? requiredString(body.name, "name") : before.name;
      if (finalName !== "AI Ready") {
        if (body.name === undefined) {
          // Caller didn't ask to rename — silently set the canonical name.
          sets.push("name = ?");
          values.push("AI Ready");
        } else {
          throw httpError(409, "ai_ready_lane_must_be_named_ai_ready");
        }
      }
    }
    sets.push("role = ?");
    values.push(nextRole);
  }
  if (sets.length === 0) return before;

  values.push(stateId);
  db.prepare(`UPDATE states SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  recordEvent(db, before.board_id, "state_updated", null, actor.name, {
    board_id: before.board_id,
    state_id: stateId,
    fields: Object.keys(body)
  });
  return stateById(db, stateId);
  });
}

export function reorderStates(boardId, body, ctx) {
  const { db, actor } = ctx;
  const board = boardById(db, boardId);
  if (!board) throw httpError(404, "board_not_found");
  requireBoardAccess(actor, board);
  requirePermission(actor, "write");

  const ids = Array.isArray(body.state_ids) ? body.state_ids : [];
  const existing = db.prepare("SELECT id FROM states WHERE board_id = ?").all(boardId).map((row) => row.id);
  if (ids.length !== existing.length || !existing.every((stateId) => ids.includes(stateId))) {
    throw httpError(400, "invalid_state_order");
  }

  return tx(db, () => {
    ids.forEach((stateId, position) => {
      db.prepare("UPDATE states SET position = ? WHERE id = ? AND board_id = ?").run(position, stateId, boardId);
    });
    recordEvent(db, boardId, "states_reordered", null, actor.name, { board_id: boardId, state_ids: ids });
    return db.prepare("SELECT * FROM states WHERE board_id = ? ORDER BY position").all(boardId);
  });
}

export function deleteState(stateId, ctx) {
  const { db, actor } = ctx;
  const state = stateById(db, stateId);
  if (!state) throw httpError(404, "state_not_found");
  const board = boardById(db, state.board_id);
  requireBoardAccess(actor, board);
  requirePermission(actor, "write");

  const ticketCount = db.prepare("SELECT COUNT(*) AS count FROM tickets WHERE state_id = ?").get(stateId).count;
  if (ticketCount > 0) throw httpError(409, "state_has_tickets");

  const stateCount = db.prepare("SELECT COUNT(*) AS count FROM states WHERE board_id = ?").get(state.board_id).count;
  if (stateCount <= 1) throw httpError(409, "cannot_delete_last_state");

  return tx(db, () => {
    db.prepare("DELETE FROM states WHERE id = ?").run(stateId);
    compactStatePositions(db, state.board_id);
    if (state.is_default) {
      const first = db.prepare("SELECT id FROM states WHERE board_id = ? ORDER BY position LIMIT 1").get(state.board_id);
      if (first) db.prepare("UPDATE states SET is_default = 1 WHERE id = ?").run(first.id);
    }
    recordEvent(db, state.board_id, "state_deleted", null, actor.name, {
      board_id: state.board_id,
      state_id: stateId,
      name: state.name
    });
    return { ok: true, deleted_state_id: stateId };
  });
}
