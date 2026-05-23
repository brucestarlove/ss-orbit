# MCP Setup

Use `mcp-client.example.json` in this folder as a copy-editable starting point for any MCP-capable client, including Cursor, Claude Desktop, Claude Code, Codex, OpenCode, and similar tools.

The easiest path is **Settings -> AI** in the web app:

1. Confirm or change the detected operating system.
2. Choose the AI app or agent harness.
3. Copy the generated setup snippet.
4. Paste it into that app's MCP settings or run the generated CLI command.

Orbit generates neutral template paths for Windows, macOS, and Linux. Replace those placeholders with the real path to **`src/mcp-server.js`** inside your Orbit checkout. That tells the AI client **how to spawn the MCP helper**; it does not ship markdown or project context—the agent reads files (like `SKILL-ORBIT.md`) from whichever repo/workspace you opened.

Board data lives under each tracked repo at `.orbit/board.db` (flat file or `.orbit/boards/<slug>/` for extra boards)—not beside the MCP script.

After installing Orbit as a package, run **`orbit init`** in (or with `--cwd` pointing at) the repo where you want `.orbit/`, **`AGENTS.md`**, and a copy of **`SKILL-ORBIT.md`** so agents and MCP line up with that tree. Orbit enables the AI Ready / In Progress / Review agent lanes by default. Add `--no-ai` if you want AI collaboration disabled, and add `--example` if you want the onboarding example tickets.

The generated format changes by app:

- Cursor, Claude Desktop, and generic MCP clients get `mcpServers` JSON.
- Claude Code gets a `claude mcp add ... -- node ...` command.
- Codex gets a `[mcp_servers.starscape-orbit]` TOML snippet.
- OpenCode gets an `opencode.json` snippet under `mcp`.

The checked-in example file is not read automatically by Starscape Orbit. It exists so a user can:

1. Open the example.
2. Copy the `minimal-agent-board` server block into their own MCP client config.
3. Replace the path to `src/mcp-server.js` with the absolute path on your machine.
4. Restart the MCP client.

By default MCP runs in local mode. It finds a board from an explicit project root first: pass `orbit mcp --cwd <repo>` or set `PROJECT_ROOT=<repo>` in persistent MCP configs. If neither is set, it falls back to the process cwd and walks upward to the first ancestor with `.orbit/board.db`. Prefer explicit roots for long-lived agent configs so launching the agent from another folder does not attach the wrong board.

For a shared/deployed board, run MCP in remote mode instead: set `ORBIT_MODE=remote`, `ORBIT_API_URL=<server origin>`, and usually `ORBIT_DEFAULT_BOARD=<slug-or-id>`. Remote mode calls the HTTP API and does not open or auto-create local `.orbit` databases; it fails at startup if `ORBIT_API_URL` is missing. **`AGENTS.md` / `SKILL-ORBIT.md`** are unrelated to MCP transport: agents open them via the workspace file tree, and `orbit init` keeps a terse Orbit pointer section in `AGENTS.md`.

Typical use:

- Keep the web UI running with `node src/server.js`.
- Point the MCP client at `node src/cli/orbit.js mcp --cwd /absolute/project`, set `PROJECT_ROOT=/absolute/project` with `node src/mcp-server.js`, or paste the generated setup from Settings -> AI.
- Use the MCP tools to claim tickets, read context, update implementation fields, and write project memory.

## System Impact

Running the MCP server starts a small local helper process. It reads and updates the same local board data as the web app, does not publish the board to the internet, and can be removed from your AI app's MCP settings whenever you want.

On Windows, that helper process can keep `.orbit/board.db` and its WAL/SHM sidecar files locked while the AI client is running. Before deleting or recloning a repo that has an Orbit board, close or restart the AI client, stop any `orbit serve` terminal, and prefer `orbit reset --cwd <repo>` for cleanup.

The MCP server is only the bridge. Your AI app is still the part that decides what to do, and that app may send ticket context to its AI provider when you ask it to work on cards. Only connect AI apps you trust with this project.

Important:

- Run the MCP helper and web server against the **same Orbit checkout and `DATA_DIR`** (default `~/.orbit`, override with `DATA_DIR=/path`) so they share one `registry.db` and agree on paths to `.orbit/board.db` files—but remember **`AGENTS.md` / `SKILL-ORBIT.md` are plain repo text**, not streamed over MCP.
- The generated setup assumes local/open mode. Protected deployments can still add MCP auth manually later.
