import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardNotesSummary } from "../public/js/topbar-notes.js";

const repoRoot = resolve(import.meta.dirname, "..");

test("topbar notes summary uses only board notes with a useful fallback", () => {
  assert.equal(
    boardNotesSummary({
      project_notes: "Current note line one\nline two",
      agent_instructions: "Objective: this should not appear"
    }),
    "Current note line one line two"
  );

  assert.equal(boardNotesSummary({}), "No board notes yet");
});

test("topbar exposes truncated board notes and shared editable popover without a marquee", () => {
  const indexSource = readFileSync(join(repoRoot, "public", "index.html"), "utf8");
  const mainSource = readFileSync(join(repoRoot, "public", "js", "main.js"), "utf8");
  const appSource = readFileSync(join(repoRoot, "public", "js", "app.js"), "utf8");
  const topbarNotesSource = readFileSync(join(repoRoot, "public", "js", "topbar-notes.js"), "utf8");

  assert.match(indexSource, /id="brandFocusBtn"[\s\S]*data-variant="brand-focus"[\s\S]*aria-controls="brandFocusPopover"/);
  assert.match(indexSource, /id="brandNotesBtn"[\s\S]*class="topbar-notes brand-notes-strip"[\s\S]*id="topbarSearch"/);
  assert.match(indexSource, /id="brandFocusPopover"[\s\S]*Notes For You/);
  assert.doesNotMatch(indexSource, /Objective|brandFocusMarquee/);
  assert.match(mainSource, /wireTopbarFocus\(\)/);
  assert.match(appSource, /renderTopbarFocus\(currentBoard\(\)\)/);
  assert.match(topbarNotesSource, /renderPreservedText\(notes\)/);
  assert.match(topbarNotesSource, /notesText\.textContent\s*=\s*summary === NOTE_FALLBACK \? "" : summary/);
  assert.match(topbarNotesSource, /data-edit-field="project_notes"/);
  assert.match(topbarNotesSource, /startInlineEdit\(notesEl,/);
  assert.match(topbarNotesSource, /body:\s*\{\s*project_notes:\s*cleanText\(next\)\s*\}/);
  assert.match(topbarNotesSource, /dataset\.state\s*=\s*open \? "open" : "closed"/);
  assert.match(indexSource, /id="newTicketBtn"[\s\S]*aria-label="New Card"/);
});
