// Project settings drawer (the cog/settings icon). Tabs: Lanes, Appearance,
// Card Archive, Notes, Journal, AI, Repository. Owns lane CRUD/reorder, the
// archive list, project context/notes form persistence, and per-tab handler wiring.

import { state, getSettingsTab, statesForProject, ticketsForProject, currentBoard } from "./state.js";
import { drawerInner, $ } from "./dom.js";
import { escapeHtml, formatDate, renderPreservedText, cleanText } from "./format.js";
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
import { currentTheme, toggleThemePreference } from "./theme-preference.js";
import {
  FONT_OPTIONS,
  FONT_TARGETS,
  SITE_FONT_OPTIONS,
  USER_SCALE_MIN,
  USER_SCALE_MAX,
  USER_SCALE_STEP,
  storedFontPreferences,
  setSiteFont,
  setUserScale,
  setFontPreference
} from "./font-preference.js";
import { closeIconSvg } from "./icons.js";
import { exportAllBoards } from "./board-export.js";
import { getUpdateInfo, fetchVersionInfo, syncUpdateBadge } from "./update-check.js";

const repositoryDelete = {
  boardId: "",
  step: "idle",
  exported: false
};

/** @starlove/ui slider: WebKit fill reads --value (0–100), set from min/max/value. */
function syncSliderValue(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const value = Number(input.value);
  const span = max - min;
  const pct = span <= 0 ? 0 : ((value - min) / span) * 100;
  input.style.setProperty("--value", String(pct));
}

function bindSliders(root) {
  root.querySelectorAll('input[type="range"].slider').forEach((slider) => {
    syncSliderValue(slider);
    slider.addEventListener("input", () => syncSliderValue(slider));
  });
}

export async function renderProjectDetail() {
  const context = await api(`/api/boards/${state.boardId}/context?include_struck=true`);
  const bootstrapBoard = currentBoard();
  const project = {
    ...context.board,
    // `/api/boards/:id/context` is agent-safe and intentionally omits
    // human-only project notes. The Settings UI gets those notes from the
    // human bootstrap payload instead, so Notes can reload without turning
    // board_context/MCP into a notes surface.
    ...(bootstrapBoard?.id === context.board?.id ? { project_notes: bootstrapBoard.project_notes || "" } : {})
  };
  context.board = project;
  const activeTab = getSettingsTab();

  const tabs = [
    { id: "lanes", label: "Lanes" },
    { id: "appearance", label: "Appearance" },
    { id: "archive", label: "Card Archive" },
    { id: "notes", label: "Notes" },
    { id: "journal", label: "Journal" },
    ...(features.ai ? [{ id: "ai", label: "AI" }] : []),
    { id: "data", label: "Data" }
  ];

  const resolvedTab = activeTab === "ai" && !features.ai ? "lanes" : activeTab;

  renderDrawerShell({
    eyebrow: "SETTINGS",
    mode: "settings",
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
    case "data":
    default:
      return renderProjectDataTab(context);
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
  vscode: {
    label: "VS Code",
    format: "mcp.json",
    helper: "Paste this JSON into VS Code's user or workspace MCP configuration."
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
  const agentContextSetup = aiEnabled ? renderAgentContextSection(project) : "";
  const helperFilesSetup = aiEnabled && features.multiBoard ? renderHelperFilesSection(project) : "";
  const mcpSetup = aiEnabled ? renderMcpSetupSection(context) : "";

  return `
    <div class="settings-stack">
      <section class="settings-card">
        <header class="settings-card-head">
          <h3 class="settings-card-title">AI</h3>
        </header>
        <div class="settings-card-body">
          <label class="orbit-check settings-toggle" for="aiEnabledToggle">
            <input
              type="checkbox"
              id="aiEnabledToggle"
              ${aiEnabled ? "checked" : ""}
            />
            <span class="orbit-check-box" aria-hidden="true">
              <svg viewBox="0 0 16 16" class="orbit-check-tick"><path d="M3.5 8.5l3 3 6-7" /></svg>
            </span>
            <span class="settings-toggle-text">
              <span class="settings-row-title">Enable AI</span>
              <span class="description">Provisions the <strong>AI Ready</strong>, <strong>In Progress</strong>, and <strong>Review</strong> lanes if missing, surfaces agent context fields, and exposes the MCP setup snippet. Disabling AI hides the AI Ready column but keeps its cards in place.</span>
            </span>
          </label>
        </div>
      </section>
      ${agentContextSetup}
      ${helperFilesSetup}
      ${mcpSetup}
    </div>
  `;
}

function renderAgentContextSection(project) {
  const instructionsPlaceholder =
    "This project is about…\n\nHow any AI agent should use this board and work in this repo.";
  const instructions = project.agent_instructions || "";
  const hasInstructions = Boolean(instructions.trim());
  const placeholderClass = hasInstructions ? "" : "is-placeholder";
  const inner = hasInstructions ? renderPreservedText(instructions) : escapeHtml(instructionsPlaceholder);
  return `
    <section class="settings-card ai-context-setup">
      <header class="settings-card-head">
        <h3 class="settings-card-title">Agent Instructions</h3>
      </header>
      <div class="settings-card-body">
        <div class="settings-row">
          <p class="description">This project-level context is provided to agents when they work on tickets.</p>
          <div class="inline-md-field">
            <div
              class="inline-md-field-body preserved-text-body editable-field settings-agent-instructions-body ${placeholderClass}"
              data-edit-field="agent_instructions"
              tabindex="0"
              title="Click to edit"
              role="button"
              aria-label="Edit Agent Instructions"
            >${inner}</div>
          </div>
        </div>
      </div>
    </section>
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
    <details class="settings-card settings-card--collapsible mcp-setup" data-mcp-setup>
      <summary class="settings-card-head">
        <h3 class="settings-card-title">Connect Your Agent to MCP</h3>
        <svg class="settings-card-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </summary>
      <div class="settings-card-body">
        <div class="settings-row">
          <p class="description">A tiny service running on your computer alongside your AI agent, providing it with tools and context to collaborate with you more effectively. Tell your AI to use the snippet below, it knows what MCP is.</p>
          <div class="control-grid">
            <label class="control-field">
              <span class="control-field-label">Operating system</span>
              <select id="mcpOsSelect" class="select-chevron-field">
                ${Object.entries(MCP_OS_OPTIONS)
                  .map(([id, option]) => `<option value="${id}" ${id === osId ? "selected" : ""}>${escapeHtml(option.label)}</option>`)
                  .join("")}
              </select>
            </label>
            <label class="control-field">
              <span class="control-field-label">Agent app</span>
              <select id="mcpClientSelect" class="select-chevron-field">
                ${Object.entries(MCP_CLIENTS)
                  .map(([id, option]) => `<option value="${id}" ${id === clientId ? "selected" : ""}>${escapeHtml(option.label)}</option>`)
                  .join("")}
              </select>
            </label>
          </div>
          <div class="control-grid control-grid--single mcp-path-grid">
            <label class="control-field">
              <span class="control-field-label">Orbit MCP server file</span>
              <input id="mcpServerPathInput" value="${escapeHtml(paths.serverPath)}" />
            </label>
          </div>
        </div>

        <div class="settings-row">
          <div class="mcp-options-stack">
            <div class="mcp-option-card">
              <div class="mcp-option-card-head">
                <div>
                  <strong data-mcp-output-title>${escapeHtml(client.label)} setup</strong>
                  <p class="description" data-mcp-helper>${escapeHtml(client.helper)}</p>
                </div>
                <button type="button" data-variant="secondary" data-copy-mcp="config">Copy setup</button>
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
                <button type="button" data-variant="secondary" data-copy-mcp="command">Copy command</button>
              </div>
              <div class="mcp-terminal">
                <div class="mcp-terminal-chrome" aria-hidden="true"><span></span><span></span><span></span></div>
                <pre class="mcp-snippet mcp-snippet--compact"><code data-mcp-command>${escapeHtml(commandText)}</code></pre>
              </div>
            </div>
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
  if (clientId === "vscode") return vscodeMcpJson(paths);

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

function vscodeMcpJson(paths) {
  return JSON.stringify(
    {
      servers: {
        starscapeOrbit: {
          type: "stdio",
          command: "node",
          args: [paths.serverPath]
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

function renderProjectDataTab(context) {
  const project = context.board;
  if (repositoryDelete.boardId !== project.id) {
    repositoryDelete.boardId = project.id;
    repositoryDelete.step = "idle";
    repositoryDelete.exported = false;
  }
  const repoMeta = features.multiBoard
    ? ""
    : `
    <section class="settings-card">
      <header class="settings-card-head">
        <h3 class="settings-card-title">Data</h3>
      </header>
      <div class="settings-card-body">
        <div class="settings-row">
          <p class="description">This board lives in your browser only. Export a snapshot if you want to move it to a real Orbit install, or import one to seed this preview.</p>
        </div>
      </div>
    </section>`;
  return `
    <div class="settings-stack">
      ${renderUpdateCard()}

      ${repoMeta}

      ${features.multiBoard ? renderBoardRenameSection(project) : ""}

      <section class="settings-card">
        <header class="settings-card-head">
          <h3 class="settings-card-title">Board Snapshot</h3>
        </header>
        <div class="settings-card-body">
          <div class="settings-row">
            <p class="description">Import accepts Orbit snapshots or Trello board JSON exports. The default import creates a separate board and leaves this board untouched.</p>
            ${features.attachments ? `
              <label class="orbit-check settings-toggle">
                <input type="checkbox" id="exportProjectImages" />
                <span class="orbit-check-box" aria-hidden="true">
                  <svg viewBox="0 0 16 16" class="orbit-check-tick"><path d="M3.5 8.5l3 3 6-7" /></svg>
                </span>
                <span class="settings-toggle-text">
                  <span class="settings-row-title">Include attached images</span>
                </span>
              </label>
            ` : ""}
            <div class="deployment-actions">
              <button type="button" data-variant="primary" id="exportProject">Export</button>
              <input type="file" id="importSnapshotAsNewFile" class="import-file-input" accept=".orbit.json,.json,application/json" />
              <button type="button" data-variant="primary" id="importSnapshotAsNewButton">Import as New Board</button>
            </div>
          </div>
        </div>
      </section>

      <section class="settings-card settings-card--danger">
        <header class="settings-card-head">
          <h3 class="settings-card-title">Replace Current Board</h3>
        </header>
        <div class="settings-card-body">
          <div class="settings-row">
            <p class="description">Advanced: replace this board from an Orbit snapshot or Trello export after making the normal pre-import backup. Type <strong>${escapeHtml(project.slug || "")}</strong> to enable replacement.</p>
            <label class="control-field repository-confirm-field">
              <span class="control-field-label">Board slug</span>
              <input id="replaceImportConfirmInput" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(project.slug || "")}" />
            </label>
            <div class="deployment-actions">
              <input type="file" id="replaceCurrentBoardImportFile" class="import-file-input" accept=".orbit.json,.json,application/json" disabled />
              <button type="button" data-variant="primary" data-arc="danger" id="replaceCurrentBoardImportButton" disabled>Replace Current Board</button>
            </div>
          </div>
        </div>
      </section>

      ${features.multiBoard ? renderDeleteBoardSection(project) : ""}
    </div>
  `;
}

function renderHelperFilesSection(project) {
  const hasFolder = Boolean(project.system_path);
  const managed = Boolean(project.manage_helper_files);
  return `
    <section class="settings-card helper-files-section">
      <header class="settings-card-head">
        <h3 class="settings-card-title">AI Helper Files</h3>
      </header>
      <div class="settings-card-body">
        <div class="settings-row">
          <p class="description">Orbit can keep <code>SKILL-ORBIT.md</code> and <code>AGENTS.md</code> in this board's coding project folder so your AI agent knows how to use Orbit.${hasFolder ? "" : " Link a folder to enable this."}</p>
          <div class="folder-picker-field helper-files-folder">
            <input id="helperFolderInput" type="text" readonly placeholder="No folder linked" value="${escapeHtml(project.system_path || "")}" />
            <button type="button" id="helperPickFolderBtn">${hasFolder ? "Change" : "Browse"}</button>
          </div>
          <label class="orbit-check settings-toggle">
            <input type="checkbox" id="manageHelperFilesToggle" ${managed ? "checked" : ""} ${hasFolder ? "" : "disabled"} />
            <span class="orbit-check-box" aria-hidden="true">
              <svg viewBox="0 0 16 16" class="orbit-check-tick"><path d="M3.5 8.5l3 3 6-7" /></svg>
            </span>
            <span class="settings-toggle-text">
              <span class="settings-row-title">Generate &amp; maintain helper files in this folder</span>
            </span>
          </label>
        </div>
      </div>
    </section>
  `;
}

function renderBoardRenameSection(project) {
  return `
    <section class="settings-card board-rename-section">
      <header class="settings-card-head">
        <h3 class="settings-card-title">Board Name</h3>
      </header>
      <div class="settings-card-body">
        <div class="settings-row">
          <p class="description">Rename the board display name only. The canonical URL slug stays <strong>${escapeHtml(project.slug || "")}</strong>, so existing board links keep working.</p>
          <form id="boardRenameForm" class="field-form">
            <label class="control-field">
              <span class="control-field-label">Display name</span>
              <input name="name" value="${escapeHtml(project.name || "")}" maxlength="120" required />
            </label>
            <button type="submit" data-variant="primary">Rename Board</button>
          </form>
        </div>
      </div>
    </section>
  `;
}

function renderDeleteBoardSection(project) {
  const slug = escapeHtml(project.slug || "");
  if (repositoryDelete.step === "choice") {
    return `
      <section class="settings-card settings-card--danger">
        <header class="settings-card-head">
          <h3 class="settings-card-title">Delete Board</h3>
        </header>
        <div class="settings-card-body">
          <div class="settings-row">
            <p class="description">Delete this board from Orbit and remove its repo-local Orbit files. Export a snapshot first if you may need this board again.</p>
            <div class="repository-delete-actions">
              <button type="button" data-variant="primary" id="deleteBoardExportFirst">Export first</button>
              <button type="button" data-variant="primary" data-arc="danger" id="deleteBoardSkipExport">Delete without exporting</button>
              <button type="button" data-variant="ghost" id="deleteBoardCancel">Cancel</button>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  if (repositoryDelete.step === "confirm") {
    const exportedCopy = repositoryDelete.exported
      ? "Snapshot exported. Type the board slug to confirm permanent deletion."
      : "Type the board slug to confirm permanent deletion.";
    return `
      <section class="settings-card settings-card--danger is-confirming">
        <header class="settings-card-head">
          <h3 class="settings-card-title">Delete Board</h3>
        </header>
        <div class="settings-card-body">
          <div class="settings-row">
            <p class="description">${escapeHtml(exportedCopy)}</p>
            <label class="control-field repository-confirm-field">
              <span class="control-field-label">Board slug</span>
              <strong>${slug}</strong>
              <input id="deleteBoardConfirmInput" autocomplete="off" spellcheck="false" placeholder="${slug}" autofocus />
            </label>
            <div class="repository-delete-actions">
              <button type="button" data-variant="primary" data-arc="danger" id="deleteBoardConfirm" disabled>Delete board permanently</button>
              <button type="button" data-variant="ghost" id="deleteBoardCancel">Cancel</button>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  return `
    <section class="settings-card settings-card--danger">
      <header class="settings-card-head">
        <h3 class="settings-card-title">Delete Board</h3>
      </header>
      <div class="settings-card-body">
        <div class="settings-row">
          <p class="description">Remove this board from Orbit and delete its repo-local Orbit files. This cannot be undone without an exported snapshot.</p>
          <button type="button" data-variant="primary" data-arc="danger" id="deleteBoardStart">Delete Board</button>
        </div>
      </div>
    </section>
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
    <div class="section settings-notes-section">
      <div class="inline-md-field">
        <span class="inline-md-field-label font-orbitron">Notes For You</span>
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
      <label class="orbit-check settings-toggle" for="showPriorityToggle">
        <input
          type="checkbox"
          id="showPriorityToggle"
          ${showPriority ? "checked" : ""}
        />
        <span class="orbit-check-box" aria-hidden="true">
          <svg viewBox="0 0 16 16" class="orbit-check-tick"><path d="M3.5 8.5l3 3 6-7" /></svg>
        </span>
        <span class="settings-toggle-text">
          <span class="settings-row-title">Show priority label on cards</span>
        </span>
      </label>
      <p class="description lanes-description">Rename, reorder, add, or remove lanes.</p>
      ${renderLaneManager()}
      <form id="laneCreateForm" class="lane-create-form">
        <input name="name" placeholder="New lane name..." required />
        <button type="submit" data-variant="primary">Add Lane</button>
      </form>
    </div>
  `;
}

const UPDATE_INSTRUCTIONS = {
  source: "git pull\npnpm install\npnpm run build:bundle\n# then restart Orbit",
  docker: "git pull\ndocker compose build\ndocker compose up -d",
  dist: "npm install -g @starlove/orbit@latest\n# then restart Orbit"
};

const UPDATE_MODE_LABEL = {
  source: "local / server",
  docker: "Docker",
  dist: "npm"
};

const updateCheckGlyph = `<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L4.3 10.7a1 1 0 1 1 1.4-1.4l2.8 2.8 6.8-6.8a1 1 0 0 1 1.4 0z" clip-rule="evenodd"/></svg>`;

// "Version & Updates" card (top of the Data tab). Reads the cached /api/version
// payload (populated by the boot-time check in update-check.js); renders
// neutrally when it's missing (preview edition / check disabled). The whole
// card gains an accent when an update is available so it reads at a glance.
function renderUpdateCard() {
  const info = getUpdateInfo();
  const mode = info?.deployMode || "source";
  const available = Boolean(info?.updateAvailable);
  const current = info?.current ? `v${escapeHtml(info.current)}` : "—";
  const showSelfUpdate = Boolean(info?.selfUpdate && available);

  const chip = !info
    ? `<span class="update-status-chip update-status-chip--idle">Not checked</span>`
    : info.error
      ? `<span class="update-status-chip update-status-chip--warn">Couldn't check</span>`
      : available
        ? `<span class="update-status-chip update-status-chip--available"><span class="update-status-dot" aria-hidden="true"></span>Update available</span>`
        : `<span class="update-status-chip update-status-chip--current">${updateCheckGlyph} Up to date</span>`;

  const statusLine = !info
    ? "Check whether a newer version of Orbit has shipped."
    : info.error
      ? `Couldn't reach GitHub (${escapeHtml(info.error)}). Try again in a moment.`
      : available
        ? "Back up your boards, then update with the steps below."
        : "You have the latest version of Orbit.";

  const versionBlock = available
    ? `<span class="update-version-now">${current}</span>
       <span class="update-version-arrow" aria-hidden="true">→</span>
       <span class="update-version-next">v${escapeHtml(info.latest)}</span>`
    : `<span class="update-version-now">${current}</span>`;

  const howto = available
    ? `
        <details class="update-howto" open>
          <summary>How to update <span class="update-howto-mode">${escapeHtml(UPDATE_MODE_LABEL[mode] || mode)}</span></summary>
          <pre class="update-commands"><code id="updateCommands">${escapeHtml(UPDATE_INSTRUCTIONS[mode] || UPDATE_INSTRUCTIONS.source)}</code></pre>
          <div class="update-howto-foot">
            <button type="button" data-variant="ghost" id="updateCopyCommands">Copy commands</button>
            ${info.changesUrl ? `<a class="update-changes-link" href="${escapeHtml(info.changesUrl)}" target="_blank" rel="noopener">View changes ↗</a>` : ""}
          </div>
        </details>`
    : "";

  return `
    <section class="settings-card update-card${available ? " update-card--available" : ""}">
      <header class="settings-card-head">
        <h3 class="settings-card-title">Version &amp; Updates</h3>
        ${chip}
      </header>
      <div class="settings-card-body">
        <div class="settings-row update-row">
          <div class="update-version-line">${versionBlock}</div>
          <p class="description" id="updateStatusLine">${statusLine}</p>
          <div class="deployment-actions update-actions">
            <button type="button" data-variant="${available ? "secondary" : "primary"}" id="updateCheckNow">Check now</button>
            <button type="button" data-variant="secondary" id="updateBackupBoards">Back up all boards</button>
            ${showSelfUpdate ? `<button type="button" data-variant="primary" id="updateRunNow">Update now</button>` : ""}
          </div>
          ${howto}
          <p class="description update-docs-hint">Full guide: <a href="https://github.com/brucestarlove/ss-orbit/blob/master/docs/UPDATING.md" target="_blank" rel="noopener">docs/UPDATING.md</a></p>
        </div>
      </div>
    </section>`;
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
    <div class="settings-stack appearance-settings">
      <section class="settings-card">
        <header class="settings-card-head">
          <h3 class="settings-card-title">Theme</h3>
        </header>
        <div class="settings-card-body">
          <div class="settings-toggle">
            <button
              type="button"
              class="topbar-btn topbar-ctl-shrink"
              data-variant="theme"
              id="appearanceThemeToggle"
              aria-label="Toggle theme"
            >
              <svg class="topbar-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">${themeIconMarkup(theme)}</svg>
            </button>
            <span class="settings-toggle-text">
              <span class="settings-row-title" id="appearanceThemeLabel">${theme === "dark" ? "Dark" : "Light"}</span>
              <span class="description">Tap to switch between the light and dark theme used across the app.</span>
            </span>
          </div>
          <div class="settings-toggle">
            <button
              type="button"
              class="topbar-btn topbar-ctl-shrink motion-toggle"
              data-variant="theme"
              id="appearanceMotionToggle"
              aria-pressed="${reduceMotion ? "true" : "false"}"
              aria-label="Toggle reduced theme motion"
            >
              ${motionIconMarkup()}
            </button>
            <span class="settings-toggle-text">
              <span class="settings-row-title">Reduce theme motion</span>
              <span class="description">Turns off the animated starfield, meteors, and theme animations. ${escapeHtml(sourceLabel)}</span>
            </span>
          </div>
        </div>
      </section>
      ${renderTypographyControls()}
    </div>
  `;
}

function renderTypographyControls() {
  const prefs = storedFontPreferences();
  const siteOptions = SITE_FONT_OPTIONS
    .map((id) => `<option value="${id}"${id === prefs.site ? " selected" : ""}>${escapeHtml(FONT_OPTIONS[id]?.label || id)}</option>`)
    .join("");
  const overrideSelects = Object.entries(FONT_TARGETS).map(([target, config]) => {
    const current = prefs[target];
    const options = Object.entries(FONT_OPTIONS)
      .map(([id, font]) => `<option value="${id}"${id === current ? " selected" : ""}>${escapeHtml(font.label)}</option>`)
      .join("");
    return `
      <label class="control-field">
        <span class="control-field-label">${escapeHtml(config.label)}</span>
        <select class="select-chevron-field" data-font-target="${target}">${options}</select>
      </label>
    `;
  }).join("");

  return `
    <section class="settings-card appearance-typography-card">
      <header class="settings-card-head">
        <h3 class="settings-card-title">Typography</h3>
      </header>
      <div class="settings-card-body">
        <div class="settings-row settings-slider-row">
          <span class="control-field-label">Text size</span>
          <input type="range" class="slider" id="fontScaleSlider" min="${USER_SCALE_MIN}" max="${USER_SCALE_MAX}" step="${USER_SCALE_STEP}" value="${prefs.userScale}" aria-label="Text size" />
          <output id="fontScaleValue" class="control-value">${Math.round(prefs.userScale * 100)}%</output>
        </div>
        <div class="settings-row">
          <label class="control-field">
            <span class="control-field-label">Primary Font</span>
            <select class="select-chevron-field" id="siteFontSelect">${siteOptions}</select>
          </label>
        </div>
        <div class="settings-row">
          <div class="control-grid typography-overrides">${overrideSelects}</div>
        </div>
      </div>
    </section>
  `;
}

// Mirrors the topbar theme toggle: moon when dark is active, sun when light.
function themeIconMarkup(theme) {
  return theme === "dark"
    ? '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />'
    : '<circle cx="12" cy="12" r="5" /><path d="M12 1v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8l1.4 1.4M1 12h2m18 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />';
}

// Twinkling starfield for the motion toggle. Stars shimmer (CSS) while motion
// is allowed and freeze when the button is pressed (reduced). Each star's
// --d staggers its animation so the field reads as alive, not pulsing in unison.
function motionIconMarkup() {
  const stars = [
    { cx: 6, cy: 7, r: 1.1, d: "0s" },
    { cx: 17.5, cy: 6, r: 1.5, d: "0.5s" },
    { cx: 12, cy: 12, r: 1, d: "0.9s" },
    { cx: 7.5, cy: 17, r: 1.4, d: "0.25s" },
    { cx: 18, cy: 16.5, r: 1.1, d: "0.7s" }
  ]
    .map((s) => `<circle class="motion-star" cx="${s.cx}" cy="${s.cy}" r="${s.r}" style="animation-delay:${s.d}" />`)
    .join("");
  return `<svg class="topbar-icon motion-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">${stars}</svg>`;
}

function renderProjectJournalTab(context) {
  const aiEnabled = context.board?.ai_enabled !== 0;
  return `
    ${aiEnabled ? `<p class="description">Agent-facing project memory: decisions to follow and lessons to apply. Struck entries stay visible here but are excluded from agent context.</p>` : ""}
    <div class="section">
      ${renderProjectEntries(context.entries, aiEnabled)}
      <form id="projectEntryForm" class="comment-form project-entry-form">
        <div class="project-entry-form-header">Add entry</div>
        <select name="type" class="select-chevron-field" aria-label="Entry type">
          <option value="decision">Decision</option>
          <option value="lesson">Lesson</option>
        </select>
        <input name="title" placeholder="Entry title..." required />
        <textarea name="body" placeholder="Decision rationale or lesson: do X instead of Y when working with Z." required></textarea>
        <button type="submit" data-variant="primary">Add Entry</button>
      </form>
    </div>
  `;
}

function parseImportSnapshotText(text) {
  const trimmed = String(text || "").trimStart();
  if (trimmed.startsWith("<")) {
    throw new Error("That file looks like an HTML page instead of JSON. In Trello, use Export JSON/download the board JSON, not Save Page As.");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(error?.message || "invalid JSON");
  }
}

function bindProjectTabHandlers(context, tab) {
  const project = context.board;

  if (tab === "data") {
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

    const importSnapshotFile = async (file, bodyForSnapshot) => {
      const text = await file.text();
      const snapshot = parseImportSnapshotText(text);
      return api("/api/admin/import", {
        method: "POST",
        body: bodyForSnapshot(snapshot)
      });
    };

    const importSnapshotAsNewFile = $("#importSnapshotAsNewFile");
    $("#importSnapshotAsNewButton")?.addEventListener("click", () => {
      importSnapshotAsNewFile?.click();
    });

    importSnapshotAsNewFile?.addEventListener("change", async (event) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      if (!file) return;
      try {
        const result = await importSnapshotFile(file, (snapshot) => ({ snapshot, create_new: true, board_id: project.id }));
        state.boardId = result.imported_board_id;
        state.boardSlug = result.imported_board_slug;
        state.detailMode = "empty";
        await load();
        await navigate({ boardId: result.imported_board_id, view: "board" });
        const counts = result.imported_counts || {};
        const cardCount = Number.isFinite(Number(counts.tickets)) ? ` (${counts.tickets} cards)` : "";
        toast.success(result.source_format === "trello-board-export" ? `Trello board imported as new board${cardCount}` : "Board imported as new board");
      } catch (err) {
        toast.error(`Import failed: ${err?.message || "invalid JSON"}`);
      } finally {
        input.value = "";
      }
    });

    const replaceImportConfirmInput = $("#replaceImportConfirmInput");
    const replaceCurrentBoardImportFile = $("#replaceCurrentBoardImportFile");
    const replaceCurrentBoardImportButton = $("#replaceCurrentBoardImportButton");
    replaceImportConfirmInput?.addEventListener("input", () => {
      const disabled = replaceImportConfirmInput.value.trim() !== project.slug;
      if (replaceCurrentBoardImportFile) replaceCurrentBoardImportFile.disabled = disabled;
      if (replaceCurrentBoardImportButton) replaceCurrentBoardImportButton.disabled = disabled;
    });

    replaceCurrentBoardImportButton?.addEventListener("click", () => {
      if (replaceCurrentBoardImportButton.disabled || replaceCurrentBoardImportFile?.disabled) return;
      replaceCurrentBoardImportFile?.click();
    });

    replaceCurrentBoardImportFile?.addEventListener("change", async (event) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      if (!file) return;
      if (replaceImportConfirmInput.value.trim() !== project.slug) {
        toast.error("Type the board slug before replacing this board.");
        input.value = "";
        return;
      }
      try {
        const result = await importSnapshotFile(file, (snapshot) => ({ snapshot, replace_existing: true, board_id: project.id }));
        await load();
        state.detailMode = "settings";
        const counts = result.imported_counts || {};
        const cardCount = Number.isFinite(Number(counts.tickets)) ? ` (${counts.tickets} cards)` : "";
        toast.success(result.source_format === "trello-board-export" ? `Trello board replaced from Trello import${cardCount}` : "Board replaced from snapshot");
      } catch (err) {
        toast.error(`Import failed: ${err?.message || "invalid JSON"}`);
      } finally {
        input.value = "";
      }
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

    // Version & Updates card (top of the Data tab).
    $("#updateCheckNow")?.addEventListener("click", async () => {
      const btn = $("#updateCheckNow");
      btn.disabled = true;
      btn.textContent = "Checking…";
      await fetchVersionInfo({ force: true });
      syncUpdateBadge();
      state.detailMode = "settings";
      await renderProjectDetail();
    });

    $("#updateBackupBoards")?.addEventListener("click", async () => {
      const btn = $("#updateBackupBoards");
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Backing up…";
      try {
        await exportAllBoards();
      } catch (error) {
        toast.error(`Backup failed: ${error?.message || "request failed"}`);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });

    $("#updateCopyCommands")?.addEventListener("click", async () => {
      const text = $("#updateCommands")?.textContent || "";
      try {
        await navigator.clipboard.writeText(text);
        toast.success("Update commands copied");
      } catch {
        toast.error("Couldn't copy — select the commands manually");
      }
    });

    $("#updateRunNow")?.addEventListener("click", async () => {
      const ok = window.confirm(
        "Update Orbit now? It will pull the latest code, rebuild, and restart. Back up your boards first."
      );
      if (!ok) return;
      const btn = $("#updateRunNow");
      btn.disabled = true;
      btn.textContent = "Updating…";
      try {
        await api("/api/update", { method: "POST" });
        toast.success("Update started — Orbit will restart shortly. Reload in a minute.", 9000);
      } catch (error) {
        toast.error(`Update failed to start: ${error?.message || "request failed"}`);
        btn.disabled = false;
        btn.textContent = "Update now";
      }
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
    const themeToggleBtn = $("#appearanceThemeToggle");
    if (themeToggleBtn) {
      const themeLabel = $("#appearanceThemeLabel");
      const themeIcon = themeToggleBtn.querySelector(".topbar-icon");
      themeToggleBtn.addEventListener("click", () => {
        const theme = toggleThemePreference();
        if (themeIcon) themeIcon.innerHTML = themeIconMarkup(theme);
        if (themeLabel) themeLabel.textContent = theme === "dark" ? "Dark" : "Light";
        toast.success(theme === "dark" ? "Dark theme enabled" : "Light theme enabled");
      });
    }

    const motionToggleBtn = $("#appearanceMotionToggle");
    motionToggleBtn?.addEventListener("click", () => {
      const reduce = motionToggleBtn.getAttribute("aria-pressed") !== "true";
      motionToggleBtn.setAttribute("aria-pressed", reduce ? "true" : "false");
      setReducedMotionPreference(reduce);
      applyReducedMotionPreference();
      window.dispatchEvent(new CustomEvent("orbit:motion-preference-change", { detail: { reduce } }));
      toast.success(reduce ? "Theme motion reduced" : "Theme motion enabled");
    });

    // Primary font swap resets every override, so reflect that in the category
    // selects without re-fetching/re-rendering the whole drawer.
    $("#siteFontSelect")?.addEventListener("change", (event) => {
      const next = setSiteFont(event.currentTarget.value);
      drawerInner.querySelectorAll("select[data-font-target]").forEach((select) => {
        select.value = next[select.dataset.fontTarget];
      });
      toast.success(`Primary font: ${FONT_OPTIONS[next.site]?.label || "updated"}`);
    });

    const fontScaleSlider = $("#fontScaleSlider");
    if (fontScaleSlider) {
      const scaleValue = $("#fontScaleValue");
      fontScaleSlider.addEventListener("input", (event) => {
        const next = setUserScale(event.currentTarget.value);
        if (scaleValue) scaleValue.textContent = `${Math.round(next.userScale * 100)}%`;
      });
    }

    bindSliders(drawerInner);

    drawerInner.querySelectorAll("select[data-font-target]").forEach((select) => {
      select.addEventListener("change", (event) => {
        setFontPreference(event.currentTarget.dataset.fontTarget, event.currentTarget.value);
      });
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

    const instructionsEl = drawerInner.querySelector('[data-edit-field="agent_instructions"]');
    if (instructionsEl) {
      const edit = () =>
        startInlineEdit(instructionsEl, {
          fieldName: "agent_instructions",
          multiline: true,
          initialValue: project.agent_instructions || "",
          ariaLabel: "Edit Agent Instructions",
          rerender: async () => {
            state.detailMode = "settings";
            await renderProjectDetail();
          },
          commit: async (next) => {
            await api(`/api/boards/${project.id}`, {
              method: "PATCH",
              body: { agent_instructions: cleanText(next) }
            });
            await load();
            state.detailMode = "settings";
            toast.success("Saved");
          }
        });
      instructionsEl.addEventListener("click", (event) => {
        event.preventDefault();
        edit();
      });
      instructionsEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          edit();
        }
      });
    }

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

    const helperPickFolderBtn = $("#helperPickFolderBtn");
    helperPickFolderBtn?.addEventListener("click", async () => {
      helperPickFolderBtn.disabled = true;
      try {
        const result = await api("/api/system/pick-folder", { method: "POST" });
        if (!result.path) return;
        await api(`/api/boards/${encodeURIComponent(project.id)}`, {
          method: "PATCH",
          body: { system_path: result.path }
        });
        await load();
        state.detailMode = "settings";
        toast.success("Linked coding project folder updated");
      } catch (error) {
        toast.error(error?.message || "Folder picker unavailable");
      } finally {
        helperPickFolderBtn.disabled = false;
      }
    });

    const manageHelperFilesToggle = $("#manageHelperFilesToggle");
    manageHelperFilesToggle?.addEventListener("change", async () => {
      const enabled = manageHelperFilesToggle.checked;
      manageHelperFilesToggle.disabled = true;
      try {
        await api(`/api/boards/${encodeURIComponent(project.id)}`, {
          method: "PATCH",
          body: { manage_helper_files: enabled }
        });
        await load();
        state.detailMode = "settings";
        toast.success(
          enabled
            ? "Generated SKILL-ORBIT.md and AGENTS.md — Orbit will keep them in sync"
            : "Stopped maintaining helper files (existing files left in place)"
        );
      } catch (error) {
        manageHelperFilesToggle.checked = !enabled;
        manageHelperFilesToggle.disabled = false;
        toast.error(error?.message || "Could not update helper files setting");
      }
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
          toast.removed(`Deleted: ${cardTitle}`);
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

function renderProjectEntries(entries = [], aiEnabled = false) {
  if (!entries.length) return `<p class="description">No project entries yet.</p>`;
  return entries
    .map(
      (entry) => {
        const isStruck = Boolean(entry.struck_at);
        const showStruckState = aiEnabled && isStruck;
        return `
        <div class="comment project-entry ${escapeHtml(entry.type)} ${showStruckState ? "is-struck" : ""}">
          <div class="comment-head">
            <div class="comment-head-main">
              <div class="comment-head-title">
                <span class="entry-type-pill ${escapeHtml(entry.type)}">${escapeHtml(entry.type)}</span>
                <strong class="entry-title">${escapeHtml(entry.title)}</strong>
              </div>
              ${showStruckState ? `<span class="project-entry-status">Excluded from agent context</span>` : ""}
            </div>
          </div>
          <div class="comment-body">${escapeHtml(entry.body)}</div>
          <div class="comment-footer">
            <span class="comment-footer-meta">${escapeHtml(entry.created_by)} · ${formatDate(entry.created_at)}</span>
            ${
              aiEnabled
                ? `<button
              type="button"
              data-variant="ghost"
              class="project-entry-strike detail-action-btn"
              data-entry-action="toggle-struck"
              data-entry-id="${escapeHtml(entry.id)}"
              data-struck="${isStruck ? "true" : "false"}"
              aria-pressed="${isStruck ? "true" : "false"}"
            >${isStruck ? "Restore" : "Strike"}</button>`
                : ""
            }
          </div>
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
              <button type="button" data-variant="ghost" class="settings-lane-icon-btn" data-lane-action="up" ${index === 0 ? "disabled" : ""} title="Move lane left" aria-label="Move lane left">↑</button>
              <button type="button" data-variant="ghost" class="settings-lane-icon-btn" data-lane-action="down" ${index === lanes.length - 1 ? "disabled" : ""} title="Move lane right" aria-label="Move lane right">↓</button>
              <input name="name" value="${escapeHtml(lane.name)}" aria-label="Lane name" ${isAiReady ? `readonly title="${escapeHtml(nameTitle)}"` : ""} />
              <button type="button" data-variant="${lane.is_default ? "secondary" : "ghost"}" class="settings-lane-new-toggle ${lane.is_default ? "is-on" : ""}" data-lane-action="toggle-default" aria-pressed="${lane.is_default ? "true" : "false"}" title="${lane.is_default ? "Default lane for new cards — click another lane to move it" : "Make this the default lane for new cards"}" aria-label="Default lane for new cards">
                <span class="lane-new-sun" aria-hidden="true"></span>
                <span class="lane-new-label">New</span>
              </button>
              <button type="button" data-variant="ghost" class="settings-lane-delete-btn danger-button" data-lane-action="delete" ${deleteDisabled(lane, counts, aiEnabled) ? "disabled" : ""} title="${deleteTitle(lane, counts, aiEnabled)}" aria-label="Delete lane">${closeIconSvg}</button>
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
      btn.setAttribute("data-variant", "ghost");
      btn.classList.remove("is-on");
    });
    button.setAttribute("aria-pressed", "true");
    button.setAttribute("data-variant", "secondary");
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
