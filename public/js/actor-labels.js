// Human-facing actor labels for ticket activity. The storage layer keeps
// compact/internal identifiers such as "local" and "local-agent"; the drawer
// should translate those into labels that explain who acted without exposing
// implementation details or blaming agent actions on the current user.

const INTERNAL_LOCAL_NAMES = new Set(["local", "local-owner", "owner"]);
const GENERIC_AGENT_NAMES = new Set(["agent", "local-agent", "orbit-agent"]);
const AGENT_COMMENT_KINDS = new Set(["agent_note", "checkpoint", "completion"]);

function clean(value) {
  return String(value || "").trim();
}

function humanizeIdentifier(value) {
  const raw = clean(value);
  if (!raw) return "";
  return raw
    .replace(/^@+/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function agentNameFrom({ actor, actorId } = {}) {
  const name = clean(actor);
  const id = clean(actorId);
  const lowerName = name.toLowerCase();
  const lowerId = id.toLowerCase();

  if (name && !INTERNAL_LOCAL_NAMES.has(lowerName) && !GENERIC_AGENT_NAMES.has(lowerName)) {
    return humanizeIdentifier(name);
  }
  if (id && !INTERNAL_LOCAL_NAMES.has(lowerId) && !GENERIC_AGENT_NAMES.has(lowerId)) {
    return humanizeIdentifier(id);
  }
  return "";
}

export function formatActorLabel({ actor, actorType, actorId } = {}) {
  const type = clean(actorType).toLowerCase();
  const name = clean(actor);
  const lowerName = name.toLowerCase();

  if (type === "agent") {
    const agentName = agentNameFrom({ actor: name, actorId });
    return agentName ? `Agent · ${agentName}` : "Agent";
  }

  if (!name || INTERNAL_LOCAL_NAMES.has(lowerName)) return "You";
  return humanizeIdentifier(name);
}

export function formatCommentAuthor(comment = {}) {
  const kind = clean(comment.kind).toLowerCase();
  const author = clean(comment.author);
  const isAgentKind = AGENT_COMMENT_KINDS.has(kind) || (kind && kind !== "human_comment");

  if (isAgentKind) {
    const agentName = agentNameFrom({ actor: author });
    return agentName ? `Agent · ${agentName}` : "Agent";
  }

  return formatActorLabel({ actor: author, actorType: "human" });
}
