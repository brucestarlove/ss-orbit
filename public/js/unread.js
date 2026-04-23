// Per-card "unread updates" tracker. Lives client-side in localStorage so
// no backend changes are needed. Each entry tracks both:
//   readAt — ISO timestamp the human last acknowledged this card
//   count  — number of foreign-actor events received since that ack
// Render uses a dot for count===1 and a numeric pill for count>=2.
//
// Acknowledgement happens on three paths:
//   - opening the card (renderDetail in ticket-detail.js)
//   - own action via SSE self-event suppression (sse.js)
//   - the one-time per-board seed below, so the very first load doesn't
//     flash badges on every existing card

import { state } from "./state.js";

const READ_KEY = (boardId) => `mab_card_read:${boardId}`;
const SEEDED_KEY = (boardId) => `mab_card_read_seeded:${boardId}`;

const cache = new Map();

// Normalize a stored value into { readAt, count }. Tolerates the old
// string-only shape so existing localStorage entries upgrade in place.
function normalize(raw) {
  if (!raw) return { readAt: null, count: 0 };
  if (typeof raw === "string") return { readAt: raw, count: 0 };
  return { readAt: raw.readAt || null, count: Number(raw.count) || 0 };
}

function getMap(boardId) {
  if (!boardId) return new Map();
  let m = cache.get(boardId);
  if (m) return m;
  m = new Map();
  try {
    const raw = localStorage.getItem(READ_KEY(boardId));
    if (raw) {
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj)) m.set(k, normalize(v));
    }
  } catch { /* ignore */ }
  cache.set(boardId, m);
  return m;
}

function persist(boardId) {
  const m = cache.get(boardId);
  if (!m) return;
  try {
    const obj = {};
    for (const [k, v] of m) obj[k] = v;
    localStorage.setItem(READ_KEY(boardId), JSON.stringify(obj));
  } catch { /* ignore */ }
}

function entryFor(m, ticketId) {
  let e = m.get(ticketId);
  if (!e) {
    e = { readAt: null, count: 0 };
    m.set(ticketId, e);
  }
  return e;
}

export function unreadCount(ticket) {
  const boardId = ticket?.board_id || state.boardId;
  if (!boardId || !ticket?.id) return 0;
  const m = getMap(boardId);
  const e = m.get(ticket.id);
  if (!e) {
    // Absence: if seeded, the card appeared post-seed → flag with count 1.
    // If never seeded, treat as read so first-ever load is quiet.
    return localStorage.getItem(SEEDED_KEY(boardId)) === "1" ? 1 : 0;
  }
  return e.count;
}

export function isUnread(ticket) {
  return unreadCount(ticket) > 0;
}

export function markRead(ticketId, timestamp) {
  const boardId = state.boardId;
  if (!boardId || !ticketId) return;
  const m = getMap(boardId);
  const e = entryFor(m, ticketId);
  if (e.count === 0 && e.readAt && timestamp && e.readAt >= timestamp) return;
  e.count = 0;
  if (timestamp) e.readAt = timestamp;
  persist(boardId);
}

export function bumpUnread(ticketId) {
  const boardId = state.boardId;
  if (!boardId || !ticketId) return;
  const m = getMap(boardId);
  const e = entryFor(m, ticketId);
  e.count = (e.count || 0) + 1;
  persist(boardId);
}

export function clearUnread(ticketId) {
  const boardId = state.boardId;
  if (!boardId || !ticketId) return;
  const m = getMap(boardId);
  if (!m.has(ticketId)) return;
  m.delete(ticketId);
  persist(boardId);
}

// One-time per-board seed so existing cards start "read" the first time the
// user runs this version. Runs again per-board the first time each board is
// visited.
export function seedReadIfNeeded(boardId, tickets) {
  if (!boardId) return;
  if (localStorage.getItem(SEEDED_KEY(boardId)) === "1") return;
  const m = getMap(boardId);
  for (const t of tickets || []) {
    if (!m.has(t.id) && t.updated_at) m.set(t.id, { readAt: t.updated_at, count: 0 });
  }
  persist(boardId);
  try { localStorage.setItem(SEEDED_KEY(boardId), "1"); } catch { /* ignore */ }
}
