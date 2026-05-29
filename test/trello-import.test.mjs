import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { openConnection, createBoardSchema, createRegistrySchema } from "../src/core/db.js";
import { localOwnerActor } from "../src/core/auth.js";
import { importBoardSnapshot, importBoardSnapshotAsNewBoard } from "../src/core/snapshots.js";
import { deleteBoard, getBoardByRegistryId, openBoardDb } from "../src/core/registry.js";
import { id, now } from "../src/core/util.js";

const repoRoot = dirname(fileURLToPath(import.meta.url)).replace(/\/test$/, "");

function makeBoard() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-trello-import-test-"));
  const dbPath = join(dir, "board.db");
  const db = openConnection(dbPath);
  createBoardSchema(db);
  const boardId = id();
  const t = now();
  const slug = `target-${boardId.slice(0, 8)}`;
  db.prepare("INSERT INTO boards (id,slug,name,system_path,default_branch,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(
    boardId,
    slug,
    "Target Board",
    dir,
    "main",
    t,
    t
  );
  const stateId = id();
  db.prepare(
    "INSERT INTO states (id,board_id,name,position,is_default,role,created_at) VALUES (?,?,?,?,1,?,?)"
  ).run(stateId, boardId, "Existing", 0, null, t);
  const ctx = {
    actor: localOwnerActor(),
    board: { id: boardId, slug, name: "Target Board", repo_path: dir, db_path: dbPath, system_path: dir, default_branch: "main" },
    db
  };
  return { db, ctx, boardId, slug };
}

const trelloExport = {
  id: "64b000000000000000000001",
  name: "Starscape Digital Projects",
  desc: "Original Trello board notes",
  labelNames: { red: "High", green: "Growth" },
  lists: [
    { id: "64b000010000000000000001", name: "Backlog", pos: 1, closed: false },
    { id: "64b000020000000000000002", name: "In Progress", pos: 2, closed: false },
    { id: "64b000030000000000000003", name: "Done", pos: 3, closed: false }
  ],
  labels: [
    { id: "64b000040000000000000004", name: "", color: "red" },
    { id: "64b000050000000000000005", name: "Launch", color: "green" }
  ],
  checklists: [
    {
      id: "64b000060000000000000006",
      idCard: "64b000070000000000000007",
      name: "Acceptance",
      checkItems: [
        { id: "64b000080000000000000008", name: "Map cards", state: "complete", pos: 1 },
        { id: "64b000090000000000000009", name: "Preserve comments", state: "incomplete", pos: 2 }
      ]
    }
  ],
  cards: [
    {
      id: "64b000070000000000000007",
      idShort: 42,
      name: "Import Trello board",
      desc: "Bring the old project board home.",
      idList: "64b000010000000000000001",
      pos: 1,
      closed: false,
      dateLastActivity: "2026-05-01T12:00:00.000Z",
      shortUrl: "https://trello.com/c/import",
      labels: [{ id: "64b000040000000000000004", name: "", color: "red" }],
      idLabels: ["64b000040000000000000004"],
      attachments: [{ name: "Spec", url: "https://example.test/spec" }]
    },
    {
      id: "64b0000a000000000000000a",
      idShort: 43,
      name: "Already shipped card",
      desc: "This was archived in Trello.",
      idList: "64b000030000000000000003",
      pos: 2,
      closed: true,
      dateLastActivity: "2026-05-02T12:00:00.000Z",
      labels: [{ id: "64b000050000000000000005", name: "Launch", color: "green" }],
      idLabels: ["64b000050000000000000005"]
    }
  ],
  actions: [
    {
      id: "64b0000b000000000000000b",
      type: "commentCard",
      date: "2026-05-01T13:00:00.000Z",
      data: { text: "This comment came from Trello.", card: { id: "64b000070000000000000007" } },
      memberCreator: { fullName: "Bruce Starlove", username: "bruce" }
    }
  ]
};

test("Trello board JSON imports as an Orbit board snapshot", () => {
  createRegistrySchema();
  const { db, ctx, boardId, slug } = makeBoard();
  try {
    const result = importBoardSnapshot({ snapshot: trelloExport, replace_existing: true }, ctx);

    assert.equal(result.ok, true);
    assert.equal(result.source_format, "trello-board-export");
    assert.deepEqual(result.imported_counts, { states: 3, tickets: 2, comments: 1, labels: 2 });

    const board = db.prepare("SELECT * FROM boards WHERE id = ?").get(boardId);
    assert.equal(board.name, "Starscape Digital Projects");
    assert.equal(board.slug, slug, "Trello import preserves the target Orbit board slug");
    assert.match(board.project_notes, /Original Trello board notes/);

    const states = db.prepare("SELECT name, role, is_default FROM states WHERE board_id = ? ORDER BY position").all(boardId).map((row) => ({ ...row }));
    assert.deepEqual(states, [
      { name: "Backlog", role: null, is_default: 1 },
      { name: "In Progress", role: "in_progress", is_default: 0 },
      { name: "Done", role: "done", is_default: 0 }
    ]);

    const activeCard = db.prepare("SELECT * FROM tickets WHERE title = ?").get("Import Trello board");
    assert.ok(activeCard);
    assert.equal(activeCard.created_by, "trello-import");
    assert.equal(activeCard.archived_at, null);
    assert.match(activeCard.description, /Bring the old project board home/);
    assert.match(activeCard.description, /Trello card #42/);
    assert.match(activeCard.description, /- \[x\] Map cards/);
    assert.match(activeCard.description, /Spec: https:\/\/example\.test\/spec/);

    const archivedCard = db.prepare("SELECT * FROM tickets WHERE title = ?").get("Already shipped card");
    assert.equal(archivedCard.archived_at, "2026-05-02T12:00:00.000Z");

    const labels = db
      .prepare(
        `SELECT l.name, l.color
         FROM labels l
         JOIN ticket_labels tl ON tl.label_id = l.id
         WHERE tl.ticket_id = ?
         ORDER BY l.name`
      )
      .all(activeCard.id)
      .map((row) => ({ ...row }));
    assert.deepEqual(labels, [{ name: "High", color: "#eb5a46" }]);

    const comment = { ...db.prepare("SELECT author, kind, body FROM comments WHERE ticket_id = ?").get(activeCard.id) };
    assert.deepEqual(comment, {
      author: "Bruce Starlove",
      kind: "human_comment",
      body: "This comment came from Trello."
    });

    const fts = db.prepare("SELECT 1 FROM ticket_fts WHERE ticket_id = ? AND comments LIKE '%Trello.%'").get(activeCard.id);
    assert.ok(fts, "import reindexes comments into FTS");
  } finally {
    deleteBoard(boardId);
  }
});

test("invalid non-JSON-shaped import is still rejected", () => {
  const { ctx, boardId } = makeBoard();
  try {
    assert.throws(
      () => importBoardSnapshot({ snapshot: { name: "Not enough Trello shape", cards: [] }, replace_existing: true }, ctx),
      (error) => error.code === "invalid_import_snapshot"
    );
  } finally {
    deleteBoard(boardId);
  }
});

test("Trello import can create a new board without mutating the current board", () => {
  createRegistrySchema();
  const { db, ctx, boardId, slug } = makeBoard();
  let newBoardId = "";
  try {
    const result = importBoardSnapshotAsNewBoard({ snapshot: trelloExport }, ctx);
    newBoardId = result.imported_board_id;

    assert.equal(result.ok, true);
    assert.equal(result.created_new_board, true);
    assert.equal(result.source_format, "trello-board-export");
    assert.notEqual(result.imported_board_id, boardId);
    assert.notEqual(result.imported_board_slug, slug);

    const originalBoard = { ...db.prepare("SELECT name, slug FROM boards WHERE id = ?").get(boardId) };
    assert.deepEqual(originalBoard, { name: "Target Board", slug });
    const originalStates = db.prepare("SELECT name FROM states WHERE board_id = ? ORDER BY position").all(boardId);
    assert.deepEqual(originalStates.map((row) => row.name), ["Existing"]);

    const registryRow = getBoardByRegistryId(newBoardId);
    assert.ok(registryRow, "new board is registered separately");
    assert.equal(registryRow.slug, result.imported_board_slug);
    assert.equal(registryRow.repo_path, ctx.board.system_path);

    const importedDb = openBoardDb(registryRow);
    const importedBoard = { ...importedDb.prepare("SELECT id, slug, name FROM boards").get() };
    assert.deepEqual(importedBoard, {
      id: newBoardId,
      slug: result.imported_board_slug,
      name: "Starscape Digital Projects"
    });
    const importedTitles = importedDb.prepare("SELECT title FROM tickets ORDER BY number").all().map((row) => row.title);
    assert.deepEqual(importedTitles, ["Import Trello board", "Already shipped card"]);
  } finally {
    if (newBoardId) deleteBoard(newBoardId);
    deleteBoard(boardId);
  }
});

test("settings UI defaults imports to a new board and gates replace-current as advanced", () => {
  const settingsSource = readFileSync(join(repoRoot, "public", "js", "settings.js"), "utf8");
  const routerSource = readFileSync(join(repoRoot, "src", "core", "router.js"), "utf8");

  assert.match(settingsSource, /function parseImportSnapshotText/);
  assert.match(settingsSource, /looks like an HTML page instead of JSON/);
  assert.match(settingsSource, /const input = event\.currentTarget;/);
  assert.doesNotMatch(settingsSource, /event\.currentTarget\.value = ""/);
  assert.match(settingsSource, /id="importSnapshotAsNewFile"/);
  assert.match(settingsSource, /Import as New Board/);
  assert.match(settingsSource, /create_new:\s*true/);
  assert.match(settingsSource, /state\.boardId = result\.imported_board_id;[\s\S]*await load\(\);/);
  assert.doesNotMatch(settingsSource, /await load\(\);[\s\S]{0,160}state\.boardId = result\.imported_board_id;/);
  assert.doesNotMatch(settingsSource, /id="importSnapshotFile"[\s\S]*replace_existing:\s*true/);

  assert.match(settingsSource, /id="replaceCurrentBoardImportFile"/);
  assert.match(settingsSource, /id="replaceImportConfirmInput"/);
  assert.match(settingsSource, /replaceImportConfirmInput\.value\.trim\(\) !== project\.slug/);
  assert.match(settingsSource, /replace_existing:\s*true/);
  assert.match(routerSource, /body\.create_new[\s\S]*importBoardSnapshotAsNewBoard/);
});
