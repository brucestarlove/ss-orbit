// Server-sent events client. Subscribes to /api/events/stream and turns
// server events into a debounced bootstrap reload + toast notifications.
// Owns its own reconnect backoff for the rare case where the browser's
// auto-reconnect gives up (e.g., HTTP error → CLOSED state).

import { state, syncBoardSelection } from "./state.js";
import { api, bootstrapPath } from "./api.js";
import { toast, debounce } from "./toast.js";
import { render } from "./app.js";
import { markRead, bumpUnread, clearUnread } from "./unread.js";

// Event types that meaningfully change a card's state from the human's POV
// — these are the ones that should bump the per-card unread count.
const CARD_TOUCHING_EVENTS = new Set([
  "ticket_created",
  "state_changed",
  "ticket_updated",
  "comment_created",
  "agent_claimed",
  "checkpoint_requested",
  "agent_completed"
]);

// Manual reconnect backoff for the rare case the browser's auto-reconnect
// gives up (e.g., the server returned an HTTP error and EventSource entered
// the CLOSED state). Reset on every successful open.
let sseReconnectDelayMs = 1000;
let sseReconnectTimer = null;
let sseDisconnectToastShown = false;

export function connectEventStream() {
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  const params = new URLSearchParams();
  if (state.boardId) params.set("board_id", state.boardId);
  const url = `/api/events/stream${params.toString() ? `?${params}` : ""}`;

  const es = new EventSource(url);
  state.eventSource = es;

  es.addEventListener("open", () => {
    sseReconnectDelayMs = 1000;
    if (sseDisconnectToastShown) {
      toast.success("Live updates reconnected");
      sseDisconnectToastShown = false;
    }
  });

  es.addEventListener("board", async (msg) => {
    let event;
    try {
      event = JSON.parse(msg.data);
    } catch {
      return;
    }

    const eventType = event.type;
    const findTicket = () => state.data?.tickets?.find((t) => t.id === event.ticket_id);

    // Per-card unread counter:
    //   - my own events → mark read (no badge for my own changes)
    //   - foreign card-touching events → bump count by 1
    //   - delete → clear the entry entirely
    const me = state.data?.actor?.name;
    const isMine = event.actor && me && event.actor === me;
    if (event.ticket_id) {
      if (isMine) {
        markRead(event.ticket_id, event.timestamp);
      } else if (eventType === "ticket_deleted") {
        clearUnread(event.ticket_id);
      } else if (CARD_TOUCHING_EVENTS.has(eventType)) {
        bumpUnread(event.ticket_id);
      }
    }

    if (eventType === "ticket_created") {
      toast.success(`Card created: ${event.data.title || "New card"}`);
      scheduleSSEReload();
    } else if (eventType === "state_changed") {
      const ticket = findTicket();
      const label = ticket ? `#${ticket.number} ${ticket.title}` : "Card";
      toast.info(`${label} → ${event.data.to}`);
      scheduleSSEReload();
    } else if (eventType === "ticket_updated") {
      const ticket = findTicket();
      const label = ticket ? `#${ticket.number}` : "Card";
      const fields = event.data.fields ? Object.keys(event.data.fields).join(", ") : "";
      toast.info(`${label} updated${fields ? `: ${fields}` : ""}`);
      scheduleSSEReload();
    } else if (eventType === "comment_created") {
      const ticket = findTicket();
      const label = ticket ? `#${ticket.number}` : "ticket";
      toast.info(`New comment on ${label}`);
      scheduleSSEReload();
    } else if (eventType === "agent_claimed") {
      const ticket = findTicket();
      toast.info(`Agent claimed ${ticket ? `#${ticket.number} ${ticket.title}` : "a ticket"}`);
      scheduleSSEReload();
    } else if (eventType === "checkpoint_requested") {
      const ticket = findTicket();
      toast.warning(`Checkpoint on ${ticket ? `#${ticket.number}` : "ticket"} — needs human input`);
      scheduleSSEReload();
    } else if (eventType === "agent_completed") {
      const ticket = findTicket();
      toast.success(`Agent completed ${ticket ? `#${ticket.number} ${ticket.title}` : "a ticket"}`);
      scheduleSSEReload();
    } else if (
      eventType === "ticket_deleted" ||
      eventType === "states_reordered" ||
      eventType === "state_created" ||
      eventType === "state_deleted" ||
      eventType === "board_updated" ||
      eventType === "board_imported"
    ) {
      scheduleSSEReload();
    }
  });

  es.onerror = () => {
    // EventSource has three readyStates:
    //   0 (CONNECTING) — browser will auto-reconnect, no action needed.
    //   1 (OPEN)       — transient blip, browser handles it.
    //   2 (CLOSED)     — browser gave up (e.g., HTTP error). Surface and retry.
    if (es.readyState !== EventSource.CLOSED) return;

    if (!sseDisconnectToastShown) {
      toast.warning("Live updates disconnected — retrying…");
      sseDisconnectToastShown = true;
    }

    if (sseReconnectTimer) return;
    const delay = sseReconnectDelayMs;
    sseReconnectDelayMs = Math.min(sseReconnectDelayMs * 2, 30000);
    sseReconnectTimer = setTimeout(() => {
      sseReconnectTimer = null;
      connectEventStream();
    }, delay);
  };
}

export const scheduleSSEReload = debounce(async () => {
  const selectedId = state.selectedTicketId;
  const mode = state.detailMode;
  state.data = await api(bootstrapPath());
  syncBoardSelection();
  state.selectedTicketId = selectedId;
  state.detailMode = mode;
  await render();
}, 300);
