# Starscape Orbit

*Spin up an Orbit to track the motion of your project.*

**Orbit** by ***Starscape*** is a lightweight, kanban-style project management solution for human-agent collaboration.

Use it when you want the board to live with the code: one SQLite file, one small service, one human UI, and one agent-first API.

- Human UI for creating, editing, and moving tickets kanban-style.
- Agent API/MCP for claiming work, reading context, updating implementation notes, commenting, and writing project memory.

## 🛰️ Zero runtime dependencies

**Orbit installs with zero third-party runtime dependencies.** The server, CLI, and MCP layer use Node.js built-ins: `node:sqlite`, `node:http`, `node:crypto`, and friends.

The single dev-only dependency is [`esbuild`](https://esbuild.github.io/), used to bundle the web UI at build time. It never ships and is not needed to run the server, CLI, or MCP.

## Install and use Orbit

Install the CLI:

```bash
corepack enable
pnpm add -g @starlove/orbit

# or, from source:
git clone git@github.com:brucestarlove/ss-orbit.git
cd ss-orbit
pnpm install
pnpm run build:full
pnpm link --global
```

From the repo you want a board for:

```bash
cd path/to/your-app
orbit init            # creates .orbit/board.db + SKILL-ORBIT.md + AGENTS.md
orbit init --example  # optional: add onboarding example tickets
orbit init --no-ai    # optional: create or update the board with AI disabled
```

Start one runtime and keep using it:

```bash
orbit serve   # host runtime, uses ~/.orbit
# or
orbit docker  # Docker runtime, uses <repo>/.orbit/docker-data
```

Both serve `http://localhost:3337`. Use `--port 3400` to change ports and `--cwd path/to/repo` to bind a specific repo.

`orbit serve` and `orbit docker` run the same app but use different registries by default. A board registered in one mode will not appear in the other unless you share `DATA_DIR`, re-register it, or import a snapshot.

For multiple boards, run your chosen runtime once. In another terminal, `cd` into another repo and run `orbit init`; the board joins that runtime's board picker without a restart.

Docker options:

```bash
orbit docker                 # builds starscape-orbit:local, then serves http://localhost:3337
orbit docker --port 3400     # same container flow on a different port
orbit docker --no-build      # reuse an existing starscape-orbit:local image
```

`orbit docker` mounts the selected project into the container. Board data still lives in `.orbit/board.db`; Docker-only registry, exports, and backups live under `<repo>/.orbit/docker-data` by default.

Wipe a single board and start over with `orbit reset` (deletes `.orbit/`, `SKILL-ORBIT.md`, and the registry row), then `orbit init` again.

## Use with AI

Orbit ships with everything an agent needs to claim work, read tickets, and write back implementation notes. New boards have AI collaboration enabled by default; pass `orbit init --no-ai` or turn off **Enable AI** in Settings → AI if you want a human-only board.

1. **Confirm AI is enabled.** Open Settings (gear icon) → **AI** tab → toggle **Enable AI** if needed. Orbit provisions the `AI Ready`, `In Progress`, and `Review` lanes if they're missing, surfaces the agent-context fields, and reveals the MCP setup snippet.
2. **Fill in agent context.** Settings → AI → *Agent Instructions* is the project-level briefing every agent reads before touching a ticket. Describe what the project is, who it serves, the stack, and any rules of the road.
3. **Register the MCP server with your agent.** The AI tab generates copy-pasteable snippets for Claude Code, Cursor, Codex, OpenCode, OpenClaw, and other MCP-capable clients — pick your OS + client and paste the command into your agent's MCP config.
4. **Restart the agent.** On its next boot it discovers the Orbit MCP tools (`board_claim_next`, `board_get_ticket_context`, `board_update_ticket`, etc.).
5. **Point the agent at a ticket.** From inside the repo, ask the agent to read `SKILL-ORBIT.md` and then work on a ticket via the Orbit MCP — e.g., *"Use the Orbit MCP to claim the next AI-ready card and start work."* It pulls a focused context pack, claims the ticket, and updates the board as it goes.

If you initialized with `--example`, ticket #12 (`Try Orbit MCP on this ticket`) is a good first exercise once MCP is connected.

## Vocabulary

- **Board** — one repo's planning surface. Each board carries its own `agent_instructions`, lanes, tickets, and memory entries.
- **Lane** — a column. Lanes are user-defined and freely named/reordered. The default seed gives you `Backlog`, `Todo`, `AI Ready`, `In Progress`, `Review`, `Done`, `Cancelled`; `AI Ready`, `In Progress`, and `Review` are anchor lanes the agent flow keys off. `AI Ready` is inserted between `Todo` and `In Progress` when AI is enabled.
- **Ticket types**:
  - `epic` — index card for a multi-feature initiative. Owns child tickets via `parent_ticket_id`.
  - `feature` — a standalone capability or new behavior.
  - `task` — a smaller, scoped unit of work.
  - `bug` — defect, regression, or broken behavior.
- **Checkpoint** — mid-work human judgment: call `checkpoint` with your question. The ticket moves to `Review`; the `checkpoint` comment marks the blocking fork. Use `complete` when work is finished.
- **Two relationship models** — hierarchy (`parent_ticket_id`, set on the row, only epics own children) is separate from the relations table (`relates_to`, `blocks`, `blocked_by`). The server keeps them disjoint.
- **Blockers** — a per-card `blocked_by` row in the relations table is the single source of truth. If the row exists, the ticket is blocked. Rows are removed two ways: the user deletes the relation manually in the UI, **or** the *blocking* ticket lands in the **Done** lane and the server auto-deletes every relation row that named it as a blocker. (Epic targets expand to their open children — see `GET /api/tickets/:id/blockers`.)

## Requirements

- **Node.js 22+**. The server uses the built-in `node:sqlite` module (an experimental Node feature). On boot you'll see a Node experimental-feature warning — that's expected.
- **pnpm 10+ for development**. The repo pins pnpm through `packageManager`; use Corepack (`corepack enable`) to get the right version.

Bun is not used as the Orbit runtime because Orbit depends on Node's built-in `node:sqlite` module.

## How it works

Each repo gets its own board database. Orbit keeps a small central registry that maps repo paths to their board files; the CLI, web app, and MCP server use explicit project roots when provided, then fall back to walking upward to find `.orbit/board.db`.

- **Per-repo board** — `.orbit/board.db` lives in the repo it tracks. `orbit init` creates it, drops `SKILL-ORBIT.md` at the repo root, and creates/updates `AGENTS.md` with a terse pointer so agents load the full Orbit protocol only when relevant. Add `--example` to create onboarding cards, or `--no-ai` to disable AI collaboration for the board.
- **Central registry** — `registry.db` records each board's path, slug, and last-active timestamp. Host `orbit serve` uses `~/.orbit`; `orbit docker` uses `<repo>/.orbit/docker-data`. Keep one mode unless you intentionally share `DATA_DIR`, re-register boards, or import snapshots.
- **Project-root discovery** — `orbit serve`, `orbit mcp`, and MCP-attached agents resolve a board from an explicit `--cwd` / `PROJECT_ROOT` first, then fall back to walking up from process cwd to find `.orbit/board.db`. Persistent MCP configs should use an explicit root so the right board attaches even when the agent launches elsewhere.
- **Two channels for AI** — `AGENTS.md` is the auto-loaded briefing, with an Orbit-managed pointer to `SKILL-ORBIT.md`; the *MCP config* tells the agent runtime how to launch Orbit's MCP server for the right project. The briefing travels with the repo; the MCP registration is per-agent-install.
- **Snapshot-portable** — Settings → Repository → Export downloads a `.orbit.json` snapshot. Import on another install (or in the browser preview at [orbit.starscape.app/app](https://orbit.starscape.app/app)) to restore the same board.

## Developing Orbit

```bash
pnpm install
pnpm run dev
pnpm test
pnpm run build
```

Open `http://localhost:3337`.

If you want an AI agent to work this board, point it at [SKILL-ORBIT.md](SKILL-ORBIT.md). Agent-facing HTTP/MCP details live in [docs/AGENT_PROTOCOL.md](docs/AGENT_PROTOCOL.md).

**Two channels:** MCP config tells your AI app where `mcp-server.js` lives. `SKILL-ORBIT.md` is the repo-local briefing the agent reads before working.

## Typical Workflow

A normal day on a shared board:

1. **Human** creates an epic for a new initiative and fills in card description with the high-level breakdown.
2. **Human** or **Agent** breaks it into `feature` / `task` / `bug` cards under the epic and moves the workable ones to the `AI Ready` lane.
3. **Human** directs **Agent** to find a ticket by number or name, or tell it to call `claim-next` to get one from the `AI Ready` column, which gets context for the ticket and important project notes, and starts work. Blocked tickets are skipped automatically.
4. **Agent** either:
  - calls `complete` with a summary and PR link, moving the card to `Review`; or
  - calls `checkpoint` with a question if it is blocked mid-flight. Orbit moves the card to `Review` and records a checkpoint comment.
5. **Human** reviews, merges, and moves the card to the `Done` lane (or sends it back with comments).

## MCP

Orbit ships a stdio MCP server for agents that prefer tools over raw HTTP. You don't normally start it yourself; your agent runtime spawns it from the snippet in **Settings → AI**. To run it standalone:

```bash
orbit mcp
# equivalent: node src/mcp-server.js
```

MCP uses the same registry and board databases when launched with the same `DATA_DIR` and `--cwd` as the web runtime.

A copy-editable client config lives at [docs/mcp-client.example.json](docs/mcp-client.example.json). The web app also generates setup snippets from **Settings → AI**. More detail is in [docs/MCP_SETUP.md](docs/MCP_SETUP.md).

### MCP tools


| Purpose       | Tool                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Index         | `board_list` (tiny registry), `board_set_active`                                                                                                                                |
| Board context | `board_context` (settings + journal + deployment; optional board + `include_struck`)                                                                                            |
| Read          | `board_read_ticket`, `board_read_comments`, `board_get_ticket_context` (heavy), `board_get_ticket_relations`, `board_get_ticket_blockers`, `board_search`, `board_list_archive` |
| Agent flow    | `board_claim_next`, `board_checkpoint`, `board_complete`                                                                                                                        |
| Write         | `board_update_ticket`, `board_add_comment`, `board_add_board_entry`, `board_archive_ticket`, `board_restore_ticket`, `board_delete_ticket`                                      |
| Admin         | `board_export_board`, `board_update_settings`                                                                                                                                   |


## First-Run Seed

`orbit init` (or first server start in a repo without a board) creates a universal board seed in the new `.orbit/board.db`:

- **Board**: name from `BOARD_NAME` env var, otherwise inferred from `package.json` `name` or the repo folder name. Slug from `BOARD_SLUG` or derived from the name.
- **Repo metadata**: `REPO_URL` env var or `git config --get remote.origin.url`; `SYSTEM_PATH` env var or the repo path passed to `orbit init`.
- **Default branch**: `DEFAULT_BRANCH` env var, otherwise the current git branch.
- **Lanes (7)**: `Backlog`, `Todo` (default), `AI Ready`, `In Progress`, `Review`, `Done`, `Cancelled`. Pass `--no-ai` to seed without `AI Ready` and leave AI collaboration disabled.
- **Labels (7)**: `human-only`, `needs-human-input`, `needs-decomposition`, `needs-followup`, `tech-debt`, `security`, `onboarding`.
- **Onboarding cards (optional)**: pass `--example` to create an epic `#1` plus children `#2`, `#3`, and `#12 — Try Orbit MCP on this ticket`.
- **Free-form fields**: `project_notes` (Notes tab) and `agent_instructions` (AI tab) get placeholder text you should replace.

Set env vars before `orbit init` or first runtime start to skip the placeholders:

```powershell
$env:BOARD_NAME="My App"; $env:BOARD_SLUG="my-app"; $env:REPO_URL="https://github.com/you/my-app"; orbit init
```

```bash
BOARD_NAME="My App" BOARD_SLUG=my-app REPO_URL=https://github.com/you/my-app orbit init
```

## Troubleshooting

- **UI loads but lanes are blank** — usually a cached `app.js`. Hard-refresh the page (Ctrl+Shift+R) and check the browser console.
- **`node:sqlite` is not a known module** — you're on Node < 22. Upgrade to Node 22+.
- **Port 3337 already in use** — run `orbit serve --port 3340` or `orbit docker --port 3340`.

## Data

Orbit stores each board in the repo it belongs to:

- Board data: `.orbit/board.db`
- Host registry and backups: `~/.orbit` by default
- Docker registry and backups: `<repo>/.orbit/docker-data` by default

Override runtime data with:

```bash
DATA_DIR=/path/to/data orbit serve
orbit docker --data-dir /path/to/data
```

```powershell
$env:DATA_DIR="C:\path\to\data"; orbit serve
```

The UI exposes **Export** and **Import** from **Settings → Repository**.

**Export** downloads a portable `.orbit.json` file you can move to another computer or import later.

**Automatic backups** are separate from Export. Orbit quietly saves local backup copies after you make changes, waiting about two minutes after your last edit so it does not create a file for every click. Orbit also makes an immediate backup before risky actions like deleting a board, resetting Orbit, or replacing a board during import.

Backups are stored under the active runtime data dir's `backups/` folder. They are for local recovery; Export is still the easiest way to intentionally save or share a board.
