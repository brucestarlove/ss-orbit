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
  const stylesSource = readFileSync(join(repoRoot, "public", "styles.css"), "utf8");

  assert.match(indexSource, /id="brandFocusBtn"[\s\S]*data-variant="brand-focus"[\s\S]*aria-controls="brandFocusPopover"/);
  assert.match(indexSource, /id="brandNotesBtn"[\s\S]*class="topbar-notes brand-notes-strip"[\s\S]*id="topbarSearch"/);
  assert.match(indexSource, /id="brandFocusPopover"[\s\S]*Board notes/);
  assert.doesNotMatch(indexSource, /Objective|brandFocusMarquee/);
  assert.match(mainSource, /wireTopbarFocus\(\)/);
  assert.match(appSource, /renderTopbarFocus\(currentBoard\(\)\)/);
  assert.match(topbarNotesSource, /renderPreservedText\(notes\)/);
  assert.match(topbarNotesSource, /notesText\.textContent\s*=\s*summary === NOTE_FALLBACK \? "" : summary/);
  assert.match(topbarNotesSource, /data-edit-field="project_notes"/);
  assert.match(topbarNotesSource, /startInlineEdit\(notesEl,/);
  assert.match(topbarNotesSource, /body:\s*\{\s*project_notes:\s*cleanText\(next\)\s*\}/);
  assert.match(topbarNotesSource, /dataset\.state\s*=\s*open \? "open" : "closed"/);
  assert.match(stylesSource, /@import "@starlove\/ui\/components\/topbar-notes";/);
  assert.match(stylesSource, /\.brand-notes-strip\s*\{[\s\S]*--topbar-notes-max-width:\s*min\(600px,\s*42vw\);/);
  assert.doesNotMatch(stylesSource, /\.topbar-notes,[\s\S]*\.brand-notes-strip\s*\{[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/);
  assert.doesNotMatch(stylesSource, /\.brand-notes-strip:is\(:hover,\s*:focus-visible,\s*\[aria-expanded="true"\],\s*\[data-state="open"\]\)/);
  assert.match(stylesSource, /\.brand-focus-btn:is\(:hover,\s*:focus-visible,\s*\[aria-expanded="true"\]\)\s*\{[\s\S]*background:\s*rgba\(var\(--accent-rgb\),0\.08\);[\s\S]*transform:\s*translateY\(-1px\);/);
  assert.match(stylesSource, /\.brand-focus-popover\s*\{[\s\S]*width:\s*min\(58rem,\s*calc\(100vw - 2rem\)\);[\s\S]*max-height:\s*min\(calc\(100vh - 5rem\),\s*42rem\);/);
  assert.match(stylesSource, /\.brand-focus-popover\[hidden\]\s*\{[\s\S]*display:\s*none;/);
  assert.match(stylesSource, /\.brand-focus-notes-body\s*\{[\s\S]*max-height:\s*min\(calc\(100vh - 11rem\),\s*34rem\);[\s\S]*overflow-x:\s*hidden;[\s\S]*overflow-y:\s*auto;/);
  assert.match(stylesSource, /\.brand-focus-notes-edit\s*\{[\s\S]*overflow-x:\s*hidden;[\s\S]*overflow-wrap:\s*anywhere;/);
  assert.match(stylesSource, /\.inline-md-field-body\s*\{[\s\S]*margin-inline:\s*1px;/);
  assert.doesNotMatch(stylesSource, /@keyframes\s+brand-focus-marquee|brand-focus-marquee__inner|animation:\s*brand-focus-marquee/);
});
