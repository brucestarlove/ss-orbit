# Orbit init wizard

Status: focused implementation spec for ticket #61.

This replaces the older Mission Control-shaped setup-mode design from Orbit tickets #26 and #27. Keep the useful lesson: `orbit init` should make the first board choice clear. Cut the rest. Orbit setup creates a project board and, optionally, the agent-ready affordances around that board. Suite and Sync concerns stay out.

## Goal

`orbit init` supports two first-pass modes:

1. Local board / no AI
2. AI-assisted board

Anything beyond those modes belongs to Starscape Suite, Starscape Sync, or an app-specific integration ticket.

## Command contract

These commands must work:

```bash
orbit init
orbit init --ai
orbit init --no-ai
```

| Command | Mode | Contract |
| --- | --- | --- |
| `orbit init` | AI-assisted board | Backwards-compatible default. |
| `orbit init --ai` | AI-assisted board | Explicit alias for the default. |
| `orbit init --no-ai` | Local board / no AI | No AI collaboration assumptions. |

Keep existing init flags:

- `--cwd <dir>` selects the project root.
- `--example` creates onboarding example tickets.

`SKILL-ORBIT.md` is managed Orbit guidance: `orbit init` writes it, and `orbit serve` refreshes registered repo copies on startup. Repo/team customization belongs in `AGENTS.md` or board `agent_instructions`, not in `SKILL-ORBIT.md`.

Do not add `--multi-ai`, `--output=starlog-authored`, `--starlog`, `--suite`, `--forge`, `--sync`, hosted-service flags, agent-guidance refresh flags, or remote-sync flags in this pass.

## Wizard rules

The first implementation should be clear without breaking scripts:

- If `--ai` or `--no-ai` is present, do not prompt.
- If running non-interactively, default to AI-assisted board.
- If an interactive prompt is added, Enter chooses AI-assisted board.
- Ask only for local/no-AI vs AI-assisted. Do not ask about Starlog, Suite dashboard, Nebula, Forgejo, Auth, hosted service, Sync links, artifacts, events, or remote sync.

Suggested prompt:

```text
Initialize Orbit for this repo

Orbit keeps a project board next to your code. Git stays the truth for code;
Orbit becomes the truth for tickets, planning state, handoff, and implementation notes.

Choose a first-run mode:

  1. Local board / no AI
     A local kanban board. No AI Ready lane or MCP setup step.

  2. AI-assisted board (recommended)
     Adds AI Ready, agent handoff fields, generated agent instructions, and MCP setup guidance.

Select a mode [2]:
```

## Mode behavior

### Local board / no AI

Triggered by `orbit init --no-ai`.

Behavior:

- Create or repair the board database and registry row for the selected project root.
- Persist `ai_enabled = 0`.
- Do not create the `AI Ready` lane.
- Keep ordinary lanes: `Backlog`, `Todo`, `In Progress`, `Review`, `Done`, `Cancelled`.
- Keep Orbit usable for human planning, ticket history, blockers, comments, and implementation notes.
- Generate `AGENTS.md` and `SKILL-ORBIT.md`, but do not present MCP connection as a required next step.
- If `--example` is used, keep example tickets out of AI Ready.

Success copy should say the board path returned by init, the selected mode, and the next `orbit serve` step. It should not imply AI is required.

### AI-assisted board

Triggered by `orbit init` and `orbit init --ai`.

Behavior:

- Create or repair the board database and registry row for the selected project root.
- Persist `ai_enabled = 1`.
- Ensure `AI Ready`, `In Progress`, and `Review` exist for agent flow.
- Create/update `AGENTS.md` as the repo-owned pointer and write the managed `SKILL-ORBIT.md` so agents know to read board context, respect blockers, use MCP/API tools, and update `ai_plan`, `implementation_summary`, and `implementation_updates`.
- Print MCP setup guidance after init, including project-root-specific `orbit mcp --cwd <repo>` / `PROJECT_ROOT=<repo>` guidance or the generated client snippet.
- If `--example` is used, stage the stable MCP exercise ticket in `AI Ready`.

Success copy should say AI collaboration lanes are present and the next step is connecting an agent through MCP.

## Generated guidance files

`orbit init` preserves generation of:

- `AGENTS.md`
- `SKILL-ORBIT.md`

`AGENTS.md` should stay terse and repo-owned: when work mentions Orbit/tickets/boards, read `SKILL-ORBIT.md` first. `SKILL-ORBIT.md` is Orbit-managed durable protocol and may be overwritten by `orbit init` or refreshed by `orbit serve`; it tells agents to read board context, check blockers, use Orbit API/MCP instead of editing SQLite directly, update implementation fields, and hand off through Review.

For local/no-AI boards, these files are still useful if an agent later opens the repo, but init output should not frame MCP as mandatory.

## MCP setup guidance

For AI-assisted boards, keep the current guidance:

- MCP config tells the AI client how to spawn Orbit's helper.
- `AGENTS.md` and `SKILL-ORBIT.md` are normal repo files, not streamed through MCP.
- Persistent MCP configs should use explicit `--cwd <repo>` / `PROJECT_ROOT=<repo>` so the helper attaches to the right board.

For local/no-AI boards, omit MCP guidance or label it optional later setup.

## Board mode metadata

First pass can keep `boards.ai_enabled` as the source of truth:

```text
ai_enabled = 0 -> local board / no AI
ai_enabled = 1 -> AI-assisted board
```

If a mode field is added, keep it deliberately small:

```json
{
  "setup_mode": "ai-assisted",
  "setup_schema_version": 1
}
```

Allowed `setup_mode` values: `local`, `ai-assisted`.

Compatibility:

```text
missing setup_mode + ai_enabled = 0 -> local
missing setup_mode + ai_enabled = 1 -> ai-assisted
```

Do not persist Starlog output mode, Suite profile, Forge mode, Sync mode, hosted Auth state, or remote-sync configuration in Orbit setup metadata.

## Explicitly out of scope

| Deferred concern | Route |
| --- | --- |
| Starscape Suite dashboard, module/plugin setup, unified launcher, ecosystem settings | `ss-suite` #1 |
| Nebula / whiteboard setup | `ss-suite` #1 or the Nebula board |
| Starlog output/reporting mode, authored HTML outputs, templates | Suite/app integration work, not Orbit init |
| Forgejo/Gitea suite mode, local forge provisioning, themed forge navigation | `ss-suite` #1 |
| Starscape Auth, hosted service, cloud accounts, managed hosting | `ss-suite` #1 / hosted-service follow-up |
| Cross-app registry, object identity, links/backrefs, artifacts, activity/events, export/import, remote sync | `ss-sync` #1 |
| Mission Briefs, named agent ecology, wave execution, multi-agent orchestration | Later Orbit Mission Control work, not this wizard |

Mapping note: Orbit keeps local project boards, generated agent guidance, agent-ready lanes, MCP setup, and ticket implementation records. Suite composition maps to `ss-suite` #1. Registry/link/artifact/event/sync semantics map to `ss-sync` #1.

## Implementation checklist for the next build ticket

- `orbit init`, `orbit init --ai`, and `orbit init --no-ai` all work.
- `orbit init --ai` is an explicit alias for the default AI-assisted path.
- Local/no-AI mode creates no `AI Ready` lane and does not require MCP setup.
- AI-assisted mode keeps AI lanes, generated guidance files, MCP guidance, and example-ticket staging behavior.
- Generated `AGENTS.md` / `SKILL-ORBIT.md` keep agents on Orbit API/MCP rather than direct SQLite edits.
- Setup metadata is limited to `local` / `ai-assisted` plus schema version, or remains derived from `ai_enabled`.
- No Suite, Sync, Starlog, Nebula, Forgejo, Auth, hosted service, artifact, link, event, or remote-sync setup enters Orbit init.
