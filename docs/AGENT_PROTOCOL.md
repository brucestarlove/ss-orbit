# Agent Protocol

The board is intentionally agent-first. Agents should not scrape the UI. They should call the API and ask for narrow context packs.

If an MCP client is available, use the MCP server instead of rebuilding these HTTP calls yourself. The MCP tools map directly to the same core operations.

Never edit `.orbit/board.db` directly to create or mutate cards. The SQLite file is Orbit's storage detail; use the HTTP API or MCP tools so validation, events, search indexing, backups, and cross-process locking all run.

## Core Flow

1. `POST /api/agent/claim-next`
2. Implement using the returned context pack.
3. Add progress comments with `POST /api/tickets/:id/comments`.
4. If blocked by human judgment, call `POST /api/agent/checkpoint`.
5. When ready for review, call `POST /api/agent/complete`.

### End-to-end example

```http
POST /api/agent/claim-next
Content-Type: application/json

{ "board": "your-board-slug" }
```

The response includes the claimed `ticket` and a `context` pack. After working the ticket:

```http
POST /api/tickets/abc123/comments
Content-Type: application/json

{ "body": "Wired the new endpoint and added a smoke test.", "kind": "agent_note" }
```

```http
POST /api/agent/complete
Content-Type: application/json

{
  "ticket_id": "abc123",
  "summary": "Implemented the new endpoint with input validation and tests.",
  "updates": "Hit a flaky test on Windows; pinned timeouts to 5s.",
  "pr_url": "https://github.com/you/repo/pull/42"
}
```

## Endpoints

### List boards (thin)

```http
GET /api/boards
```

Returns `{ "boards": [ ... ] }` with registry metadata only (`id`, `slug`, `name`, `repo_path`, `repo_url`, `default_branch`, `db_path`, `last_active_at`). Does not load tickets or lanes. MCP equivalent: `board_list`.

For the web UI’s full default-board snapshot (tickets, states, labels, entries), the SPA calls `GET /api/bootstrap`. Agents over MCP should use `board_list`, `board_set_active`, `board_context`, and ticket-scoped tools instead—there is no MCP mirror of bootstrap.

### Claim Next

```http
POST /api/agent/claim-next
Content-Type: application/json

{
  "board": "your-board-slug",
  "type": "feature"
}
```

Returns the first schedulable `AI Ready` ticket. The scheduler skips tickets blocked by unresolved `blocked_by` relations.

By default, `claim-next` skips `epic` cards because they are index/planning cards. To claim an epic for planning, pass `"type": "epic"` or `"include_epics": true`.

The response shape is `{ claimed: true, ticket_id, context }` where `context` is the lightweight `board_read_ticket` pack (`ticket` with title/description/labels/state and the `board_manual`). Ticket comments are not included in the default claim context; call `GET /api/tickets/:id/comments` (or MCP `board_read_comments`) when an explicit chat/comment surface needs them. For the heavier ticket pack with relations, blockers, implementation fields, and child cards, call `GET /api/tickets/:id/context` (or MCP `board_get_ticket_context`).

### Read Lightweight Ticket

```http
GET /api/tickets/:id
GET /api/tickets/lookup?board=your-board-slug&number=42
GET /api/tickets/lookup?board=your-board-slug&title=Exact%20Title
```

MCP equivalent: `board_read_ticket`.

Returns the lightweight agent read shape: `ticket` with identity, title, description, labels, state/type/priority, plus `board_manual`. Ticket comments, relations, blockers, child cards, and implementation fields are intentionally omitted. Use this for quick orientation and claim context. The `lookup` form is exact by per-board ticket number or exact title; it does not use fuzzy search or comment/implementation indexes.

### Get Context Pack

```http
GET /api/tickets/:id/context?depth=1
```

Returns:

- Ticket, board, state, labels.
- The board manual (`board_manual`), including `agent_instructions` and `project_notes`.
- Dedicated implementation fields: `ai_plan`, `implementation_summary`, and `implementation_updates`.
- Parent epic/story ticket when present.
- Child feature cards when the ticket is an epic/story.
- Related tickets.
- Blockers and blocking tickets.

Ticket comments are intentionally omitted from this default agent context. Explicit comment/chat consumers should call:

```http
GET /api/tickets/:id/comments
```

MCP equivalent: `board_read_comments`.

### Get Ticket Relations

```http
GET /api/tickets/:id/relations
```

Returns every link touching the ticket. Each entry has `type`, `direction` (`outgoing` / `incoming`), `source`, and a compact `other_ticket` summary.

- `source: "relation"` — peer rows from the relations table (`relates_to` / `blocks` / `blocked_by`). These have a real `id` and are mutated via `POST /api/relations` and `DELETE /api/relations/:id`.
- `source: "hierarchy"` — read-only synthetic entries surfacing epic ownership: `child_of` pointing at the parent epic, `parent_of` pointing at each child. `id` is `null`. Mutate via `PATCH /api/tickets/:id` setting `parent_ticket_id`; the relations endpoints reject `child_of` / `parent_of` writes (`hierarchy_uses_parent_ticket_id`).

### Get Ticket Blockers

```http
GET /api/tickets/:id/blockers
```

Returns:

```json
{
  "ticket_id": "...",
  "can_start": false,
  "blockers": [
    { "id": "...", "number": 12, "title": "...", "state_name": "In Progress", "state_role": "in_progress" }
  ]
}
```

**Source of truth.** Blocker dependencies are defined exclusively by per-card `blocked_by` (and the inverse `blocks`) rows in the relations table — see `POST /api/tickets/:id/relations`. If a row exists, the blocker is unresolved. Rows are removed two ways: a user deletes the relation manually in the UI, or the *blocking* ticket moves into the Done lane (state role `done`) and the server auto-deletes every relation that named it as a blocker. `can_start` is `false` whenever any `blocked_by` row remains. Agents must not move a `can_start: false` ticket into a started state. The `claim-next` scheduler enforces this automatically.

**Epic expansion.** When a `blocked_by` target is an epic, the epic itself is not treated as a blocker — its open children are. A child counts as "open" while it sits in any lane whose role is not `done` (and isn't archived). Each expanded blocker carries `via_epic_id` pointing at the epic that brought it into the list, so reports can explain the dependency.

### Create / Delete Relation

```http
POST /api/relations
Content-Type: application/json

{
  "source_ticket_id": "...",
  "target_ticket_id": "...",
  "type": "blocked_by"
}
```

```http
DELETE /api/relations/:id
```

Rejected with HTTP 400 if the pair already has a `parent_ticket_id` link in either direction (`relation_redundant_with_parent`) or if source equals target (`relation_self`). Use `parent_ticket_id` for epic ↔ direct-child ownership; use relations only for cross-cutting links.

### Search

```http
GET /api/search?q=auth%20middleware&board=your-board-slug
```

Searches ticket titles, descriptions, and comments.

### Board context (settings + journal)

```http
GET /api/boards/:board_id/context?include_struck=false
```

Returns the same shape as MCP `board_context`: a trimmed `board` (`name`, `agent_instructions`, `updated_at`), `entries` (journal / decisions / lessons), and `deployment` paths. Use `include_struck=true` to include struck journal rows (default off).

MCP: `board_context` with optional `board_id` / `board_slug` / `board` and optional `include_struck`.

### Update Board

```http
PATCH /api/boards/:board_id
Content-Type: application/json

{
  "name": "...",
  "repo_url": "https://github.com/you/repo",
  "system_path": "C:/path/to/repo",
  "default_branch": "main",
  "project_notes": "Personal reminders (optional).",
  "agent_instructions": "Why this repo exists, capabilities, stack, constraints, and how agents should operate..."
}
```

Each board carries a `repo_url` and `system_path` (both optional). They surface in Settings → Repository and travel with the board through export/import.

### Add Board Memory Entry

```http
POST /api/boards/:board_id/entries
Content-Type: application/json

{
  "type": "decision",
  "title": "Use journal entries as agent-facing project memory",
  "body": "Record Decisions for UX and architecture choices agents should follow. Record Lessons for mistakes or discoveries distilled as 'do X instead of Y when working with Z.'"
}
```

Allowed entry types:

- `decision`: UX or architecture choices agents should follow instead of defaulting to generic codegen.
- `lesson`: mistakes or discoveries distilled as "do X instead of Y when working with Z."

Entries with `struck_at` set are retained for human review but omitted from board manual/context responses unless the REST client explicitly requests `include_struck=true`.

### Strike Or Restore Board Memory Entry

```http
PATCH /api/board-entries/:entry_id
Content-Type: application/json

{
  "struck": true
}
```

### Export Board Snapshot

```http
GET /api/boards/:board_id/export
```

Returns a JSON snapshot of the board, states, tickets, comments, relations, board entries, and relevant event history.

### Import Board Snapshot

```http
POST /api/admin/import
Content-Type: application/json

{
  "snapshot": { "...": "export payload" },
  "replace_existing": true
}
```

Replaces the current board with a previously exported snapshot. Export first if you want a rollback point.

### Add Comment

```http
POST /api/tickets/:id/comments
Content-Type: application/json

{
  "body": "Implementation note...",
  "kind": "agent_note"
}
```

Comments are for discussion and event breadcrumbs. Use the dedicated fields below for durable implementation records.

### Update AI Plan / Implementation Fields

```http
PATCH /api/tickets/:id
Content-Type: application/json

{
  "ai_plan": "The current plan...",
  "implementation_summary": "What shipped...",
  "implementation_updates": "Progress notes, mistakes to avoid, discoveries..."
}
```

Field intent:

- `ai_plan`: The current plan. For epics, this should describe the high-level vision and feature breakdown. For feature/task/bug cards, this should describe the concrete implementation approach.
- `implementation_summary`: The final concise summary of what changed, usually written when the card moves to review or done.
- `implementation_updates`: Chronological notes, mistakes, discoveries, and "avoid this next time" material. Later this can feed a separate insights system.

### Archive, Restore, and Delete

Removing a card is a two-step contract: archive first (soft-delete), then optionally permanently delete. Restore reverses an archive.

```http
POST /api/tickets/:id/archive
```

Soft-deletes the ticket: sets `archived_at` to the current time and bumps `updated_at`. Archived tickets are filtered out of `GET /api/bootstrap`, `GET /api/search`, `POST /api/agent/claim-next`, `GET /api/tickets/:id/blockers`, `GET /api/tickets/:id/relations`, and child-of-epic listings. Their data, comments, labels, and relations are preserved. Idempotent — archiving an already-archived ticket is a no-op.

```http
POST /api/tickets/:id/restore
```

Clears `archived_at`. The ticket reappears on the kanban in its previous lane (the `state_id` is preserved across archive/restore).

```http
DELETE /api/tickets/:id
```

Permanently removes the ticket. Returns `409 ticket_not_archived` if the ticket is not currently archived. Cascades delete all comments, ticket-label rows, and relations. Events for the ticket are kept but their `ticket_id` is set to `NULL`. Response: `{ "ok": true, "deleted_id": "..." }`.

```http
GET /api/boards/:board_id/archive
```

Returns `{ "tickets": [...] }` — all archived tickets for the board, ordered by `archived_at` descending (most recent first). Each ticket carries the same fields as `bootstrap.tickets`.

Over MCP these are exposed as `board_archive_ticket`, `board_restore_ticket`, `board_delete_ticket`, and `board_list_archive`. Always archive when intent is "remove"; only delete when intent is "delete forever and you have already confirmed."

### Create Epic With Feature Cards

Ticket types are `epic`, `feature`, `task`, and `bug`.

MCP equivalent: `board_create_ticket`. Use it for new cards instead of modifying `.orbit/board.db`.

Create the epic/story parent first:

```http
POST /api/tickets
Content-Type: application/json

{
  "board_id": "board-id",
  "type": "epic",
  "title": "Build offline-first sync",
  "description": "High-level vision and outcome.",
  "ai_plan": "Feature 1: schema. Feature 2: queue. Feature 3: conflict UI.",
  "labels": ["ai-eligible"]
}
```

Then create feature cards with `parent_ticket_id`:

```http
POST /api/tickets
Content-Type: application/json

{
  "board_id": "board-id",
  "type": "feature",
  "parent_ticket_id": "epic-ticket-id",
  "title": "Feature 1: sync schema",
  "ai_plan": "Implement the local operation log and migration.",
  "labels": ["ai-eligible"]
}
```

### Checkpoint

```http
POST /api/agent/checkpoint
Content-Type: application/json

{
  "ticket_id": "ticket-id",
  "message": "CHECKPOINT: Option A vs B..."
}
```

Moves the ticket to `Review` (same lane as `/api/agent/complete`) and adds a **`checkpoint`** comment with `message`—use it for mid-flight forks; use `complete` when work is done.

### Complete

```http
POST /api/agent/complete
Content-Type: application/json

{
  "ticket_id": "ticket-id",
  "summary": "Implemented the requested change. Tests pass.",
  "updates": "Important implementation notes and lessons.",
  "pr_url": "https://github.com/you/repo/pull/123"
}
```

Moves the ticket to `Review` by default and writes `summary` into `implementation_summary`. If `updates` is present, it is appended to `implementation_updates`.

## Ticket Writing Contract

Agents perform best when tickets include:

- Clear requirements.
- Acceptance criteria.
- Relations for dependencies, especially `blocked_by`. Use `parent_ticket_id` for epic ownership, not relations.
- Pointers to previous related tickets or comments.

## Two Relationship Models

The board separates structural ownership from cross-cutting links. Treat these as non-overlapping:

- **Hierarchy (`parent_ticket_id`)** — set on the ticket row. Only epics can own children; non-epics carry the parent id. Detach by `PATCH`-ing `parent_ticket_id: null`. The dispatcher and context pack walk this link to surface parent / child cards.
- **Relations table** — typed links between any two tickets with `relates_to`, `blocks`, or `blocked_by`. The server rejects relation rows that mirror a `parent_ticket_id` link or point a ticket at itself, so the two models stay disjoint.

A ticket is workable only when its `can_start` is `true` (no unresolved `blocked_by`). Use `GET /api/tickets/:id/blockers` for a status check, or read the context pack which already embeds blockers and relations.
