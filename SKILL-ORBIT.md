# SKILL-ORBIT.md

Read this before repo work. This board is the repo-local memory and execution layer.

## MCP, cwd, and this file

These are separate concerns; mixing them causes confusion:

- **Where Orbit is installed** — Your MCP client stores an **absolute path** to Orbit's `src/mcp-server.js` (the generated snippet under **Settings → AI**). Claude Code / Codex / Cursor keep that registration. Starting your agent **from another folder** does not change that path.

- **Which board MCP tools use** — Orbit can target either a local board discovered from a repo path or a hosted board by remote URL. For local boards, the MCP helper uses the explicit project root passed by `orbit mcp --cwd <repo>` or `PROJECT_ROOT`; without either, it falls back to the process current working directory and walks upward until it finds a repo with `.orbit/board.db` (details in [`docs/MCP_SETUP.md`](docs/MCP_SETUP.md)). For remote/hosted boards, use the explicit board/server URL from the prompt or environment, then `board_list` + `board_set_active` before mutations; repo cwd remains code context, not planning-state authority. Prefer explicit `--cwd` / `PROJECT_ROOT` or explicit remote URL in persistent MCP configs so the right board attaches even when the agent launches elsewhere.

- **This file** — Coding agents resolve `SKILL-ORBIT.md` through normal **filesystem / workspace search**, not through MCP tools. Keep a copy **in each repo** where you run an agent against that board—usually the repo that contains `.orbit/board.db`. If you edit in a multi-root workspace with more than one `SKILL-ORBIT.md`, name the repo or path explicitly in your prompt.

## Use The Board

- Read `agent_instructions` on the board first, then the ticket context pack.
- Respect blockers and parent epics.
- Use comments for discussion and breadcrumbs.
- Use ticket fields for durable implementation records: `ai_plan`, `implementation_summary`, `implementation_updates`.
- Add a project entry when the context should outlive one ticket.

## Dispatching Agents

`orbit dispatch --board <slug> --ticket <number-or-id> --profile <name> --worktree` is the preferred human/orchestrator entrypoint for starting a Hermes agent on a specific card.

Dispatch responsibilities:
- Generate the handoff and store the canonical copy in the card's `ai_plan` / AI Written-Plan field.
- Move the card to In Progress.
- Preserve a git worktree/branch for human testing when `--worktree` is used.
- Add a run-record comment with profile, policy, branch, worktree, pid, and command.
- Apply the default safe PATH policy wrappers unless `--policy none` is explicit.

Agent completion responsibilities remain unchanged:
- Write final work notes to `implementation_summary`.
- Write pitfalls, remediation, and reusable future guidance to `implementation_updates`.
- Add comments for transient breadcrumbs/run events.
- Move the card to Review unless the human explicitly asked for Done.

## Human CLI Checks

- `orbit -v` / `orbit --version`: print the installed Orbit CLI version for support, bug reports, and reproducibility notes.

## Historical Backfill

If asked to create historical tickets from logs, docs, commit history, notes, or conversations, reconstruct planning structure instead of making a flat list.

- `epic`: multi-phase chunk or large initiative.
- `feature`: standalone capability or one coherent stage of an epic.
- `task`: smaller scoped unit of work, including maintenance, cleanup, config, refactor, or repo hygiene.
- `bug`: defect, regression, incident, or broken behavior.

Rules:

- Prefer fewer, clearer epics with named feature cards underneath.
- Preserve source references in descriptions or comments.
- Mark uncertainty with `Inferred from...` or `Source suggests...`.
- Put implementation facts in `implementation_summary`.
- Put chronology, pitfalls, and lessons in `implementation_updates`.
- Keep future work open unless the source clearly supports `Done`.
- Do not invent acceptance criteria.

## Board Context Model

The board is the unit of organization. Each board is tied to one repo and carries:

- `repo_url`, `system_path`, `default_branch`: where the code lives.
- `agent_instructions`: project-level context for agents (purpose, surface area, stack, constraints, operating rules — included in ticket context packs). Edited under Settings → AI.
- `project_notes`: Notes For You — personal reminders on the board (Settings → Notes).

Use board-level memory entries for durable history:

- `decision`: UX or architecture choices agents should follow instead of defaulting to generic codegen.
- `lesson`: mistakes or discoveries distilled as "do X instead of Y when working with Z."

## Ticket Relationships

Two distinct, non-overlapping mechanisms:

- **Hierarchy** — `parent_ticket_id` on the ticket row. One epic owns many features/tasks/bugs. Set on create or via `PATCH /api/tickets/:id`. Only epics can have children; pass `null` to detach. Do not duplicate this link in `relations`.
- **Relations** — rows in the `relations` table with `type` of `relates_to`, `blocks`, or `blocked_by`. Use these for cross-cutting connections that aren't ownership: another team's ticket relates to mine, ticket A blocks ticket B, etc. The board rejects relations between a ticket and its direct parent epic (`relation_redundant_with_parent`) and self-relations (`relation_self`).

Before working a ticket, check blockers. A ticket is **not workable** while it has any `blocked_by` relation row. The relation row is the source of truth — it gets removed when the blocking ticket moves into the Done lane (state role `done`, server auto-deletes) or when a user removes the link manually in the UI. If a `blocked_by` target is an epic, the rule expands to *the epic's open children* — the ticket only becomes workable once every child sits in a Done-role lane (or is archived). The `claim-next` scheduler skips blocked tickets automatically; for ad-hoc checks call `GET /api/tickets/:id/blockers` (returns `can_start` + the unresolved blockers list, with `via_epic_id` on entries that came from epic expansion).

For a full picture of cross-cutting links call `GET /api/tickets/:id/relations`. The context pack (`GET /api/tickets/:id/context`) already includes both relations and blockers, so this dedicated endpoint is mostly for status-style queries that don't need the full pack.

## Common API Actions

- `GET /api/boards/:board_id/context`
- `GET /api/boards/:board_id/archive`
- `GET /api/tickets/:ticket_id/context?depth=1`
- `GET /api/tickets/:ticket_id/relations`
- `GET /api/tickets/:ticket_id/blockers`
- `POST /api/agent/claim-next`
- `PATCH /api/tickets/:ticket_id`
- `POST /api/tickets/:ticket_id/archive`
- `POST /api/tickets/:ticket_id/restore`
- `DELETE /api/tickets/:ticket_id`
- `POST /api/relations` / `DELETE /api/relations/:id`
- `POST /api/boards/:board_id/entries`

## Archive and Delete

Removing a card is a two-step process:

1. **Archive** (`POST /api/tickets/:ticket_id/archive`) — soft-deletes the card. Archived tickets are excluded from `bootstrap`, `search`, `claim-next`, blockers, relations, and the kanban view, but their data and comments are preserved. Reversible via `POST /api/tickets/:ticket_id/restore`.
2. **Delete** (`DELETE /api/tickets/:ticket_id`) — permanently removes the card. The ticket MUST already be archived; calling DELETE on a live card returns `409 ticket_not_archived`. Comments, labels, and relations are removed via cascade. Events for the ticket are kept but their `ticket_id` becomes `NULL`.

`GET /api/boards/:board_id/archive` returns `{ tickets: [...] }` listing archived tickets ordered by archive time (most recent first).

The same flow is exposed over MCP as `board_archive_ticket`, `board_restore_ticket`, `board_delete_ticket`, and `board_list_archive`. Always archive before deleting; archive when in doubt — restore is cheap, deletion is not.

## Current Rule

Board is canonical for planning state. Git repo is canonical for code.

Use Orbit API/MCP tools for tickets/cards and board memory. Do not open, edit, patch, script, or write .orbit/board.db directly unless you are explicitly debugging Orbit internals and the user asked for database repair.
