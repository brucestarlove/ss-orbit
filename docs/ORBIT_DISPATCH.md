# Orbit Dispatch

`orbit dispatch` is the local Orbit-to-Hermes handoff command. It turns a local Orbit ticket into a bounded agent run without relying on a temporary prompt file as the source of truth.

The design intent is simple:

- Git remains canonical for code.
- Orbit remains canonical for planning, handoff, run records, and implementation notes.
- The ticket becomes the shared communication surface between the human, orchestrator, and dispatched agent.

## Current remote-board contract

`orbit dispatch` is intentionally local-board only right now. It resolves boards through the local Orbit registry and mutates the local SQLite board file.

Because of that, `--server-url` and `--remote` are refused before side effects. They do not silently target a hosted board.

For hosted/remote boards, use remote MCP/manual orchestration or run `orbit dispatch` on the board host without `--server-url`/`--remote`.

## Basic use

From the code repository you are working in, target the local Orbit board explicitly:

```bash
orbit dispatch \
  --board my-app \
  --ticket 12 \
  --profile agent \
  --worktree
```

Common variants:

```bash
# Preview only. No files, worktrees, ticket fields, comments, or agents change.
orbit dispatch --board my-app --ticket 12 --dry-run

# Prepare the handoff/comment/worktree, but do not spawn Hermes and do not move the card to In Progress.
orbit dispatch --board my-app --ticket 12 --profile agent --worktree --no-spawn

# Attach the Hermes child process to the current terminal instead of detaching it.
orbit dispatch --board my-app --ticket 12 --profile agent --worktree --foreground

# Use an explicit branch/worktree name.
orbit dispatch --board my-app --ticket 12 --profile agent --worktree \
  --branch orbit/my-app-12-search \
  --worktree-path .worktrees/my-app-12-search

# Declare ticket-specific verification expectations in the handoff/run record.
orbit dispatch --board my-app --ticket 12 --profile agent --worktree \
  --verify-command "node --test test/orbit-cli.test.mjs" \
  --verify-command "git diff --check"
```

## Preflight order

Before any filesystem writes, worktree creation, ticket mutation, or agent spawn, dispatch now:

1. Refuses `--server-url` / `--remote`.
2. Resolves the local board from `--board` or from `--cwd` / the current repo.
3. Resolves the ticket from `--ticket` by number or id.
4. Refuses archived tickets.
5. Refuses blocked tickets unless `--force` is passed.
6. Rejects missing or flag-looking `--verify-command` values during CLI argument parsing.
7. For spawn mode, checks that the Hermes binary exists and the requested profile is plausible.
8. Handles `--dry-run` as a true no-write preview.

Only after those checks does dispatch create run artifacts/worktrees, write the handoff/comment, move the ticket, or spawn Hermes.

## What dispatch does

In normal spawn mode:

1. Builds a run id such as `orbit-12-agent-abc123def0`.
2. Creates `.orbit/dispatch-runs/<run-id>/` for run metadata and policy wrappers.
3. Creates and preserves a git worktree/branch when `--worktree` is used.
4. Generates a full agent handoff.
5. Writes an initial durable `run-record.json` with status `prepared` before ticket mutation or agent spawn.
6. Writes the canonical handoff copy to the ticket's **AI Written-Plan** (`ai_plan`) field.
7. Moves the ticket to **In Progress**.
8. Starts Hermes.
9. Updates `run-record.json` to status `launched` with the child process id.
10. Comments a run record back onto the ticket.

In `--no-spawn` mode, dispatch writes the handoff, initial `run-record.json`, and run-record comment but leaves the ticket in its current lane.

The run record includes profile, policy, ticket, branch, worktree, base commit, policy-bin path, child process id, command, declared verification commands, mode, and a `run-record.json` path. This makes the card the visible cockpit for the run while preserving a machine-readable artifact for later review/repair automation.

## Structured run record

Every non-dry-run dispatch writes `<DATA_DIR>/dispatch-runs/<board>/<run-id>/run-record.json` with schema `orbit.dispatch.run.v1`.

The JSON record currently captures:

- run id, board id/slug, ticket id/number, profile, policy, mode, and status (`prepared` for `--no-spawn`, `launched` for spawned runs)
- prompt/handoff path, repo root, worktree, branch, and base commit
- process id when a Hermes child was spawned
- declared verification commands
- empty `commit_shas` and `residual_risks` arrays for completion/review tooling to fill in later slices
- a small environment-variance snapshot: platform, Node version, cwd, path format, and relevant `HOME`, `PROJECT_ROOT`, `DATA_DIR`, and `ORBIT_*` env vars

URL-bearing values are presence-only redacted in `run-record.json`. `ORBIT_API_URL`, `ORBIT_SERVER_URL`, and the top-level `server_url` field are recorded as `[redacted-url-present]` when present, rather than persisting usernames, passwords, query tokens, fragments, hostnames, or paths. Non-URL environment checklist values such as `HOME`, `PROJECT_ROOT`, `DATA_DIR`, `ORBIT_MODE`, and `ORBIT_DEFAULT_BOARD` remain visible for variance debugging.

Operators can override the default verification contract by repeating `--verify-command <cmd>` or using `--verify-command=<cmd>`. Bare `--verify-command`, `--verify-command=` and `--verify-command` followed by another flag are rejected before dispatch side effects. If omitted, dispatch declares the standard local-safe checklist: `npm test`, conditional `npm run build`, `node src/cli/orbit.js dispatch --help`, `git diff --check`, and `git diff --cached --check before commit`.

## Structured review verdict records

Sentinel/agent review results are first-class board data in `review_verdicts`, not prose-only comments. Each record belongs to one ticket and stores:

- `verdict`: one of `PASS`, `BLOCK`, or `QUESTION`
- `blocking_findings`: JSON array for issues that must be repaired before approval
- `optional_findings`: JSON array for non-blocking review notes
- `evidence_commands`: JSON array of commands or probes the reviewer used as evidence
- `reviewer_profile` and `reviewer_session_id`: optional reviewer identity/session metadata
- `reviewed_commit_sha`: optional commit SHA under review
- `dispatch_run_id`: optional dispatch run id tying the verdict back to `run-record.json`
- `supersedes_prior_review_id`: optional link to an earlier verdict on the same ticket

HTTP API:

```text
POST /api/tickets/:ticket_id/review-verdicts
GET  /api/tickets/:ticket_id/review-verdicts?limit=50
GET  /api/review-verdicts/:review_id?board=<slug-or-id>
```

MCP tools:

```text
board_create_review_verdict
board_list_review_verdicts
board_get_review_verdict
```

Comments may mirror verdict summaries for human scanning, but comments are not the source of truth for review automation. Later repair and re-review tooling should read these records directly.

## The AI Written-Plan handoff

Dispatch stores the generated handoff in the ticket's AI Written-Plan field. It includes:

- mission and ticket metadata
- repository root, worktree, branch, and run id
- required reading order: `AGENTS.md`, `SKILL-ORBIT.md`, then the handoff
- ticket description
- implementation fields (`ai_plan`, `implementation_summary`, `implementation_updates`)
- board-level agent instructions and notes
- board journal lessons/decisions
- parent/child ticket context
- unresolved blockers
- scope boundaries
- autonomous policy
- declared verification commands and environment-variance checklist
- completion protocol

The short prompt passed to `hermes chat -q` is intentionally small. The ticket is the source of truth; the CLI argument is only a bootstrap pointer.

Board journal entries are framed as project constraints and lessons, not persona or roleplay instructions. Keep durable board entries focused on mechanisms, architectural/product boundaries, workflow invariants, public-product implications, and reusable pitfalls; use ticket fields/comments for run-specific chronology.

## Preserved worktrees

Use `--worktree` when the agent will edit code. Dispatch creates a normal git worktree under `.worktrees/` by default and gives the agent that directory as its working directory.

This solves the ephemeral-agent problem: humans can test the branch/worktree before cleanup.

Default shape:

```text
.worktrees/<board>-<ticket>-<profile>-<shortid>
orbit/<board>-<ticket>-<profile>-<shortid>
```

`.worktrees/` is ignored by git.

## Safe autonomous policy

The default policy prepends `.orbit/dispatch-runs/<run-id>/policy-bin` to the child agent's `PATH`. That directory contains wrappers for commands that should be restricted during an autonomous run.

Allowed:

- file reads/searches and local edits
- `git status`, `git diff`, `git log`, `git show`, `git add`, local `git commit`, safe branch inspection/creation
- package test/build/lint/check/typecheck scripts

Blocked or requiring human approval:

- Docker
- `git push`
- destructive git commands such as reset, clean, rebase, merge, checkout/switch/restore, tag, cherry-pick, worktree mutation
- package install/publish/version/deploy/release commands
- recursive or force `rm`
- SSH/SCP/rsync
- GitHub CLI
- direct curl/wget network calls
- cloud/deploy CLIs
- `sudo`

Use `--policy none` only when you intentionally want to dispatch without wrappers.

## Agent completion protocol

The dispatched agent should:

1. Run relevant tests and focused manual/API checks.
2. Commit locally on the dispatch branch.
3. Update **AI Implementation Summary** (`implementation_summary`) with what changed, commit SHA, branch/worktree, verification, and manual checks still needed.
4. Add **Implementation Updates/Lessons** (`implementation_updates`) for pitfalls, remediation, and reusable guidance.
5. Add a completion comment/run record.
6. Move the card to **Review**, not Done, unless the human explicitly asked for auto-completion.

## Installing / enabling the command

For source installs:

```bash
cd /path/to/ss-orbit
pnpm install
pnpm run build:full
pnpm link --global
```

Then from a project repo with an Orbit board:

```bash
orbit init            # if the repo does not have a board yet
orbit dispatch --board my-app --ticket 12 --profile agent --worktree --no-spawn
```

For support, bug reports, and reproducibility notes, human users can print the installed CLI version with either form:

```bash
orbit -v
orbit --version
```

## Operator notes for orchestrators

- Prefer `orbit dispatch` over writing a temporary handoff prompt file when targeting a local board.
- Use `--dry-run` when you want proof of what would happen without any side effects.
- Use `--no-spawn` when you want to inspect the generated handoff/worktree/comment before starting an agent.
- Use `--worktree` for code edits so the human can test before cleanup.
- Treat the ticket fields as durable surfaces:
  - AI Written-Plan: generated handoff
  - AI Implementation Summary: final summary of completed work
  - Implementation Updates/Lessons: pitfalls, remediation, future-agent guidance
  - Comments: run records and transient breadcrumbs
- Do not push, deploy, or open PRs from the dispatched agent unless the human explicitly asked for that run to do so.
