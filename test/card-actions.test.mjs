import { test } from "node:test";
import assert from "node:assert/strict";

class MemoryStorage {
  #items = new Map();
  getItem(key) { return this.#items.has(key) ? this.#items.get(key) : null; }
  setItem(key, value) { this.#items.set(key, String(value)); }
  removeItem(key) { this.#items.delete(key); }
}

globalThis.localStorage = new MemoryStorage();

const {
  buildCardActionMenu,
  calculateMenuPosition,
  calculateSubmenuPosition,
  createCardActionHandlers
} = await import("../public/js/card-actions.js");
const { state } = await import("../public/js/state.js");

test("card action menu marks current lane, priority, and type as checked disabled items", () => {
  const menu = buildCardActionMenu(
    { id: "ticket-1", state_id: "doing", priority: 3, type: "bug" },
    [
      { id: "todo", name: "Todo" },
      { id: "doing", name: "Doing" }
    ]
  );

  const moveItems = menu.find((item) => item.id === "move").children;
  assert.deepEqual(moveItems.map((item) => [item.label, item.checked, item.disabled]), [
    ["Todo", false, false],
    ["Doing", true, true]
  ]);

  const priorityItems = menu.find((item) => item.id === "priority").children;
  assert.equal(priorityItems.find((item) => item.value === 3).checked, true);
  assert.equal(priorityItems.find((item) => item.value === 3).disabled, true);

  const typeItems = menu.find((item) => item.id === "type").children;
  assert.equal(typeItems.find((item) => item.value === "bug").checked, true);
  assert.equal(typeItems.find((item) => item.value === "bug").disabled, true);
});

test("context menu position flips and clamps to the viewport", () => {
  assert.deepEqual(
    calculateMenuPosition({ x: 780, y: 580, menuWidth: 180, menuHeight: 220, viewportWidth: 800, viewportHeight: 600 }),
    { left: 600, top: 360 }
  );

  assert.deepEqual(
    calculateMenuPosition({ x: -40, y: -10, menuWidth: 180, menuHeight: 220, viewportWidth: 800, viewportHeight: 600 }),
    { left: 8, top: 8 }
  );
});

test("context submenu position flips horizontally and clamps vertically", () => {
  assert.deepEqual(
    calculateSubmenuPosition({
      triggerRect: { left: 620, right: 780, top: 570 },
      submenuWidth: 180,
      submenuHeight: 260,
      viewportWidth: 800,
      viewportHeight: 600
    }),
    { left: 434, top: 332, maxHeight: 584 }
  );

  assert.deepEqual(
    calculateSubmenuPosition({
      triggerRect: { left: 20, right: 160, top: -20 },
      submenuWidth: 180,
      submenuHeight: 260,
      viewportWidth: 800,
      viewportHeight: 600
    }),
    { left: 166, top: 8, maxHeight: 584 }
  );
});

test("card action handlers use ticket mutation endpoints with board query", async () => {
  state.boardId = "board-a";
  const calls = [];
  const apiClient = async (path, options = {}) => {
    calls.push({ path, method: options.method, body: options.body });
    return { ok: true };
  };
  const navigations = [];
  const handlers = createCardActionHandlers({
    apiClient,
    navigator: (route) => navigations.push(route),
    confirmer: () => false
  });
  const ticket = { id: "ticket 1", title: "Ticket", priority: 2, type: "task" };

  await handlers.move(ticket, "review");
  await handlers.priority(ticket, 4);
  await handlers.type(ticket, "feature");
  await handlers.open(ticket);
  const archived = await handlers.archive(ticket);

  assert.equal(archived, false);
  assert.deepEqual(calls, [
    { path: "/api/tickets/ticket%201?board_id=board-a", method: "PATCH", body: { state_id: "review" } },
    { path: "/api/tickets/ticket%201?board_id=board-a", method: "PATCH", body: { priority: 4 } },
    { path: "/api/tickets/ticket%201?board_id=board-a", method: "PATCH", body: { type: "feature" } }
  ]);
  assert.deepEqual(navigations, [{ boardId: "board-a", view: "ticket", ticketId: "ticket 1" }]);
});
