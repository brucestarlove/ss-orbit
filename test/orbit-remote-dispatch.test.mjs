import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { dispatchTicketAsync } from "../src/core/dispatch.js";

const repoRoot = resolve(import.meta.dirname, "..");

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), "orbit-remote-dispatch-test-"));
  const projectRoot = join(root, "project");
  const dataDir = join(root, "data");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ name: "remote-project" }), "utf8");
  initGitRepo(projectRoot);
  return { root, projectRoot, dataDir };
}

function runGit(args, cwd) {
  const git = process.platform === "win32" || !existsSync("/usr/bin/git") ? "git" : "/usr/bin/git";
  const result = spawnSync(git, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function initGitRepo(projectRoot) {
  runGit(["init"], projectRoot);
  runGit(["config", "user.name", "Orbit Remote Test"], projectRoot);
  runGit(["config", "user.email", "orbit-remote-test@example.invalid"], projectRoot);
  runGit(["add", "package.json"], projectRoot);
  runGit(["commit", "-m", "init"], projectRoot);
}

function makePacket(overrides = {}) {
  return {
    board: {
      id: "board-remote-1",
      slug: "starlove-orbit",
      name: "Starlove Orbit",
      repo_path: "/remote/ss-orbit",
      system_path: "/remote/ss-orbit",
      default_branch: "master",
      agent_instructions: "Remote board instructions"
    },
    ticket: {
      id: "ticket-remote-1",
      ticket_id: "ticket-remote-1",
      number: 128,
      title: "Remote dispatch target",
      type: "feature",
      priority: 2,
      state_id: "todo-state",
      state_name: "Todo",
      state_role: "todo",
      description: "Implement hosted dispatch.",
      acceptance: "Remote no-spawn prepares handoff.",
      ai_plan: "",
      plan_artifact_path: "",
      implementation_summary: "",
      implementation_artifact_path: "",
      implementation_updates: "",
      labels: ["dispatch"]
    },
    blockers: { can_start: true, blockers: [] },
    parent_ticket: null,
    relevant_state_ids: {
      current: "todo-state",
      current_role: "todo",
      in_progress: "in-progress-state",
      review: "review-state"
    },
    recent_comments: [{ id: "comment-1", author: "human", kind: "human_comment", body: "dispatch this from hosted", created_at: "2026-06-04T00:00:00.000Z" }],
    ...overrides
  };
}

function makeRemoteClient(packet = makePacket()) {
  const calls = [];
  return {
    calls,
    mode: "remote",
    async boardList() {
      calls.push(["boardList"]);
      return { boards: [{ id: packet.board.id, slug: packet.board.slug, name: packet.board.name, repo_path: packet.board.repo_path, default_branch: packet.board.default_branch }] };
    },
    async boardSetActive(args) {
      calls.push(["boardSetActive", args]);
      return { ok: true, slug: args.slug, mode: "remote" };
    },
    async getAgentDispatchPacket(args) {
      calls.push(["getAgentDispatchPacket", args]);
      return packet;
    },
    async getTicketBlockers(args) {
      calls.push(["getTicketBlockers", args]);
      return packet.blockers;
    },
    async updateTicket(args) {
      calls.push(["updateTicket", args]);
      return { ...packet.ticket, ...args };
    },
    async addComment(args) {
      calls.push(["addComment", args]);
      return { id: "remote-comment", ...args };
    }
  };
}

test("remote dispatch --dry-run reads hosted packet without local side effects", async () => {
  const h = makeHarness();
  const remoteClient = makeRemoteClient();
  const result = await dispatchTicketAsync({
    cwd: h.projectRoot,
    ticketUrl: "https://orbit.example/#/b/starlove-orbit/t/ticket-remote-1",
    profile: "nova",
    remote: true,
    dryRun: true,
    remoteClient
  });

  assert.equal(result.dry_run, true);
  assert.equal(result.board.slug, "starlove-orbit");
  assert.equal(result.ticket.id, "ticket-remote-1");
  assert.equal(result.repo_root, h.projectRoot);
  assert.equal(existsSync(join(h.projectRoot, ".orbit", "dispatch-runs")), false);
  assert.equal(existsSync(join(dirname(h.projectRoot), ".worktrees")), false);
  assert.equal(existsSync(join(h.dataDir, "registry.db")), false);
  assert.deepEqual(remoteClient.calls.map((call) => call[0]), ["boardSetActive", "getAgentDispatchPacket", "getTicketBlockers"]);
});

test("remote dispatch --no-spawn prepares handoff/worktree and writes hosted run record", async () => {
  const h = makeHarness();
  const remoteClient = makeRemoteClient();
  const result = await dispatchTicketAsync({
    cwd: h.projectRoot,
    ticketUrl: "https://orbit.example/#/b/starlove-orbit/t/ticket-remote-1",
    profile: "nova",
    remote: true,
    worktree: true,
    noSpawn: true,
    policy: "none",
    remoteClient,
    env: { DATA_DIR: h.dataDir }
  });

  assert.equal(result.no_spawn, true);
  assert.equal(result.spawned, false);
  assert.match(result.run_id, /^orbit-128-nova-/);
  assert.equal(existsSync(result.handoff_path), true);
  assert.equal(existsSync(result.run_record_path), true);
  assert.equal(existsSync(join(result.worktree_path, "package.json")), true);
  assert.equal(dirname(result.worktree_path), join(dirname(h.projectRoot), ".worktrees", basename(h.projectRoot)));

  const handoff = readFileSync(result.handoff_path, "utf8");
  assert.match(handoff, /Remote board instructions/);
  assert.match(handoff, /dispatch this from hosted/);
  assert.match(handoff, /ORBIT_MODE=remote/);

  const runRecord = JSON.parse(readFileSync(result.run_record_path, "utf8"));
  assert.equal(runRecord.transport, "remote");
  assert.equal(runRecord.mode, "prepare-only");
  assert.equal(runRecord.status, "prepared");
  assert.equal(runRecord.server_url, "[redacted-url-present]");
  assert.equal(runRecord.ticket_id, "ticket-remote-1");

  const updateCall = remoteClient.calls.find((call) => call[0] === "updateTicket");
  assert.ok(updateCall);
  assert.equal(updateCall[1].ticket_id, "ticket-remote-1");
  assert.equal(updateCall[1].board_slug, "starlove-orbit");
  assert.match(updateCall[1].ai_plan, /Full generated handoff is linked as markdown:/);
  assert.equal(Object.hasOwn(updateCall[1], "state_id"), false);

  const commentCall = remoteClient.calls.find((call) => call[0] === "addComment");
  assert.ok(commentCall);
  assert.match(commentCall[1].body, /mode: prepare-only/);
  assert.match(commentCall[1].body, /remote hosted board/);
});

test("remote dispatch refuses blocked hosted tickets before artifacts", async () => {
  const h = makeHarness();
  const packet = makePacket({ blockers: { can_start: false, blockers: [{ number: 9, title: "Blocking card", state_name: "Todo" }] } });
  const remoteClient = makeRemoteClient(packet);

  await assert.rejects(
    () => dispatchTicketAsync({
      cwd: h.projectRoot,
      ticketUrl: "https://orbit.example/#/b/starlove-orbit/t/ticket-remote-1",
      profile: "nova",
      remote: true,
      noSpawn: true,
      remoteClient
    }),
    /Ticket #128 is blocked: #9 Blocking card/
  );

  assert.equal(existsSync(join(h.projectRoot, ".orbit", "dispatch-runs")), false);
  assert.equal(remoteClient.calls.some((call) => call[0] === "updateTicket" || call[0] === "addComment"), false);
});
