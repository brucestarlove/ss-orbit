// Project settings drawer (the cog/settings icon). Tabs: Lanes, Appearance,
// Card Archive, Notes, Journal, AI, Repository. Owns lane CRUD/reorder, the
// archive list, project context/notes form persistence, and per-tab handler wiring.

import { state, getSettingsTab, statesForProject, ticketsForProject, currentBoard } from "./state.js";
import { drawerInner, $ } from "./dom.js";
import { escapeHtml, formatDate, repoLabelFromUrl, renderPreservedText, cleanText } from "./format.js";
import { api, withBoardQuery } from "./api.js";
import { toast, downloadJson } from "./toast.js";
import { renderDrawerShell } from "./drawer.js";
import { navigate } from "./router.js";
import { renderBoard } from "./kanban.js";
import { renderDetailCard, startInlineEdit } from "./ticket-detail.js";
import { load } from "./app.js";
import { features } from "./config.js";
import {
  applyReducedMotionPreference,
  browserPrefersReducedMotion,
  effectiveReducedMotionPreference,
  setReducedMotionPreference,
  storedReducedMotionPreference
} from "./motion-preference.js";
import { currentTheme, setThemePreference } from "./theme-preference.js";

const repositoryDelete = {
  boardId: "",
  step: "idle",
  exported: false
};

export async function renderProjectDetail() {
  const context = await api(`/api/boards/${state.boardId}/context?include_struck=true`);
  const project = context.board;
  const activeTab = getSettingsTab();

  const tabs = [
    { id: "lanes", label: "Lanes" },
    { id: "appearance", label: "Appearance" },
    { id: "archive", label: "Card Archive" },
    { id: "notes", label: "Notes" },
    { id: "journal", label: "Journal" },
    ...(features.ai ? [{ id: "ai", label: "AI" }] : []),
    { id: "repository", label: "Repository" }
  ];

  const resolvedTab = activeTab === "ai" && !features.ai ? "lanes" : activeTab;

  renderDrawerShell({
    eyebrow: "SETTINGS",
    mode: "settings",
    title: project.name,
    tabs,
    activeTab: resolvedTab,
    onTabSelect: async (id) => {
      navigate({
        boardId: state.boardId,
        view: "settings",
        tab: id
      });
    },
    body: renderProjectTabBody(context, resolvedTab)
  });

  bindProjectTabHandlers(context, resolvedTab);
}

function renderProjectTabBody(context, tab) {
  switch (tab) {
    case "notes":
      return renderNotesSettingsTab(context);
    case "lanes":
      return renderProjectLanesTab();
    case "appearance":
      return renderProjectAppearanceTab();
    case "ai":
      return features.ai ? renderProjectAiTab(context) : renderProjectLanesTab();
    case "journal":
      return renderProjectJournalTab(context);
    case "archive":
      return renderProjectArchiveTab();
    case "repository":
    default:
      return renderProjectRepositoryTab(context);
  }
}

const MCP_OS_OPTIONS = {
  windows: {
    label: "Windows",
    shell: "PowerShell",
    serverPath: "C:\\Path\\To\\StarscapeOrbit\\src\\mcp-server.js"
  },
  macos: {
    label: "macOS",
    shell: "Terminal",
    serverPath: "/Users/you/apps/starscape-orbit/src/mcp-server.js"
  },
  linux: {
    label: "Linux",
    shell: "Terminal",
    serverPath: "/home/you/apps/starscape-orbit/src/mcp-server.js"
  }
};

const MCP_CLIENTS = {
  "claude-code": {
    label: "Claude Code",
    format: "CLI command",
    helper: "Run this command once. Claude Code records the local Orbit tool server for the project."
  },
  codex: {
    label: "Codex",
    format: "config.toml",
    helper: "Paste this TOML into Codex config. Project-local config may require the project to be trusted."
  },
  cursor: {
    label: "Cursor",
    format: "MCP JSON",
    helper: "Paste this JSON into Cursor MCP settings. Cursor starts Orbit when an agent needs the tools."
  },
  opencode: {
    label: "OpenCode",
    format: "opencode.json",
    helper: "Paste this into OpenCode config under the local MCP server list."
  },
  openclaw: {
    label: "OpenClaw",
    format: "MCP JSON",
    helper: "Paste this JSON into OpenClaw's MCP server list. OpenClaw will spawn Orbit on demand."
  },
  generic: {
    label: "Other MCP app",
    format: "MCP JSON",
    helper: "Most MCP clients accept this JSON shape for local stdio servers."
  }
};

function renderProjectAiTab(context) {
  const project = context.board;
  const aiEnabled = project.ai_enabled !== 0;
  const aiDivider = aiEnabled ? `<div class="ai-section-divider" aria-hidden="true"></div>` : "";
  const agentContextSetup = aiEnabled ? renderAgentContextSection(project) : "";
  const mcpSetup = aiEnabled ? renderMcpSetupSection(context) : "";

  return `
    <div class="section">
      <label class="orbit-check" for="aiEnabledToggle">
        <input
          type="checkbox"
          id="aiEnabledToggle"
          ${aiEnabled ? "checked" : ""}
        />
        <span class="orbit-check-box" aria-hidden="true">
          <svg viewBox="0 0 16 16" class="orbit-check-tick"><path d="M3.5 8.5l3 3 6-7" /></svg>
        </span>
        <span class="orbit-check-label">Enable AI</span>
      </label>
      <p class="description">Provisions the <strong>AI Ready</strong>, <strong>In Progress</strong>, and <strong>Review</strong> lanes if missing, surfaces agent context fields, and exposes the MCP setup snippet. Disabling AI hides the AI Ready column but keeps its cards in place.</p>
    </div>
    ${aiDivider}
    ${agentContextSetup}
    ${aiDivider}
    ${mcpSetup}
  `;
}

function renderAgentContextSection(project) {
  const ph =
    "This project is about…\n\nHow any AI agent should use this board and work in this repo.";
  return `
    <div class="section ai-subsection ai-context-setup">
      <div class="ai-context-title-row">
        <span class="ai-context-inline-mark" aria-hidden="true">Context</span>
        <h3>Agent Instructions</h3>
      </div>
      <p class="description">This project-level context is provided to agents when they work on tickets.</p>
      <form id="agentInstructionsForm" class="field-form">
        <textarea name="agent_instructions" placeholder="${escapeHtml(ph)}">${escapeHtml(project.agent_instructions || "")}</textarea>
        <button type="submit">Save</button>
      </form>
    </div>
  `;
}

function renderMcpSetupSection(context) {
  const osId = detectedMcpOs();
  const clientId = "claude-code";
  const paths = mcpDetectedPaths(context, osId);
  const configText = mcpConfigText(clientId, paths);
  const commandText = mcpRunCommand(osId, paths);
  const client = MCP_CLIENTS[clientId];
  return `
    <details class="section ai-subsection mcp-setup" data-mcp-setup>
      <summary>
        <div class="mcp-title-row">
          <span class="mcp-inline-mark" aria-hidden="true">MCP</span>
          <h3>Connect Your Agent to MCP</h3>
        </div>
      </summary>
      <div>
        <p class="description">A tiny service running on your computer alongside your AI agent, providing it with tools and context to collaborate with you more effectively. Tell your AI to use the snippet below, it knows what MCP is.</p>
        <div class="mcp-flow">
          <label>
            <span>Operating system</span>
            <select id="mcpOsSelect" class="select-chevron-field">
              ${Object.entries(MCP_OS_OPTIONS)
                .map(([id, option]) => `<option value="${id}" ${id === osId ? "selected" : ""}>${escapeHtml(option.label)}</option>`)
                .join("")}
            </select>
          </label>
          <label>
            <span>Agent app</span>
            <select id="mcpClientSelect" class="select-chevron-field">
              ${Object.entries(MCP_CLIENTS)
                .map(([id, option]) => `<option value="${id}" ${id === clientId ? "selected" : ""}>${escapeHtml(option.label)}</option>`)
                .join("")}
            </select>
          </label>
        </div>
        <div class="mcp-path-grid">
          <label>
            <span>Orbit MCP server file</span>
            <input id="mcpServerPathInput" value="${escapeHtml(paths.serverPath)}" />
          </label>
        </div>
      </div>

      <div class="mcp-options-stack">
        <div class="mcp-option-card">
          <div class="mcp-option-card-head">
            <div>
              <strong data-mcp-output-title>${escapeHtml(client.label)} setup</strong>
              <p class="description" data-mcp-helper>${escapeHtml(client.helper)}</p>
            </div>
            <button type="button" class="ghost" data-copy-mcp="config">Copy setup</button>
          </div>
          <div class="mcp-terminal">
            <div class="mcp-terminal-chrome" aria-hidden="true"><span></span><span></span><span></span></div>
            <pre class="mcp-snippet"><code data-mcp-config>${escapeHtml(configText)}</code></pre>
          </div>
        </div>

        <div class="mcp-or-divider" aria-hidden="true"><span>OR</span></div>

        <div class="mcp-option-card">
          <div class="mcp-option-card-head">
            <div>
              <strong>Manual run command</strong>
              <p class="description">Use this only when an app asks you to start the MCP server yourself.</p>
            </div>
            <button type="button" class="ghost" data-copy-mcp="command">Copy command</button>
          </div>
          <div class="mcp-terminal">
            <div class="mcp-terminal-chrome" aria-hidden="true"><span></span><span></span><span></span></div>
            <pre class="mcp-snippet mcp-snippet--compact"><code data-mcp-command>${escapeHtml(commandText)}</code></pre>
          </div>
        </div>
      </div>
    </details>
  `;
}

function detectedMcpOs() {
  const platform = String(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "").toLowerCase();
  if (platform.includes("win")) return "windows";
  if (platform.includes("mac")) return "macos";
  return "linux";
}

function mcpDefaultPaths(osId) {
  const option = MCP_OS_OPTIONS[osId] || MCP_OS_OPTIONS.linux;
  return {
    serverPath: option.serverPath
  };
}

function mcpDetectedPaths(context, osId) {
  const template = mcpDefaultPaths(osId);
  const deployment = context.deployment || {};
  return {
    serverPath: deployment.mcp_server_path || template.serverPath
  };
}

function mcpPathsFromForm() {
  return {
    serverPath: $("#mcpServerPathInput")?.value || ""
  };
}

function mcpConfigText(clientId, paths) {
  if (clientId === "claude-code") return claudeCodeMcpCommand(paths);
  if (clientId === "codex") return codexMcpToml(paths);
  if (clientId === "opencode") return opencodeMcpJson(paths);

  const config = {
    mcpServers: {
      "starscape-orbit": {
        command: "node",
        args: [paths.serverPath]
      }
    }
  };
  return JSON.stringify(config, null, 2);
}

function opencodeMcpJson(paths) {
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        "starscape-orbit": {
          type: "local",
          command: ["node", paths.serverPath],
          enabled: true
        }
      }
    },
    null,
    2
  );
}

function codexMcpToml(paths) {
  return `[mcp_servers.starscape-orbit]
command = "node"
args = ["${escapeToml(paths.serverPath)}"]
enabled = true`;
}

function claudeCodeMcpCommand(paths) {
  return ["claude mcp add starscape-orbit", "--", "node", shellQuote(paths.serverPath)].join(" ");
}

function mcpRunCommand(osId, paths) {
  return `node ${shellQuote(paths.serverPath)}`;
}

function shellQuote(value) {
  return `"${String(value || "").replace(/"/g, '\\"')}"`;
}

function escapeToml(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function renderProjectArchiveTab() {
  return `
    <p class="description">Archived cards are hidden from the kanban, search, and agent claim-next. Restore to put a card back on the board, or delete to permanently remove it.</p>
    <div class="section">
      <div id="archiveList" class="archive-list">Loading…</div>
    </div>
  `;
}

function renderProjectRepositoryTab(context) {
  const project = context.board;
  if (repositoryDelete.boardId !== project.id) {
    repositoryDelete.boardId = project.id;
    repositoryDelete.step = "idle";
    repositoryDelete.exported = false;
  }
  const repoMeta = features.multiBoard
    ? `
    <div class="detail-head project-manual-head">
      <div class="meta-grid">
        <div class="meta meta--repo-path">
          <span>Repo</span>
          <strong>${escapeHtml(repoLabelFromUrl(project.repo_url))}</strong>
          <span>Path</span>
          <strong>${escapeHtml(project.system_path || context.deployment?.system_path || "Not available")}</strong>
        </div>
      </div>
    </div>`
    : `
    <p class="description">This board lives in your browser only. Export a snapshot if you want to move it to a real Orbit install, or import one to seed this preview.</p>`;
  return `
    ${repoMeta}

    ${features.multiBoard ? renderBoardRenameSection(project) : ""}

    <div class="section">
      <h3>Board Snapshot</h3>
      ${features.attachments ? `
        <label class="orbit-check">
          <input type="checkbox" id="exportProjectImages" />
          <span class="orbit-check-box" aria-hidden="true">
            <svg viewBox="0 0 16 16" class="orbit-check-tick"><path d="M3.5 8.5l3 3 6-7" /></svg>
          </span>
          <span>Include attached images</span>
        </label>
        <p class="description">Image exports are embedded in the .orbit.json snapshot and may be much larger.</p>
      ` : ""}
      <div class="deployment-actions">
        <button type="button" class="ghost" id="exportProject">Export</button>
        <label class="import-button">
          <input type="file" id="importSnapshotFile" accept=".orbit.json,.json,application/json" />
          <span>Import</span>
        </label>
      </div>
    </div>

    ${features.multiBoard ? renderDeleteBoardSection(project) : ""}
  `;
}

function renderBoardRenameSection(project) {
  return `
    <div class="section board-rename-section">
      <h3>Board Name</h3>
      <p class="description">Rename the board display name only. The canonical URL slug stays <strong>${escapeHtml(project.slug || "")}</strong>, so existing board links keep working.</p>
      <form id="boardRenameForm" class="field-form">
        <label>
          <span>Display name</span>
          <input name="name" value="${escapeHtml(project.name || "")}" maxlength="120" required />
        </label>
        <button type="submit">Rename Board</button>
      </form>
    </div>
  `;
}

function renderDeleteBoardSection(project) {
  const slug = escapeHtml(project.slug || "");
  if (repositoryDelete.step === "choice") {
    return `
      <div class="section repository-danger-zone">
        <h3>Delete Board</h3>
        <p class="description">Delete this board from Orbit and remove its repo-local Orbit files. Export a snapshot first if you may need this board again.</p>
        <div class="repository-delete-actions">
          <button type="button" class="ghost" id="deleteBoardExportFirst">Export first</button>
          <button type="button" class="ghost danger-button" id="deleteBoardSkipExport">Delete without exporting</button>
          <button type="button" class="ghost" id="deleteBoardCancel">Cancel</button>
        </div>
      </div>
    `;
  }

  if (repositoryDelete.step === "confirm") {
    const exportedCopy = repositoryDelete.exported
      ? "Snapshot exported. Type the board slug to confirm permanent deletion."
      : "Type the board slug to confirm permanent deletion.";
    return `
      <div class="section repository-danger-zone is-confirming">
        <h3>Delete Board</h3>
        <p class="description">${escapeHtml(exportedCopy)}</p>
        <label class="repository-confirm-field">
          <span>Board slug</span>
          <strong>${slug}</strong>
          <input id="deleteBoardConfirmInput" autocomplete="off" spellcheck="false" placeholder="${slug}" autofocus />
        </label>
        <div class="repository-delete-actions">
          <button type="button" class="danger-button" id="deleteBoardConfirm" disabled>Delete board permanently</button>
          <button type="button" class="ghost" id="deleteBoardCancel">Cancel</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="section repository-danger-zone">
      <h3>Delete Board</h3>
      <p class="description">Remove this board from Orbit and delete its repo-local Orbit files. This cannot be undone without an exported snapshot.</p>
      <button type="button" class="ghost danger-button" id="deleteBoardStart">Delete Board</button>
    </div>
  `;
}

function renderNotesSettingsTab(context) {
  const project = context.board;
  const notesPlaceholder =
    "Remember to mention SKILL-ORBIT.md to my AI agents if they get confused";
  const notes = project.project_notes || "";
  const hasNotes = Boolean(notes.trim());
  const placeholderClass = hasNotes ? "" : "is-placeholder";
  const inner = hasNotes ? renderPreservedText(notes) : escapeHtml(notesPlaceholder);
  return `
    <div class="section ai-fields">
      <div class="inline-md-field">
        <span class="inline-md-field-label">Notes For You</span>
        <div
          class="inline-md-field-body preserved-text-body editable-field settings-notes-body ${placeholderClass}"
          data-edit-field="project_notes"
          tabindex="0"
          title="Click to edit"
          role="button"
          aria-label="Edit Notes For You"
        >${inner}</div>
      </div>
    </div>
  `;
}

function renderProjectLanesTab() {
  const showPriority = state.showPriority;
  return `
    <div class="section">
      <label class="orbit-check" for="showPriorityToggle">
        <input
          type="checkbox"
          id="showPriorityToggle"
          ${showPriority ? "checked" : ""}
        />
        <span class="orbit-check-box" aria-hidden="true">
          <svg viewBox="0 0 16 16" class="orbit-check-tick"><path d="M3.5 8.5l3 3 6-7" /></svg>
        </span>
        <span class="orbit-check-label">Show priority label on cards</span>
      </label>
      <p class="description lanes-description">Rename, reorder, add, or remove lanes.</p>
      ${renderLaneManager()}
      <form id="laneCreateForm" class="lane-create-form">
        <input name="name" placeholder="New lane name..." required />
        <button type="submit">Add Lane</button>
      </form>
    </div>
  `;
}

function renderProjectAppearanceTab() {
  const theme = currentTheme();
  const reduceMotion = effectiveReducedMotionPreference();
  const storedMotion = storedReducedMotionPreference();
  const browserDefault = browserPrefersReducedMotion();
  const sourceLabel = storedMotion === null
    ? `Using browser default (${browserDefault ? "reduced motion" : "motion allowed"}).`
    : "Using your saved preference.";

  return `
    <div class="section appearance-theme-section">
      <fieldset class="appearance-theme-field">
        <legend>Theme</legend>
        <div class="appearance-theme-options">
          ${renderThemeOption("light", "Light", theme)}
          ${renderThemeOption("dark", "Dark", theme)}
        </div>
        <p class="description">Applies the light/dark theme used by the top rail toggle.</p>
      </fieldset>
    </div>
    <div class="section">
      <label class="orbit-check" for="reduceMotionToggle">
        <input
          type="checkbox"
          id="reduceMotionToggle"
          ${reduceMotion ? "checked" : ""}
        />
        <span class="orbit-check-box" aria-hidden="true">
          <svg viewBox="0 0 16 16" class="orbit-check-tick"><path d="M3.5 8.5l3 3 6-7" /></svg>
        </span>
        <span class="orbit-check-label">Reduce theme motion</span>
      </label>
      <p class="description">Turns off the animated starfield, meteors, and theme animations. ${escapeHtml(sourceLabel)}</p>
    </div>
  `;
}

function renderThemeOption(value, label, selectedTheme) {
  const checked = selectedTheme === value ? "checked" : "";
  const icon = value === "dark"
    ? '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />'
    : '<circle cx="12" cy="12" r="5" /><path d="M12 1v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8l1.4 1.4M1 12h2m18 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />';

  return `
    <label class="appearance-theme-option">
      <input type="radio" name="themePreference" value="${value}" ${checked} />
      <span class="appearance-theme-option-mark" aria-hidden="true">
        <svg
          class="appearance-theme-option-icon"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >${icon}</svg>
      </span>
      <span class="appearance-theme-option-label">${label}</span>
    </label>
  `;
}

function renderProjectJournalTab(context) {
  const aiEnabled = context.board?.ai_enabled !== 0;
  return `
    ${aiEnabled ? `<p class="description">Agent-facing project memory: decisions to follow and lessons to apply. Struck entries stay visible here but are excluded from agent context.</p>` : ""}
    <div class="section">
      ${renderProjectEntries(context.entries)}
      <form id="projectEntryForm" class="comment-form project-entry-form">
        <select name="type" class="select-chevron-field" aria-label="Entry type">
          <option value="decision">Decision</option>
          <option value="lesson">Lesson</option>
        </select>
        <input name="title" placeholder="Entry title..." required />
        <textarea name="body" placeholder="Decision rationale or lesson: do X instead of Y when working with Z." required></textarea>
        <button type="submit">Add Entry</button>
      </form>
    </div>
  `;
}

function bindProjectTabHandlers(context, tab) {
  const project = context.board;

  if (tab === "repository") {
    const exportSnapshot = async (includeAttachments = Boolean($("#exportProjectImages")?.checked)) => {
      const suffix = includeAttachments ? "?include_attachments=true" : "";
      const snapshot = await api(`/api/boards/${encodeURIComponent(project.id)}/export${suffix}`);
      const filename = includeAttachments ? `${project.slug}.with-images.orbit.json` : `${project.slug}.orbit.json`;
      downloadJson(filename, snapshot);
    };

    $("#exportProject")?.addEventListener("click", async () => {
      await exportSnapshot();
    });

    $("#boardRenameForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const nextName = String(form.get("name") || "").trim();
      if (!nextName || nextName === project.name) return;
      await api(`/api/boards/${encodeURIComponent(project.id)}`, {
        method: "PATCH",
        body: { name: nextName }
      });
      await load();
      state.detailMode = "settings";
      toast.success(`Renamed board to ${nextName}. Canonical slug unchanged: ${project.slug}`);
    });

    $("#importSnapshotFile")?.addEventListener("change", async (event) => {
      const file = event.currentTarget.files?.[0];
      if (!file) return;
      const text = await file.text();
      const snapshot = JSON.parse(text);
      await api("/api/admin/import", {
        method: "POST",
        body: { snapshot, replace_existing: true, board_id: project.id }
      });
      await load();
      state.detailMode = "settings";
      toast.success("Board imported");
      event.currentTarget.value = "";
    });

    $("#deleteBoardStart")?.addEventListener("click", async () => {
      repositoryDelete.step = "choice";
      repositoryDelete.exported = false;
      await renderProjectDetail();
    });

    $("#deleteBoardExportFirst")?.addEventListener("click", async () => {
      await exportSnapshot();
      repositoryDelete.step = "confirm";
      repositoryDelete.exported = true;
      await renderProjectDetail();
    });

    $("#deleteBoardSkipExport")?.addEventListener("click", async () => {
      repositoryDelete.step = "confirm";
      repositoryDelete.exported = false;
      await renderProjectDetail();
    });

    $("#deleteBoardCancel")?.addEventListener("click", async () => {
      repositoryDelete.step = "idle";
      repositoryDelete.exported = false;
      await renderProjectDetail();
    });

    const confirmInput = $("#deleteBoardConfirmInput");
    const confirmButton = $("#deleteBoardConfirm");
    confirmInput?.addEventListener("input", () => {
      if (confirmButton) confirmButton.disabled = confirmInput.value.trim() !== project.slug;
    });
    confirmButton?.addEventListener("click", async () => {
      await api(`/api/boards/${encodeURIComponent(project.id)}`, {
        method: "DELETE",
        body: { confirm_slug: project.slug, delete_files: true }
      });
      repositoryDelete.step = "idle";
      repositoryDelete.exported = false;
      await load();
      toast.success(`Deleted board: ${project.name}`);
      navigate({ boardId: state.boardId, view: "board" }, { replace: true });
    });
  }

  if (tab === "notes") {
    const notesEl = drawerInner.querySelector('[data-edit-field="project_notes"]');
    if (notesEl) {
      const edit = () =>
        startInlineEdit(notesEl, {
          fieldName: "project_notes",
          multiline: true,
          initialValue: project.project_notes || "",
          ariaLabel: "Edit Notes For You",
          rerender: async () => {
            state.detailMode = "settings";
            await renderProjectDetail();
          },
          commit: async (next) => {
            await api(`/api/boards/${project.id}`, {
              method: "PATCH",
              body: { project_notes: cleanText(next) }
            });
            await load();
            state.detailMode = "settings";
            toast.success("Saved");
          }
        });
      notesEl.addEventListener("click", (event) => {
        event.preventDefault();
        edit();
      });
      notesEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          edit();
        }
      });
    }
  }

  if (tab === "lanes") {
    drawerInner.querySelectorAll("[data-lane-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        await handleLaneAction(button);
      });
    });

    drawerInner.querySelectorAll(".lane-row input, .lane-row select").forEach((field) => {
      field.addEventListener("change", async () => {
        await updateLane(field.closest(".lane-row"));
      });
    });

    $("#laneCreateForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      await api(`/api/boards/${project.id}/states`, {
        method: "POST",
        body: Object.fromEntries(form.entries())
      });
      await load();
      state.detailMode = "settings";
      toast.success("Lane added");
    });

    $("#showPriorityToggle")?.addEventListener("change", (event) => {
      state.showPriority = !!event.currentTarget.checked;
      localStorage.setItem("mab_show_priority", state.showPriority ? "true" : "false");
      renderBoard();
    });
  }

  if (tab === "appearance") {
    drawerInner.querySelectorAll("input[name='themePreference']").forEach((input) => {
      input.addEventListener("change", (event) => {
        if (!event.currentTarget.checked) return;
        const theme = setThemePreference(event.currentTarget.value);
        toast.success(theme === "dark" ? "Dark theme enabled" : "Light theme enabled");
      });
    });

    $("#reduceMotionToggle")?.addEventListener("change", (event) => {
      const reduce = !!event.currentTarget.checked;
      setReducedMotionPreference(reduce);
      applyReducedMotionPreference();
      window.dispatchEvent(new CustomEvent("orbit:motion-preference-change", { detail: { reduce } }));
      toast.success(reduce ? "Theme motion reduced" : "Theme motion enabled");
    });
  }

  if (tab === "ai") {
    const updateMcpPreview = () => {
      const osId = $("#mcpOsSelect")?.value || detectedMcpOs();
      const clientId = $("#mcpClientSelect")?.value || "claude-code";
      const client = MCP_CLIENTS[clientId] || MCP_CLIENTS.generic;
      const paths = mcpPathsFromForm();
      const configText = mcpConfigText(clientId, paths);
      const commandText = mcpRunCommand(osId, paths);

      const osNote = drawerInner.querySelector("[data-mcp-os-note]");
      if (osNote) osNote.textContent = `Detected: ${MCP_OS_OPTIONS[detectedMcpOs()]?.label || "Linux"}`;

      const format = drawerInner.querySelector("[data-mcp-client-format]");
      if (format) format.textContent = client.format;

      const title = drawerInner.querySelector("[data-mcp-output-title]");
      if (title) title.textContent = `${client.label} setup`;

      const helper = drawerInner.querySelector("[data-mcp-helper]");
      if (helper) helper.textContent = client.helper;

      const configEl = drawerInner.querySelector("[data-mcp-config]");
      if (configEl) configEl.textContent = configText;

      const commandEl = drawerInner.querySelector("[data-mcp-command]");
      if (commandEl) commandEl.textContent = commandText;
    };

    $("#mcpOsSelect")?.addEventListener("change", () => updateMcpPreview());
    $("#mcpClientSelect")?.addEventListener("change", () => updateMcpPreview());
    ["#mcpServerPathInput"].forEach((selector) => {
      $(selector)?.addEventListener("input", () => updateMcpPreview());
    });

    drawerInner.querySelectorAll("[data-copy-mcp]").forEach((button) => {
      button.addEventListener("click", async () => {
        const osId = $("#mcpOsSelect")?.value || detectedMcpOs();
        const clientId = $("#mcpClientSelect")?.value || "claude-code";
        const paths = mcpPathsFromForm();
        const value = button.dataset.copyMcp === "command" ? mcpRunCommand(osId, paths) : mcpConfigText(clientId, paths);
        await copyText(value);
        toast.success(button.dataset.copyMcp === "command" ? "MCP command copied" : "MCP config copied");
      });
    });

    $("#agentInstructionsForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      await api(`/api/boards/${project.id}`, {
        method: "PATCH",
        body: Object.fromEntries(form.entries())
      });
      await load();
      state.detailMode = "settings";
      toast.success("Saved");
    });

    $("#aiEnabledToggle")?.addEventListener("change", async (event) => {
      const enabled = !!event.currentTarget.checked;
      await api(`/api/boards/${project.id}`, {
        method: "PATCH",
        body: { ai_enabled: enabled }
      });
      await load();
      state.detailMode = "settings";
      toast.success(enabled ? "AI features enabled — agent lanes provisioned" : "AI features disabled — AI Ready hidden");
    });

  }

  if (tab === "archive") {
    const listEl = $("#archiveList");
    if (listEl) {
      const refresh = async () => {
        try {
          const result = await api(`/api/boards/${encodeURIComponent(project.id)}/archive`);
          const tickets = result.tickets || [];
          if (tickets.length === 0) {
            listEl.innerHTML = `<p class="description">No archived cards yet. Click the trash icon in the card detail header to archive a card.</p>`;
            return;
          }
          listEl.innerHTML = `<div class="detail-card-grid">${tickets
            .map((t) => renderDetailCard(t, { archive: { id: t.id }, disableOpen: true }))
            .join("")}</div>`;
        } catch (err) {
          listEl.innerHTML = `<p class="description">Could not load archive: ${escapeHtml(err?.message || "unknown error")}</p>`;
        }
      };

      refresh();

      listEl.addEventListener("click", async (event) => {
        const restoreBtn = event.target.closest("[data-archive-restore]");
        const deleteBtn = event.target.closest("[data-archive-delete]");
        if (!restoreBtn && !deleteBtn) return;
        event.stopPropagation();
        const card = (restoreBtn || deleteBtn).closest("article");
        const cardTitle = card?.querySelector("h3")?.textContent || "card";
        if (restoreBtn) {
          const id = restoreBtn.dataset.archiveRestore;
          await api(withBoardQuery(`/api/tickets/${encodeURIComponent(id)}/restore`), { method: "POST" });
          toast.success(`Restored: ${cardTitle}`);
          await load();
          await refresh();
          return;
        }
        if (deleteBtn) {
          const id = deleteBtn.dataset.archiveDelete;
          if (!confirm(`Permanently delete "${cardTitle}"? This cannot be undone.`)) return;
          await api(withBoardQuery(`/api/tickets/${encodeURIComponent(id)}`), { method: "DELETE" });
          toast.success(`Deleted: ${cardTitle}`);
          await refresh();
        }
      });
    }
  }

  if (tab === "journal") {
    drawerInner.querySelectorAll("[data-entry-action='toggle-struck']").forEach((button) => {
      button.addEventListener("click", async () => {
        await api(withBoardQuery(`/api/board-entries/${button.dataset.entryId}`), {
          method: "PATCH",
          body: { struck: button.dataset.struck !== "true" }
        });
        await load();
        state.detailMode = "settings";
        toast.info(button.dataset.struck === "true" ? "Project entry restored" : "Project entry struck");
      });
    });

    $("#projectEntryForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      await api(`/api/boards/${project.id}/entries`, {
        method: "POST",
        body: Object.fromEntries(form.entries())
      });
      await load();
      state.detailMode = "settings";
      toast.success("Project entry added");
    });
  }
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.append(textArea);
  textArea.select();
  document.execCommand("copy");
  textArea.remove();
}

function renderProjectEntries(entries = []) {
  if (!entries.length) return `<p class="description">No project entries yet.</p>`;
  return entries
    .map(
      (entry) => {
        const isStruck = Boolean(entry.struck_at);
        return `
        <div class="comment project-entry ${escapeHtml(entry.type)} ${isStruck ? "is-struck" : ""}">
          <div class="comment-meta">
            <div>
              <strong>${escapeHtml(entry.type.toUpperCase())}: ${escapeHtml(entry.title)}</strong>
              ${isStruck ? `<span class="project-entry-status">Excluded from agent context</span>` : ""}
            </div>
            <div class="project-entry-actions">
              <span>${escapeHtml(entry.created_by)} - ${formatDate(entry.created_at)}</span>
              <button
                type="button"
                class="ghost project-entry-strike"
                data-entry-action="toggle-struck"
                data-entry-id="${escapeHtml(entry.id)}"
                data-struck="${isStruck ? "true" : "false"}"
                aria-pressed="${isStruck ? "true" : "false"}"
              >${isStruck ? "Restore" : "Strike"}</button>
            </div>
          </div>
          <div class="comment-body">${escapeHtml(entry.body)}</div>
        </div>
      `;
      }
    )
    .join("");
}

// In Progress and Review are core kanban lanes — undeletable regardless of
// AI. AI Ready is only locked while AI is enabled; disabling AI hides it from
// the board without moving its cards.
const CORE_LANE_ROLES = new Set(["in_progress", "review"]);

/** A lane can't be deleted if it has cards (orphan risk), if it's the default
 *  "new cards land here" lane (every project must keep exactly one), if it's
 *  a core kanban lane (in_progress / review), or if it's the AI Ready lane
 *  while AI is enabled. */
function deleteDisabled(lane, counts, aiEnabled) {
  if (counts.get(lane.id)) return true;
  if (lane.is_default) return true;
  if (CORE_LANE_ROLES.has(lane.role)) return true;
  if (aiEnabled && lane.role === "ai_ready") return true;
  return false;
}

function deleteTitle(lane, counts, aiEnabled) {
  const count = counts.get(lane.id) || 0;
  if (count > 0) {
    return `Cannot delete — ${count} card${count === 1 ? "" : "s"} in this lane`;
  }
  if (lane.is_default) {
    return "Cannot delete — default lane for new cards (move it first)";
  }
  if (CORE_LANE_ROLES.has(lane.role)) {
    return "Cannot delete — core kanban lane";
  }
  if (aiEnabled && lane.role === "ai_ready") {
    return "Cannot delete — required by agent flow while AI is enabled";
  }
  return "Delete lane";
}

function renderLaneManager() {
  const lanes = statesForProject();
  const aiEnabled = currentBoard()?.ai_enabled !== 0;
  const counts = new Map();
  for (const ticket of ticketsForProject()) {
    counts.set(ticket.state_id, (counts.get(ticket.state_id) || 0) + 1);
  }

  return `
    <div class="lane-list">
      ${lanes
        .map((lane, index) => {
          const isAiReady = lane.role === "ai_ready";
          const nameTitle = isAiReady
            ? "AI Ready lane name is locked — disable AI to hide this column"
            : "";
          return `
            <div class="lane-row${isAiReady ? " lane-row--locked" : ""}" data-lane-id="${lane.id}">
              <button type="button" class="lane-icon-btn" data-lane-action="up" ${index === 0 ? "disabled" : ""} title="Move lane left" aria-label="Move lane left">↑</button>
              <button type="button" class="lane-icon-btn" data-lane-action="down" ${index === lanes.length - 1 ? "disabled" : ""} title="Move lane right" aria-label="Move lane right">↓</button>
              <input name="name" value="${escapeHtml(lane.name)}" aria-label="Lane name" ${isAiReady ? `readonly title="${escapeHtml(nameTitle)}"` : ""} />
              <button type="button" class="lane-new-toggle ${lane.is_default ? "is-on" : ""}" data-lane-action="toggle-default" aria-pressed="${lane.is_default ? "true" : "false"}" title="${lane.is_default ? "Default lane for new cards — click another lane to move it" : "Make this the default lane for new cards"}" aria-label="Default lane for new cards">
                <span class="lane-new-sun" aria-hidden="true"></span>
                <span class="lane-new-label">New</span>
              </button>
              <button type="button" class="lane-delete-btn" data-lane-action="delete" ${deleteDisabled(lane, counts, aiEnabled) ? "disabled" : ""} title="${deleteTitle(lane, counts, aiEnabled)}" aria-label="Delete lane">×</button>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

async function handleLaneAction(button) {
  const row = button.closest(".lane-row");
  const laneId = row.dataset.laneId;
  const action = button.dataset.laneAction;
  if (action === "delete") {
    await api(withBoardQuery(`/api/states/${laneId}`), { method: "DELETE" });
    await load();
    state.detailMode = "settings";
    toast.success("Lane deleted");
    return;
  }

  if (action === "toggle-default") {
    // Radio-style: one lane is always the default. Clicking the current
    // default is a no-op — to move it you click a different lane. This
    // guarantees new-card creation always has somewhere to land.
    const wasOn = button.getAttribute("aria-pressed") === "true";
    if (wasOn) return;
    drawerInner.querySelectorAll('[data-lane-action="toggle-default"]').forEach((btn) => {
      btn.setAttribute("aria-pressed", "false");
      btn.classList.remove("is-on");
    });
    button.setAttribute("aria-pressed", "true");
    button.classList.add("is-on");
    await updateLane(row, { silent: true });
    toast.success("Default lane updated");
    return;
  }

  const lanes = statesForProject().map((lane) => lane.id);
  const index = lanes.indexOf(laneId);
  const swapWith = action === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= lanes.length) return;
  [lanes[index], lanes[swapWith]] = [lanes[swapWith], lanes[index]];
  await api(`/api/boards/${state.boardId}/states`, {
    method: "PATCH",
    body: { state_ids: lanes }
  });
  await load();
  state.detailMode = "settings";
  toast.success("Lanes reordered");
}

async function updateLane(row, { silent = false } = {}) {
  const name = row.querySelector('input[name="name"]').value;
  const toggle = row.querySelector('[data-lane-action="toggle-default"]');
  const isDefault = toggle?.getAttribute("aria-pressed") === "true";

  await api(withBoardQuery(`/api/states/${row.dataset.laneId}`), {
    method: "PATCH",
    body: {
      name,
      is_default: isDefault
    }
  });
  await load();
  state.detailMode = "settings";
  if (!silent) toast.success("Lane updated");
}
