import { test } from "node:test";
import assert from "node:assert/strict";

import { formatActorLabel, formatCommentAuthor } from "../public/js/actor-labels.js";
import { actorFromHttpRequest } from "../src/core/auth.js";

test("status history labels local human actions as the current user", () => {
  assert.equal(formatActorLabel({ actor: "local", actorType: "human", actorId: "local" }), "You");
});

test("status history does not label local agent actions as the current user", () => {
  assert.equal(formatActorLabel({ actor: "agent", actorType: "agent", actorId: "local-agent" }), "Agent");
});

test("status history preserves named agent attribution", () => {
  assert.equal(formatActorLabel({ actor: "Planner", actorType: "agent", actorId: "planner" }), "Agent · Planner");
  assert.equal(formatActorLabel({ actor: "agent", actorType: "agent", actorId: "reviewer" }), "Agent · Reviewer");
});

test("status history hides raw local identifiers behind useful labels", () => {
  assert.equal(formatActorLabel({ actor: "local", actorType: "agent", actorId: "local-agent" }), "Agent");
  assert.equal(formatActorLabel({ actor: "orbit dispatch", actorType: "agent" }), "Agent · Orbit Dispatch");
});

test("comment author labels distinguish human and agent comments", () => {
  assert.equal(formatCommentAuthor({ author: "local", kind: "human_comment" }), "You");
  assert.equal(formatCommentAuthor({ author: "local", kind: "agent_note" }), "Agent");
  assert.equal(formatCommentAuthor({ author: "Planner", kind: "completion" }), "Agent · Planner");
});

test("HTTP actor headers can attribute mutations to a named agent", () => {
  const actor = actorFromHttpRequest({
    headers: {
      "x-orbit-actor-type": "agent",
      "x-orbit-actor-name": "Codex",
      "x-orbit-actor-id": "codex-cli"
    }
  });

  assert.equal(actor.type, "agent");
  assert.equal(actor.name, "Codex");
  assert.equal(actor.id, "codex-cli");
  assert.equal(formatActorLabel({ actor: actor.name, actorType: actor.type, actorId: actor.id }), "Agent · Codex");
});
