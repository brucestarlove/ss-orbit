import { test } from "node:test";
import assert from "node:assert/strict";

class MemoryStorage {
  #items = new Map();
  getItem(key) { return this.#items.has(key) ? this.#items.get(key) : null; }
  setItem(key, value) { this.#items.set(key, String(value)); }
  removeItem(key) { this.#items.delete(key); }
}

globalThis.localStorage = new MemoryStorage();

const { state, syncBoardSelection } = await import("../public/js/state.js");

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
