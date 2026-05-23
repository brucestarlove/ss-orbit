# Orbit Dispatch

`orbit dispatch` is the first-class Orbit-to-Hermes handoff command. It turns an Orbit ticket into a bounded agent run without relying on a temporary prompt file as the source of truth.

The design intent is simple:

- Git remains canonical for code.
- Orbit remains canonical for planning, handoff, run records, and implementation notes.
- The ticket becomes the shared communication surface between the human, orchestrator, and the dispatched agent.

## Basic use

From the code repository you are working in, target the Orbit board explicitly. For hosted boards, pass the board/server URL so the handoff points back to the right cockpit:

```bash
orbit dispatch \
  --board ss-starlog \
  --ticket 4 \
  --profile agent \
  --worktree \
  --server-url http://localhost:3337
```

Common variants:

```bash
# Prepare the handoff, card updates, run record, branch, and worktree without starting Hermes.
orbit dispatch --board ss-starlog --ticket 4 --profile agent --worktree --no-spawn

# Attach the Hermes child process to the current terminal instead of detaching it.
orbit dispatch --board ss-starlog --ticket 4 --profile agent --worktree --foreground

# Use an explicit branch/worktree name.
orbit dispatch --board ss-starlog --ticket 4 --profile agent --worktree \
  --branch orbit/ss-starlog-4-search \
  --worktree-path .worktrees/ss-starlog-4-search
```

## What dispatch does

1. Resolves the board from `--board` or from `--cwd` / the current repo.
2. Resolves the ticket from `--ticket` by number or id.
3. Refuses archived or blocked tickets unless `--force` is passed.
4. Builds a run id such as `orbit-4-agent-abc123def0`.
5. Creates `.orbit/dispatch-runs/<run-id>/` for run metadata and policy wrappers.
6. Creates and preserves a git worktree/branch when `--worktree` is used.
7. Generates a full agent handoff and writes the canonical copy to the ticket's **AI Written-Plan** (`ai_plan`) field.
8. Moves the ticket to **In Progress**.
9. Starts Hermes unless `--no-spawn` is passed.
10. Comments a run record back onto the ticket.

The run record includes profile, policy, ticket, branch, worktree, policy-bin path, child process id, and command. This makes the card the visible cockpit for the run.

## The AI Written-Plan handoff

Dispatch stores the generated handoff in the ticket's AI Written-Plan field. It includes:

- mission and ticket metadata
- repository root, worktree, branch, run id, and optional Orbit server URL
- required reading order: `AGENTS.md`, `SKILL-ORBIT.md`, then the handoff
- ticket description
- board-level agent instructions and notes
- board journal lessons/decisions
- parent/child ticket context
- unresolved blockers
- recent comments
- scope boundaries
- autonomous policy
- completion protocol

The short prompt passed to `hermes chat -q` is intentionally small. The ticket is the source of truth; the CLI argument is only a bootstrap pointer.

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
orbit dispatch --ticket 12 --profile agent --worktree --no-spawn
```

If your board is served elsewhere, pass `--server-url` so the generated handoff contains the cockpit URL.

For support, bug reports, and reproducibility notes, human users can print the installed CLI version with either form:

```bash
orbit -v
orbit --version
```

## Operator notes for orchestrators

- Prefer `orbit dispatch` over writing a temporary handoff prompt file.
- Use `--no-spawn` when you want to inspect the generated handoff before starting the agent.
- Use `--worktree` for code edits so the human can test before cleanup.
- Treat the ticket fields as durable surfaces:
  - AI Written-Plan: generated handoff
  - AI Implementation Summary: final summary of completed work
  - Implementation Updates/Lessons: pitfalls, remediation, future-agent guidance
  - Comments: run records and transient breadcrumbs
- Do not push, deploy, or open PRs from the dispatched agent unless the human explicitly asked for that run to do so.
