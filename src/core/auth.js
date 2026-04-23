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
