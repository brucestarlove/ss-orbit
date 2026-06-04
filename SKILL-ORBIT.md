# SKILL-ORBIT.md

Read this before repo work. This board is the repo-local memory and execution layer.

This file is managed by Orbit and may be overwritten by `orbit init` or refreshed by `orbit run`. Put repo/team-specific agent rules in `AGENTS.md` or board `agent_instructions`, not here.

## Orbit Coordinates

Optional project-local hints. Explicit user instructions, MCP/API selectors, and live board metadata win.

Optional coordinates:
- orbit_api_url:
- orbit_board:

Leave unknown values blank rather than guessing. These hints are for orientation only; agents must still resolve the intended board before mutating tickets.

## Local vs Hosted Boards

- Always resolve the intended board before reading or mutating tickets.
- Prefer Orbit API/MCP tools over direct database edits.
- If an Orbit API URL or hosted board is configured for the task, treat that board as the planning-state source of truth.
- Local `.orbit/board.db` files may be stale, absent, or unrelated when a hosted board is in use.
- Artifact paths may be repo-relative paths, local filesystem paths, or hosted-accessible paths; verify availability before citing them as readable.

## MCP, cwd, and this file

These are separate concerns; mixing them causes confusion:

- **Where Orbit is installed** — Your MCP client stores an **absolute path** to Orbit's `src/mcp-server.js` (the generated snippet under **Settings → AI**). Claude Code / Codex / Cursor keep that registration. Starting your agent **from another folder** does not change that path.

- **Which board MCP tools use** — Orbit can target either a local board discovered from a repo path or a hosted board by remote URL. For local boards, the MCP helper uses the explicit project root passed by `orbit mcp --cwd <repo>` or `PROJECT_ROOT`; without either, it falls back to the process current working directory and walks upward until it finds a repo with `.orbit/board.db` (details in [`docs/MCP_SETUP.md`](docs/MCP_SETUP.md)). For remote/hosted boards, use the explicit board/server URL from the prompt or environment, then `board_list` + `board_set_active` before mutations; repo cwd remains code context, not planning-state authority. Prefer explicit `--cwd` / `PROJECT_ROOT` or explicit remote URL in persistent MCP configs so the right board attaches even when the agent launches elsewhere.

- **This file** — Coding agents resolve `SKILL-ORBIT.md` through normal **filesystem / workspace search**, not through MCP tools. Keep a copy **in each repo** where you run an agent against that board—usually the repo that contains `.orbit/board.db`. If you edit in a multi-root workspace with more than one `SKILL-ORBIT.md`, name the repo or path explicitly in your prompt.

## Use The Board

### Orbit vocabulary rule

In Orbit / kanban / ticket contexts, `epic` is a ticket `type`, not an adjective. If Bruce says "make/create an epic ticket/card about X" or "make an epic for X," create or update a ticket with `type: "epic"` whose subject is X. Do not reinterpret the word as "impressive," "big," or "high quality," and do not expand scope beyond the requested ticket type unless the prompt separately asks for planning/decomposition.

- Read `agent_instructions` on the board first, then the ticket context pack.
- Respect blockers and parent epics.
- Use comments for discussion and compact breadcrumbs.
- Keep human-visible ticket fields terse and use the existing fields by intent:
  - `ai_plan` / AI Plan: terse visible plan summary; full markdown handoffs live in `plan_artifact_path`.
  - `implementation_summary` / Work Summary: terse visible result summary; full markdown reports/evidence live in `implementation_artifact_path`.
  - `implementation_updates` / Revisions: terse later changes/corrections after initial implementation. Leave blank for normal first completion; do not store chronology, command logs, routine run receipts, or durable project lessons here.
- Use board Journal entries (`decision` / `lesson`) only for durable reusable project decisions/lessons every future board agent should load.

## Dispatching Agents

`orbit dispatch --board <slug> --ticket <number-or-id> --profile <name> --worktree` is the preferred human/orchestrator entrypoint for starting an agent on a specific card.

Dispatch responsibilities:
- Generate the full handoff as a linked markdown artifact and put only a terse summary in the existing `ai_plan` / AI Plan field.
- Move the card to In Progress.
- Preserve a git worktree/branch for human testing when `--worktree` is used.
- Add a compact run-record comment with profile, policy, branch, worktree, pid, command, and artifact path.
- Apply the default safe PATH policy wrappers unless `--policy none` is explicit.

Agent completion responsibilities:
- Write a terse human-readable result to the existing `implementation_summary` / Work Summary field.
- If details matter, write a markdown report and link it with `implementation_artifact_path`.
- Leave Revisions (`implementation_updates`) blank unless this is a later change/correction after initial implementation. No chronology, logs, normal run details, or durable project lessons.
- Promote project-wide code/pattern lessons and decisions to the board Journal (`lesson` / `decision`) instead of burying them on one card.
- Add compact comments for transient breadcrumbs/run events.
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
- Put only terse work-summary facts in `implementation_summary`.
- Put full historical detail in linked markdown artifacts or comments, not the visible card fields.
- Put only terse card-specific later revision notes in `implementation_updates`; promote reusable code/pattern/project lessons and decisions to board Journal entries.
- Keep future work open unless the source clearly supports `Done`.
- Do not invent acceptance criteria.

## Board Context Model

The board is the unit of organization. Each board is tied to one repo and carries:

- `repo_url`, `system_path`, `default_branch`: where the code lives.
- `agent_instructions`: project-level context for agents (purpose, surface area, stack, constraints, operating rules — included in ticket context packs). Edited under Settings → AI.
- `project_notes`: Notes For You — personal reminders on the board (Settings → Notes).

Use board-level memory entries for durable history:

- `decision`: important UX, architecture, workflow, naming, or project choices every future agent on this board should follow instead of defaulting to generic codegen.
- `lesson`: important code, pattern, or project failure modes/discoveries distilled as "do X instead of Y when working with Z."

Board Journal entries are durable project memory loaded for agents working this board, not general notes or persona guidance. Keep active decisions/lessons focused on the most important mechanisms, architectural/product boundaries, workflow invariants, public-product implications, and reusable pitfalls. Prefer ticket comments/implementation fields for one-run chronology, and strike or consolidate stale overlapping entries once a doctrine stabilizes.

## Ticket Relationships

Two distinct, non-overlapping mechanisms:

- **Hierarchy** — `parent_ticket_id` on the ticket row. One epic owns many features/tasks/bugs. Set on create or via `PATCH /api/tickets/:id`. Only epics can have children; pass `null` to detach. Do not duplicate this link in `relations`.
- **Relations** — rows in the `relations` table with `type` of `relates_to`, `blocks`, or `blocked_by`. Use these for cross-cutting connections that aren't ownership: another team's ticket relates to mine, ticket A blocks ticket B, etc. The board rejects relations between a ticket and its direct parent epic (`relation_redundant_with_parent`) and self-relations (`relation_self`).

Before working a ticket, check blockers. A ticket is **not workable** while it has any `blocked_by` relation row. The relation row is the source of truth — it gets removed when the blocking ticket moves into the Done lane (state role `done`, server auto-deletes) or when a user removes the link manually in the UI. If a `blocked_by` target is an epic, the rule expands to *the epic's open children* — the ticket only becomes workable once every child sits in a Done-role lane (or is archived). The `claim-next` scheduler skips blocked tickets automatically; for ad-hoc checks call `GET /api/tickets/:id/blockers` (returns `can_start` + the unresolved blockers list, with `via_epic_id` on entries that came from epic expansion).

For a full picture of cross-cutting links call `GET /api/tickets/:id/relations`. The context pack (`GET /api/tickets/:id/context`) already includes both relations and blockers, so this dedicated endpoint is mostly for status-style queries that don't need the full pack.

## Common API Actions

- `GET /api/boards/:board_id/context`
- `GET /api/boards/:board_id/archive`
- `GET /api/tickets/:ticket_id`
- `GET /api/tickets/lookup?board=<slug>&number=<n>` / `GET /api/tickets/lookup?board=<slug>&title=<exact-title>`
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
