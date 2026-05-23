export function localOwnerActor() {
  return {
    id: "local",
    name: "local",
    type: "human",
    role: "owner",
    permissions: ["owner", "read", "write", "claim"],
    boards: ["*"]
  };
}

export function localAgentActor() {
  return {
    id: "local-agent",
    name: "agent",
    type: "agent",
    role: "owner",
    permissions: ["owner", "read", "write", "claim"],
    boards: ["*"]
  };
}

function headerValue(req, name) {
  const value = req?.headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || "";
  return String(value || "");
}

function cleanActorField(value, fallback) {
  const clean = String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return clean || fallback;
}

function actorIdFromName(name) {
  return String(name || "agent")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "agent";
}

export function actorFromHttpRequest(req) {
  const actorType = headerValue(req, "x-orbit-actor-type").trim().toLowerCase();
  const agentName = headerValue(req, "x-orbit-agent-name");
  if (actorType !== "agent" && !agentName.trim()) return localOwnerActor();

  const name = cleanActorField(headerValue(req, "x-orbit-actor-name") || agentName, "agent");
  const id = cleanActorField(headerValue(req, "x-orbit-actor-id"), actorIdFromName(name));
  return {
    ...localAgentActor(),
    id,
    name
  };
}

export function authenticate() {
  return localOwnerActor();
}

export function actorFromToken() {
  return localOwnerActor();
}

export function canAccessBoard() {
  return true;
}

export function requireBoardAccess() {}

export function requireOwner() {}

export function requirePermission() {}

export function publicActor(actor) {
  return {
    id: actor.id,
    name: actor.name,
    type: actor.type,
    role: actor.role,
    permissions: actor.permissions
  };
}
