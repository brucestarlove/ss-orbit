// MCP server. One process = one session = (usually) one board, but the
// per-process board lives in a closure variable that every tool reads
// explicitly — never via a hidden global. Each tool builds its own ctx for
// the call it's about to make, so adding new tools never has to think about
// "active board" state.

import { createOrbitClient } from "./mcp/orbit-client.js";

const SERVER_INFO = {
  name: "minimal-agent-board",
  version: "0.1.0"
};

const orbitClient = await createOrbitClient();

const TOOL_DEFS = [
  {
    name: "board_context",
    description:
      "Board context pack: name, agent_instructions, journal entries (board_entries), deployment paths. Resolves board from board_id / board_slug / board, else the MCP session board. Set include_struck true to include struck journal rows (default false). Same payload as GET /api/boards/:id/context.",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" },
        include_struck: { type: "boolean", description: "When true, journal entries include struck items." }
      },
      additionalProperties: false
    },
    handler: (args) => orbitClient.boardContext(args)
  },
  {
    name: "board_list",
    description:
      "Tiny registry index: id, slug, name, repo_path per board. Does not open board databases or load tickets. Pair with board_set_active and board_context / ticket tools; the web UI loads full rows via GET /api/bootstrap.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    handler: () => orbitClient.boardList()
  },
  {
    name: "board_set_active",
    description:
      "Switch the MCP session to another board by slug (updates last_active_at for multi-board repos). Subsequent tools use that board until switched again.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" }
      },
      required: ["slug"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.boardSetActive(args)
  },
  {
    name: "board_claim_next",
    description:
      "Claim the next schedulable AI-ready ticket on the session's active board. Pass `board` (slug) only to explicitly switch to another board you mean to work on; omitted `board` never scans other boards.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string" },
        board_slug: { type: "string" },
        board_id: { type: "string" },
        type: { type: "string" },
        include_epics: { type: "boolean" }
      },
      additionalProperties: false
    },
    handler: (args) => orbitClient.claimNext(args)
  },
  {
    name: "board_get_ticket_context",
    description:
      "Read the full context pack for a ticket, including board agent_instructions (project-level agent context), relations, blockers, comments, and child cards. Heavy — prefer board_read_ticket when you only need title/description/comments.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        depth: { type: "integer", minimum: 1, maximum: 3 }
      },
      required: ["ticket_id"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.getTicketContext(args)
  },
  {
    name: "board_read_ticket",
    description:
      "Look up a ticket by ticket_id, number, or exact title (case-insensitive) on the session's active board, and return its title, description, labels, state, and full comment thread plus the board manual (agent_instructions + journal + deployment paths).",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        number: { type: "integer" },
        title: { type: "string" }
      },
      additionalProperties: false
    },
    handler: (args) => orbitClient.readTicket(args)
  },
  {
    name: "board_read_comments",
    description:
      "Return every comment on a ticket (oldest → newest). Look up by ticket_id, number, or exact title (case-insensitive) on the session's active board. Comment kinds include human_comment, agent_note, checkpoint, completion, note.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        number: { type: "integer" },
        title: { type: "string" }
      },
      additionalProperties: false
    },
    handler: (args) => orbitClient.readComments(args)
  },
  {
    name: "board_get_ticket_relations",
    description: "List every link touching a ticket. Each entry has `type`, `direction`, `other_ticket`, and `source`. `source='relation'` rows come from the relations table (`relates_to` / `blocks` / `blocked_by`) and are the SSOT for peer dependencies — write via `POST /api/relations`, delete via `DELETE /api/relations/:id`. `source='hierarchy'` rows are read-only synthetic entries surfacing epic ownership (`child_of` toward the parent epic, `parent_of` toward each child); they have `id: null` and are mutated by patching the ticket's `parent_ticket_id`, not by calling the relations endpoints.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" }
      },
      required: ["ticket_id"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.getTicketRelations(args)
  },
  {
    name: "board_get_ticket_blockers",
    description: "Return unresolved blockers for a ticket and a can_start boolean. The single source of truth for dependencies is the per-card `blocked_by` row in the relations table; if a row exists the blocker is unresolved. Rows are removed two ways: (1) automatically when the blocking ticket moves into the Done lane (state role='done'), or (2) manually by the user in the UI. A ticket with can_start=false must not be worked on until its blockers resolve. Epic blocker targets expand to that epic's open children (children in any lane whose role is not 'done', not archived); each expanded entry carries via_epic_id.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" }
      },
      required: ["ticket_id"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.getTicketBlockers(args)
  },
  {
    name: "board_search",
    description:
      "Search tickets, comments, and implementation records by text on the session's active board. Pass `board` (slug) only to explicitly search another board; omitted `board` never merges results from other boards.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        board: { type: "string" },
        board_slug: { type: "string" },
        board_id: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 }
      },
      required: ["q"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.search(args)
  },
  {
    name: "board_create_ticket",
    description:
      "Create a new Orbit ticket/card on the active board. Use this instead of editing .orbit/board.db directly. Same operation as POST /api/tickets.",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        board_slug: { type: "string" },
        board: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        type: { type: "string", enum: ["epic", "feature", "task", "bug"] },
        parent_ticket_id: { type: ["string", "null"] },
        ai_plan: { type: "string" },
        implementation_summary: { type: "string" },
        implementation_updates: { type: "string" },
        state_id: { type: "string" },
        priority: { type: "integer" },
        labels: { type: "array", items: { type: "string" } }
      },
      required: ["title"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.createTicket(args)
  },
  {
    name: "board_update_ticket",
    description:
      "Update ticket fields such as AI plan, implementation summary, implementation updates, state, type, priority, or labels (full replace: array of label names).",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        type: { type: "string" },
        parent_ticket_id: { type: ["string", "null"] },
        ai_plan: { type: "string" },
        implementation_summary: { type: "string" },
        implementation_updates: { type: "string" },
        state_id: { type: "string" },
        priority: { type: "integer" },
        labels: { type: "array", items: { type: "string" }, description: "Replaces all ticket labels when provided." }
      },
      required: ["ticket_id"],
      additionalProperties: false
    },
    handler: ({ ticket_id, ...patch }) => orbitClient.updateTicket({ ticket_id, ...patch })
  },
  {
    name: "board_add_comment",
    description: "Add a ticket comment or agent breadcrumb.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        body: { type: "string" },
        kind: { type: "string" }
      },
      required: ["ticket_id", "body"],
      additionalProperties: false
    },
    handler: ({ ticket_id, ...body }) => orbitClient.addComment({ ticket_id, ...body })
  },
  {
    name: "board_add_board_entry",
    description: "Add a durable board-level decision or lesson for future agents.",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        board_slug: { type: "string" },
        type: { type: "string", enum: ["decision", "lesson"] },
        title: { type: "string" },
        body: { type: "string" },
        ticket_id: { type: "string" }
      },
      required: ["type", "title"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.addBoardEntry(args)
  },
  {
    name: "board_checkpoint",
    description:
      "Pause mid-flight for a human: moves the ticket to Review (same lane as board_complete; checkpoint distinguishes a blocking question) and posts a checkpoint-kind comment with your message. Use when you cannot proceed without the user—not for normal 'work is done' handoff (use board_complete).",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        message: { type: "string" }
      },
      required: ["ticket_id", "message"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.checkpoint(args)
  },
  {
    name: "board_complete",
    description:
      "Hand off finished work for human review: moves the ticket to the Review lane (by role or name), writes a completion comment (summary, optional PR URL), and optional implementation_updates. This is the usual 'ready for you to look' path; use board_checkpoint only when blocked mid-flight.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        summary: { type: "string" },
        updates: { type: "string" },
        pr_url: { type: "string" },
        next_state: { type: "string" }
      },
      required: ["ticket_id", "summary"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.complete(args)
  },
  {
    name: "board_archive_ticket",
    description:
      "Archive (soft-delete) a ticket. The ticket is moved off the board into the Archive: it is excluded from bootstrap, search, claim-next, blockers, and relations, but its data and comments are preserved. Reverse with board_restore_ticket; permanently remove with board_delete_ticket.",
    inputSchema: {
      type: "object",
      properties: { ticket_id: { type: "string" } },
      required: ["ticket_id"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.archiveTicket(args)
  },
  {
    name: "board_restore_ticket",
    description: "Restore an archived ticket back to the board in its previous lane (state).",
    inputSchema: {
      type: "object",
      properties: { ticket_id: { type: "string" } },
      required: ["ticket_id"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.restoreTicket(args)
  },
  {
    name: "board_delete_ticket",
    description:
      "Permanently delete a ticket. The ticket MUST already be archived (call board_archive_ticket first) — otherwise this returns 409 ticket_not_archived. This cannot be undone: comments, labels, and relations are removed via cascade. Events for this ticket are kept but their ticket_id becomes NULL.",
    inputSchema: {
      type: "object",
      properties: { ticket_id: { type: "string" } },
      required: ["ticket_id"],
      additionalProperties: false
    },
    handler: (args) => orbitClient.deleteTicket(args)
  },
  {
    name: "board_list_archive",
    description: "List archived tickets for a board, ordered by archive time (most recent first). Identify the board with board_id or board_slug.",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        board_slug: { type: "string" }
      },
      additionalProperties: false
    },
    handler: (args) => orbitClient.listArchive(args)
  },
  {
    name: "board_export_board",
    description: "Export a board snapshot as JSON for backup or transfer.",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        board_slug: { type: "string" }
      },
      additionalProperties: false
    },
    handler: (args) => orbitClient.exportBoard(args)
  },
  {
    name: "board_update_settings",
    description:
      "PATCH-equivalent for board settings: name, repo_url, system_path, default_branch, agent_instructions (project-level agent context), and project_notes (Notes For You). Same fields as PATCH /api/boards/:id.",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        board_slug: { type: "string" },
        name: { type: "string" },
        repo_url: { type: "string" },
        system_path: { type: "string" },
        default_branch: { type: "string" },
        project_notes: { type: "string" },
        agent_instructions: { type: "string" }
      },
      additionalProperties: false
    },
    handler: (args) => orbitClient.updateSettings(args)
  }
];

const tools = new Map(TOOL_DEFS.map((tool) => [tool.name, tool]));

let inputBuffer = Buffer.alloc(0);
let expectedBodyLength = -1;

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  drainInput();
});

process.stdin.on("end", () => process.exit(0));
process.stdin.resume();

function drainInput() {
  while (true) {
    if (expectedBodyLength >= 0) {
      if (inputBuffer.byteLength < expectedBodyLength) return;
      const body = inputBuffer.slice(0, expectedBodyLength);
      inputBuffer = inputBuffer.slice(expectedBodyLength);
      expectedBodyLength = -1;
      handleMessage(body.toString("utf8"), "content-length");
      continue;
    }

    const preview = inputBuffer.slice(0, Math.min(inputBuffer.byteLength, 32)).toString("utf8").toLowerCase();
    if (preview.startsWith("content-length:")) {
      const headerEnd = inputBuffer.indexOf(Buffer.from("\r\n\r\n"));
      if (headerEnd === -1) return;

      const headerText = inputBuffer.slice(0, headerEnd).toString("utf8");
      inputBuffer = inputBuffer.slice(headerEnd + 4);
      const headers = parseHeaders(headerText);
      expectedBodyLength = Number(headers["content-length"] || -1);
      if (!Number.isFinite(expectedBodyLength) || expectedBodyLength < 0) {
        writeMessage(errorResponse(null, -32700, "Missing Content-Length header."), "content-length");
        expectedBodyLength = -1;
      }
      continue;
    }

    const lineEnd = inputBuffer.indexOf(Buffer.from("\n"));
    if (lineEnd === -1) return;
    const line = inputBuffer.slice(0, lineEnd).toString("utf8").replace(/\r$/, "");
    inputBuffer = inputBuffer.slice(lineEnd + 1);
    if (!line.trim()) continue;
    handleMessage(line, "line");
  }
}

function parseHeaders(text) {
  const headers = {};
  for (const line of text.split("\r\n")) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers[key] = value;
  }
  return headers;
}

async function handleMessage(body, transport = "content-length") {
  let message;
  try {
    message = JSON.parse(body);
  } catch {
    writeMessage(errorResponse(null, -32700, "Invalid JSON."), transport);
    return;
  }

  if (!message || typeof message !== "object") {
    writeMessage(errorResponse(null, -32600, "Invalid request."), transport);
    return;
  }

  if (!("id" in message)) {
    if (message.method === "notifications/initialized") return;
    return;
  }

  try {
    const result = await dispatch(message);
    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result
    }, transport);
  } catch (error) {
    writeMessage(errorResponse(message.id, error.code || -32000, error.message || "Internal error."), transport);
  }
}

async function dispatch(message) {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: message.params?.protocolVersion || "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: SERVER_INFO
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: TOOL_DEFS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema
        }))
      };
    case "tools/call":
      return callTool(message.params || {});
    default:
      throw rpcError(-32601, `Method not found: ${message.method}`);
  }
}

async function callTool(params) {
  const name = params.name;
  const args = params.arguments || {};
  const tool = tools.get(name);
  if (!tool) throw rpcError(-32601, `Unknown tool: ${name}`);

  let result;
  try {
    result = await tool.handler(args);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: error.message || "Tool call failed."
        }
      ],
      isError: true
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ]
  };
}

function writeMessage(message, transport = "content-length") {
  const json = JSON.stringify(message);
  if (transport === "line") {
    process.stdout.write(`${json}\n`);
    return;
  }
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
}

function errorResponse(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  };
}

function rpcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

process.on("uncaughtException", (error) => {
  writeMessage(errorResponse(null, -32000, error.message || "Uncaught exception."));
});

process.on("unhandledRejection", (error) => {
  writeMessage(errorResponse(null, -32000, error?.message || "Unhandled rejection."));
});

if (process.env.MAB_MCP_STDERR_LOG === "1") {
  console.error(`Starscape Orbit MCP ready. Mode: ${orbitClient.mode}. Target: ${typeof orbitClient.sessionLabel === "function" ? orbitClient.sessionLabel() : orbitClient.sessionLabel}`);
}
