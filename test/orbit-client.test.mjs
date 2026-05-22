import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpOrbitClient, createOrbitClient, orbitMode } from "../src/mcp/orbit-client.js";

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
    return new Response(JSON.stringify({ ok: true }), { status: options.method === "POST" && String(url).endsWith("/api/tickets") ? 201 : 200 });
  };
  const client = createHttpOrbitClient({ ORBIT_API_URL: "http://orbit.example/api-root/", ORBIT_DEFAULT_BOARD: "starlove-orbit" }, fetchImpl);

  await client.boardContext({ include_struck: true });
  await client.search({ q: "ticket 53", limit: 5 });
  await client.createTicket({ title: "Remote ticket" });

  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, "http://orbit.example/api-root/api/boards/starlove-orbit/context?include_struck=true");
  assert.equal(calls[1].url, "http://orbit.example/api-root/api/search?q=ticket+53&limit=5&board=starlove-orbit");
  assert.deepEqual(calls[2], {
    url: "http://orbit.example/api-root/api/tickets",
    method: "POST",
    body: { title: "Remote ticket", board: "starlove-orbit" }
  });
});
