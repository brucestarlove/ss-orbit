import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { localOwnerActor } from "../src/core/auth.js";
import { createBoardSchema, openConnection } from "../src/core/db.js";
import { getTicketMarkdownArtifact, storeTicketMarkdownArtifact } from "../src/core/artifacts.js";
import { createTicket } from "../src/core/tickets.js";
import { id, now } from "../src/core/util.js";

function makeBoard() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-artifact-test-"));
  const dbPath = join(dir, "board.db");
  const db = openConnection(dbPath);
  createBoardSchema(db);
  const boardId = id();
  const t = now();
  const slug = `b-${boardId.slice(0, 8)}`;
  db.prepare("INSERT INTO boards (id,slug,name,system_path,default_branch,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(
    boardId,
    slug,
    "Board",
    dir,
    "main",
    t,
    t
  );
  const todo = id();
  db.prepare(
    "INSERT INTO states (id,board_id,name,position,is_default,role,created_at) VALUES (?,?,?,?,1,?,?)"
  ).run(todo, boardId, "Todo", 0, null, t);
  const ctx = { actor: localOwnerActor(), board: { id: boardId, slug, name: "Board", repo_path: dir, db_path: dbPath, system_path: dir, default_branch: "main" }, db };
  return { ctx, dir, dbPath };
}

test("uploaded markdown artifacts are stored under the board and reopened by relative path", async () => {
  const { ctx, dbPath } = makeBoard();
  const ticket = createTicket({ title: "Hosted handoff" }, ctx);

  const stored = storeTicketMarkdownArtifact(ticket.id, {
    filename: "handoff.md",
    content: "# Handoff\n\nHosted copy."
  }, ctx);

  assert.equal(stored.ticket_id, ticket.id);
  assert.equal(stored.path, `tickets/${ticket.id}/handoff.md`);
  assert.match(stored.absolute_path, /artifacts/);
  assert.equal(existsSync(stored.absolute_path), true);

  const opened = getTicketMarkdownArtifact(ticket.id, stored.path, ctx);
  assert.equal(opened.content, "# Handoff\n\nHosted copy.");
  assert.equal(opened.path, stored.path);

  const onDisk = await readFile(join(dbPath, "..", "artifacts", stored.path), "utf8");
  assert.equal(onDisk, opened.content);
});

test("artifact path handling includes Windows and WSL spelling aliases", () => {
  const artifactSource = readFileSync(resolve(import.meta.dirname, "..", "src", "core", "artifacts.js"), "utf8");

  // The alias implementation itself is private; guard the cross-OS spellings at
  // source level so /mnt/c, /c, and C:/ paths keep being considered together.
  assert.equal(artifactSource.includes("/mnt/${drive}"), true);
  assert.equal(artifactSource.includes("${drive.toUpperCase()}:"), true);
  assert.equal(artifactSource.includes("/^\\/([a-z])\\/"), true);
});
