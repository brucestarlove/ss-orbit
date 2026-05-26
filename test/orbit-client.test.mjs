import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHttpOrbitClient, createLocalOrbitClient, createOrbitClient, orbitMode } from "../src/mcp/orbit-client.js";

test("Orbit client mode selection defaults local and accepts remote", () => {
  assert.equal(orbitMode({}), "local");
  assert.equal(orbitMode({ ORBIT_MODE: "local" }), "local");
  assert.equal(orbitMode({ ORBIT_MODE: "remote" }), "remote");
  assert.throws(() => orbitMode({ ORBIT_MODE: "ghost" }), /Unsupported ORBIT_MODE/);
});

test("remote Orbit client requires ORBIT_API_URL and never creates local board files", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orbit-remote-client-"));
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    await assert.rejects(
      createOrbitClient({ ORBIT_MODE: "remote" }),
      /ORBIT_MODE=remote requires ORBIT_API_URL/
    );
    assert.equal(existsSync(join(cwd, ".orbit")), false);
  } finally {
    process.chdir(originalCwd);
  }
});

test("HTTP Orbit client routes MCP operations to API endpoints with default board", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : null });
    const path = String(url);
    const created = options.method === "POST" && (path.endsWith("/api/tickets") || path.includes("/review-verdicts"));
    return new Response(JSON.stringify({ ok: true }), { status: created ? 201 : 200 });
  };
  const client = createHttpOrbitClient({ ORBIT_API_URL: "http://orbit.example/api-root/", ORBIT_DEFAULT_BOARD: "example-board" }, fetchImpl);

  await client.boardContext({ include_struck: true });
  await client.search({ q: "ticket 53", limit: 5 });
  await client.createTicket({ title: "Remote ticket" });
  await client.readTicket({ ticket_id: "ticket-1" });
  await client.readComments({ ticket_id: "ticket-1" });
  await client.getTicketContext({ ticket_id: "ticket-1", depth: 2, max_chars_per_field: 900 });
  await client.getTicketContextFull({ ticket_id: "ticket-1", depth: 2, max_chars_per_field: 900 });
  await client.getAgentDispatchPacket({ ticket_id: "ticket-1", max_chars_per_field: 1200, comment_limit: 3 });
  await client.createReviewVerdict({ ticket_id: "ticket-1", verdict: "PASS", evidence_commands: ["npm test"] });
  await client.listReviewVerdicts({ ticket_id: "ticket-1", limit: 2 });
  await client.getReviewVerdict({ review_id: "review-1" });

  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, "http://orbit.example/api-root/api/boards/example-board/context?include_struck=true");
  assert.equal(calls[1].url, "http://orbit.example/api-root/api/search?q=ticket+53&limit=5&board=example-board");
  assert.deepEqual(calls[2], {
    url: "http://orbit.example/api-root/api/tickets",
    method: "POST",
    body: { title: "Remote ticket", board: "example-board" }
  });
  assert.deepEqual(calls[3], {
    url: "http://orbit.example/api-root/api/tickets/ticket-1?board=example-board",
    method: "GET",
    body: null
  });
  assert.deepEqual(calls[4], {
    url: "http://orbit.example/api-root/api/tickets/ticket-1/comments?board=example-board",
    method: "GET",
    body: null
  });
  assert.deepEqual(calls[5], {
    url: "http://orbit.example/api-root/api/tickets/ticket-1/context?board=example-board&depth=2&max_chars_per_field=900",
    method: "GET",
    body: null
  });
  assert.deepEqual(calls[6], {
    url: "http://orbit.example/api-root/api/tickets/ticket-1/context/full?board=example-board&depth=2&max_chars_per_field=900",
    method: "GET",
    body: null
  });
  assert.deepEqual(calls[7], {
    url: "http://orbit.example/api-root/api/tickets/ticket-1/dispatch-packet?board=example-board&max_chars_per_field=1200&comment_limit=3",
    method: "GET",
    body: null
  });
  assert.deepEqual(calls[8], {
    url: "http://orbit.example/api-root/api/tickets/ticket-1/review-verdicts?board=example-board",
    method: "POST",
    body: { verdict: "PASS", evidence_commands: ["npm test"] }
  });
  assert.deepEqual(calls[9], {
    url: "http://orbit.example/api-root/api/tickets/ticket-1/review-verdicts?board=example-board&limit=2",
    method: "GET",
    body: null
  });
  assert.deepEqual(calls[10], {
    url: "http://orbit.example/api-root/api/review-verdicts/review-1?board=example-board",
    method: "GET",
    body: null
  });
});

test("HTTP Orbit client resolves number and title lookups through the exact lightweight lookup endpoint", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : null });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = createHttpOrbitClient({ ORBIT_API_URL: "http://orbit.example", ORBIT_DEFAULT_BOARD: "example-board" }, fetchImpl);

  await client.readTicket({ number: 42 });
  await client.readTicket({ title: "Exact Title" });
  await client.readTicket({ board_slug: "other-board", number: 7 });

  assert.deepEqual(calls, [
    {
      url: "http://orbit.example/api/tickets/lookup?board=example-board&number=42",
      method: "GET",
      body: null
    },
    {
      url: "http://orbit.example/api/tickets/lookup?board=example-board&title=Exact+Title",
      method: "GET",
      body: null
    },
    {
      url: "http://orbit.example/api/tickets/lookup?board=other-board&number=7",
      method: "GET",
      body: null
    }
  ]);
});


test("HTTP Orbit client sends explicit board selectors on mutating ticket operations", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : null });
    const status = options.method === "POST" && (String(url).endsWith("/comments?board=board-b") || String(url).includes("/review-verdicts")) ? 201 : 200;
    return new Response(JSON.stringify({ ok: true }), { status });
  };
  const client = createHttpOrbitClient({ ORBIT_API_URL: "http://orbit.example", ORBIT_DEFAULT_BOARD: "board-a" }, fetchImpl);

  await client.updateTicket({ board_slug: "board-b", ticket_id: "ticket-1", title: "Board B" });
  await client.addComment({ board: "board-b", ticket_id: "ticket-1", body: "comment" });
  await client.createReviewVerdict({ board_slug: "board-b", ticket_id: "ticket-1", verdict: "PASS" });
  await client.boardSetActive({ slug: "board-c" });
  await client.checkpoint({ ticket_id: "ticket-1", message: "paused" });
  await client.complete({ board_id: "board-b-id", ticket_id: "ticket-1", summary: "done" });
  await client.archiveTicket({ board_slug: "board-b", ticket_id: "ticket-2" });
  await client.restoreTicket({ board_slug: "board-b", ticket_id: "ticket-2" });
  await client.deleteTicket({ board_slug: "board-b", ticket_id: "ticket-2" });

  assert.deepEqual(calls, [
    {
      url: "http://orbit.example/api/tickets/ticket-1?board=board-b",
      method: "PATCH",
      body: { title: "Board B" }
    },
    {
      url: "http://orbit.example/api/tickets/ticket-1/comments?board=board-b",
      method: "POST",
      body: { body: "comment" }
    },
    {
      url: "http://orbit.example/api/tickets/ticket-1/review-verdicts?board=board-b",
      method: "POST",
      body: { verdict: "PASS" }
    },
    {
      url: "http://orbit.example/api/agent/checkpoint",
      method: "POST",
      body: { ticket_id: "ticket-1", message: "paused", board: "board-c" }
    },
    {
      url: "http://orbit.example/api/agent/complete",
      method: "POST",
      body: { board_id: "board-b-id", ticket_id: "ticket-1", summary: "done", board: "board-b-id" }
    },
    {
      url: "http://orbit.example/api/tickets/ticket-2/archive?board=board-b",
      method: "POST",
      body: null
    },
    {
      url: "http://orbit.example/api/tickets/ticket-2/restore?board=board-b",
      method: "POST",
      body: null
    },
    {
      url: "http://orbit.example/api/tickets/ticket-2?board=board-b",
      method: "DELETE",
      body: null
    }
  ]);
});

test("local Orbit client mutates explicit board while session active board differs", async () => {
  const root = mkdtempSync(join(tmpdir(), "orbit-local-client-explicit-board-"));
  const dataDir = join(root, "data");
  const boardAProject = join(root, "board-a");
  const boardBProject = join(root, "board-b");
  mkdirSync(boardAProject, { recursive: true });
  mkdirSync(boardBProject, { recursive: true });
  writeFileSync(join(boardAProject, "package.json"), JSON.stringify({ name: "board-a" }), "utf8");
  writeFileSync(join(boardBProject, "package.json"), JSON.stringify({ name: "board-b" }), "utf8");

  const previousDataDir = process.env.DATA_DIR;
  const previousProjectRoot = process.env.PROJECT_ROOT;
  process.env.DATA_DIR = dataDir;
  process.env.PROJECT_ROOT = boardAProject;

  let client;
  try {
    client = await createLocalOrbitClient(process.env);
    const { provisionRepoBoard } = await import("../src/core/provision-repo-board.js");
    const { getBoardBySlug } = await import("../src/core/registry.js");
    provisionRepoBoard(boardBProject, { enableAi: true });
    const boardA = getBoardBySlug("board-a");
    const boardB = getBoardBySlug("board-b");
    assert.ok(boardA);
    assert.ok(boardB);

    await client.boardSetActive({ slug: boardA.slug });
    const ticketA = await client.createTicket({ title: "Ticket on A" });
    const ticketB = await client.createTicket({ board_slug: boardB.slug, title: "Ticket on B" });
    const archiveB = await client.createTicket({ board_slug: boardB.slug, title: "Archive on B" });

    await client.updateTicket({ board_slug: boardB.slug, ticket_id: ticketB.id, title: "Updated on B" });
    await client.addComment({ board_slug: boardB.slug, ticket_id: ticketB.id, body: "Comment on B" });
    await client.createReviewVerdict({ board_slug: boardB.slug, ticket_id: ticketB.id, verdict: "PASS", evidence_commands: ["npm test"] });
    await client.complete({ board_slug: boardB.slug, ticket_id: ticketB.id, summary: "Complete on B" });
    await client.archiveTicket({ board_slug: boardB.slug, ticket_id: archiveB.id });
    await client.restoreTicket({ board_slug: boardB.slug, ticket_id: archiveB.id });
    await client.archiveTicket({ board_slug: boardB.slug, ticket_id: archiveB.id });
    await client.deleteTicket({ board_slug: boardB.slug, ticket_id: archiveB.id });

    const dbA = new DatabaseSync(boardA.db_path);
    const dbB = new DatabaseSync(boardB.db_path);
    try {
      assert.equal(dbA.prepare("SELECT title FROM tickets WHERE id = ?").get(ticketA.id).title, "Ticket on A");
      assert.equal(dbA.prepare("SELECT COUNT(*) AS count FROM comments WHERE body IN ('Comment on B', 'Complete on B')").get().count, 0);
      assert.equal(dbA.prepare("SELECT COUNT(*) AS count FROM tickets WHERE title = 'Updated on B'").get().count, 0);

      assert.equal(dbB.prepare("SELECT title FROM tickets WHERE id = ?").get(ticketB.id).title, "Updated on B");
      assert.equal(dbB.prepare("SELECT implementation_summary FROM tickets WHERE id = ?").get(ticketB.id).implementation_summary, "Complete on B");
      assert.equal(dbB.prepare("SELECT COUNT(*) AS count FROM comments WHERE ticket_id = ? AND body = 'Comment on B'").get(ticketB.id).count, 1);
      assert.equal(dbB.prepare("SELECT COUNT(*) AS count FROM comments WHERE ticket_id = ? AND kind = 'completion' AND body = 'Complete on B'").get(ticketB.id).count, 1);
      assert.equal(dbB.prepare("SELECT COUNT(*) AS count FROM review_verdicts WHERE ticket_id = ? AND verdict = 'PASS'").get(ticketB.id).count, 1);
      assert.equal(dbB.prepare("SELECT COUNT(*) AS count FROM tickets WHERE id = ?").get(archiveB.id).count, 0);
    } finally {
      dbA.close();
      dbB.close();
    }
  } finally {
    client?.close?.();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousProjectRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = previousProjectRoot;
  }
});
