import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const ORBIT_AGENTS_START = "<!-- ORBIT:AGENTS-START -->";
export const ORBIT_AGENTS_END = "<!-- ORBIT:AGENTS-END -->";
export const ORBIT_AGENTS_CANONICAL_LINE =
  "Git is canonical for code. `SKILL-ORBIT.md` is canonical for Orbit/kanban/ticket/card workflow.";

export function orbitAgentsSection() {
  return `${ORBIT_AGENTS_START}
${ORBIT_AGENTS_CANONICAL_LINE}

When work mentions Orbit, kanban, board, lane, ticket, card, epic, blocker, claim, AI Ready, implementation fields, planning state, project memory, or handoff: read \`SKILL-ORBIT.md\` first and follow it.
Use Orbit API/MCP tools for tickets/cards; do not edit .orbit/board.db directly.
${ORBIT_AGENTS_END}\n`;
}

export function buildAgentsMd() {
  return `# AGENTS.md

${orbitAgentsSection()}`;
}

export function syncSkillOrbitMd(projectRoot, skillSrc) {
  const skillDest = resolve(projectRoot, "SKILL-ORBIT.md");
  if (!existsSync(skillSrc)) {
    return { ok: false, status: "missing_source", source: skillSrc, path: skillDest };
  }
  if (resolve(skillSrc) === skillDest) {
    return { ok: true, status: "same_file", source: skillSrc, path: skillDest };
  }
  copyFileSync(skillSrc, skillDest);
  return { ok: true, status: "written", source: skillSrc, path: skillDest };
}

/**
 * Write both Orbit helper files (SKILL-ORBIT.md + the AGENTS.md Orbit section)
 * into a project root. This is the shared core behind `orbit init` and the
 * web-UI "Generate AI helper files" checkbox, so the two flows stay identical.
 * Never throws — returns a result the caller can log or ignore.
 */
export function generateHelperFiles(projectRoot, skillSrc, logger = console.log) {
  if (!existsSync(skillSrc)) {
    return { ok: false, status: "missing_source", source: skillSrc };
  }
  const skill = syncSkillOrbitMd(projectRoot, skillSrc);
  syncAgentsMd(projectRoot, {}, logger);
  return { ok: true, status: skill.status, skill };
}

export function syncAgentsMd(projectRoot, _options = {}, logger = console.log) {
  const agentsPath = resolve(projectRoot, "AGENTS.md");
  const section = orbitAgentsSection();

  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, buildAgentsMd(), "utf8");
    logger(`Wrote ${agentsPath}`);
    return;
  }

  const current = readFileSync(agentsPath, "utf8");
  const startIndex = current.indexOf(ORBIT_AGENTS_START);
  const endIndex = current.indexOf(ORBIT_AGENTS_END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    logger("AGENTS.md already includes Orbit instructions — left unchanged.");
    return;
  }

  writeFileSync(agentsPath, `${current.replace(/\s*$/, "\n\n")}${section}`, "utf8");
  logger(`Appended Orbit instructions to ${agentsPath}`);
}

function removeExactLegacyIntro(before) {
  const escaped = ORBIT_AGENTS_CANONICAL_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const legacyIntro = new RegExp(`(?:^|\\n)[ \\t]*${escaped}[ \\t]*(?:\\r?\\n)?[ \\t]*$`);
  return before.replace(legacyIntro, (match) => (match.startsWith("\n") ? "\n" : ""));
}

function joinAfterAgentsRemoval(beforeRaw, afterRaw) {
  const before = removeExactLegacyIntro(beforeRaw).replace(/\s*$/, "");
  const after = afterRaw.replace(/^\s*/, "");
  if (before && after) return `${before}\n\n${after}`;
  if (before) return `${before}\n`;
  return after;
}

export function removeOrbitAgentsSection(projectRoot) {
  const agentsPath = resolve(projectRoot, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    return { ok: true, removed: false, path: agentsPath, reason: "agents_md_missing" };
  }

  const current = readFileSync(agentsPath, "utf8");
  const startMatches = [...current.matchAll(new RegExp(ORBIT_AGENTS_START, "g"))];
  const endMatches = [...current.matchAll(new RegExp(ORBIT_AGENTS_END, "g"))];
  if (startMatches.length === 0 && endMatches.length === 0) {
    return { ok: true, removed: false, path: agentsPath, reason: "orbit_section_missing" };
  }
  if (startMatches.length !== 1 || endMatches.length !== 1 || endMatches[0].index <= startMatches[0].index) {
    return { ok: false, removed: false, path: agentsPath, reason: "ambiguous_orbit_section" };
  }

  const startIndex = startMatches[0].index;
  const endIndex = endMatches[0].index + ORBIT_AGENTS_END.length;
  const next = joinAfterAgentsRemoval(current.slice(0, startIndex), current.slice(endIndex));
  if (next !== current) writeFileSync(agentsPath, next, "utf8");
  return { ok: true, removed: next !== current, path: agentsPath };
}
