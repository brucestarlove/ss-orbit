import { test } from "node:test";
import assert from "node:assert/strict";

class MemoryStorage {
  #items = new Map();
  getItem(key) { return this.#items.has(key) ? this.#items.get(key) : null; }
  setItem(key, value) { this.#items.set(key, String(value)); }
  removeItem(key) { this.#items.delete(key); }
}

globalThis.localStorage = new MemoryStorage();

const { state, syncBoardSelection, upsertTicket } = await import("../public/js/state.js");

test("syncBoardSelection uses bootstrap active_board_id when no board is selected", () => {
  state.boardId = "";
  state.data = {
    active_board_id: "board-b",
    boards: [
      { id: "board-a", name: "Alphabetic first" },
      { id: "board-b", name: "Active default" }
    ],
    states: [],
    tickets: []
  };

  syncBoardSelection();

  assert.equal(state.boardId, "board-b");
});

test("syncBoardSelection preserves an already valid route-selected board", () => {
  state.boardId = "board-a";
  state.data = {
    active_board_id: "board-b",
    boards: [
      { id: "board-a", name: "Route selected" },
      { id: "board-b", name: "Active default" }
    ],
    states: [],
    tickets: []
  };

  syncBoardSelection();

  assert.equal(state.boardId, "board-a");
});

test("syncBoardSelection falls back to the first board for older bootstrap payloads", () => {
  state.boardId = "missing";
  state.data = {
    boards: [
      { id: "board-a", name: "Only available" },
      { id: "board-b", name: "Second" }
    ],
    states: [],
    tickets: []
  };

  syncBoardSelection();

  assert.equal(state.boardId, "board-a");
});

test("upsertTicket refreshes one cached ticket and recalculates board hierarchy fields", () => {
  state.boardId = "board-a";
  state.data = {
    boards: [{ id: "board-a", slug: "orbit", name: "Orbit" }],
    states: [],
    tickets: [
      { id: "epic-1", board_id: "board-a", number: 1, title: "Epic", type: "epic", updated_at: "2026-01-01T00:00:00.000Z", labels: [], child_count: 0 },
      { id: "task-1", board_id: "board-a", number: 2, title: "Task", type: "task", parent_ticket_id: null, updated_at: "2026-01-01T00:00:00.000Z", labels: [] }
    ]
  };

  upsertTicket({
    id: "task-1",
    board_id: "board-a",
    board_slug: "orbit",
    number: 2,
    title: "Task renamed",
    type: "task",
    parent_ticket_id: "epic-1",
    updated_at: "2026-01-02T00:00:00.000Z",
    labels: [{ name: "bug", color: "#f00" }]
  });

  const task = state.data.tickets.find((ticket) => ticket.id === "task-1");
  const epic = state.data.tickets.find((ticket) => ticket.id === "epic-1");
  assert.equal(state.data.tickets[0].id, "task-1");
  assert.equal(task.title, "Task renamed");
  assert.equal(task.parent_ticket.title, "Epic");
  assert.equal(task.labels[0].name, "bug");
  assert.equal(epic.child_count, 1);
});
