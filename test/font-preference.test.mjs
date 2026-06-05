import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FONT_LETTER_SPACING,
  DEFAULT_FONT_LINE_HEIGHT,
  DEFAULT_FONT_PREFERENCES,
  DEFAULT_SITE_FONT,
  DEFAULT_USER_SCALE,
  FONT_CHANGE_EVENT,
  FONT_OPTIONS,
  FONT_STORAGE_KEY,
  SITE_FONT_OPTIONS,
  USER_SCALE_MAX,
  USER_SCALE_MIN,
  clampUserScale,
  fontLetterSpacingFor,
  fontLineHeightFor,
  fontScaleFor,
  fontStackFor,
  normalizeFontPreferences,
  resetFontPreferences,
  setFontPreference,
  setFontPreferences,
  setSiteFont,
  setUserScale,
  storedFontPreferences
} from "../public/js/font-preference.js";

const FONT_IDS = [
  "inter",
  "openSans",
  "jetBrainsMono",
  "chakraPetch",
  "orbitron",
  "rajdhani",
  "runescapeUF",
  "openRing"
];

const DEFAULT_TARGETS = {
  ui: "orbitron",
  heading: "inter",
  body: "inter",
  prose: "inter",
  label: "orbitron"
};

class MemoryStorage {
  #items = new Map();
  getItem(key) { return this.#items.has(key) ? this.#items.get(key) : null; }
  setItem(key, value) { this.#items.set(key, String(value)); }
  removeItem(key) { this.#items.delete(key); }
}

function documentStub() {
  const attributes = new Map();
  const styles = new Map();
  return {
    attributes,
    styles,
    documentElement: {
      style: { setProperty(name, value) { styles.set(name, value); } },
      setAttribute(name, value) { attributes.set(name, value); }
    }
  };
}

function eventTargetStub() {
  const events = [];
  return {
    events,
    dispatchEvent(event) {
      events.push(event);
      return true;
    }
  };
}

function appliedFonts(doc) {
  return {
    ui: doc.styles.get("--orbit-font-ui"),
    heading: doc.styles.get("--orbit-font-heading"),
    body: doc.styles.get("--orbit-font-body"),
    prose: doc.styles.get("--orbit-font-prose"),
    label: doc.styles.get("--orbit-font-label")
  };
}

function defaultFontStacks() {
  return {
    ui: fontStackFor("orbitron"),
    heading: fontStackFor("inter"),
    body: fontStackFor("inter"),
    prose: fontStackFor("inter"),
    label: fontStackFor("orbitron")
  };
}

test("registry and defaults describe the supported font profile", () => {
  assert.equal(DEFAULT_SITE_FONT, "inter");
  assert.deepEqual(SITE_FONT_OPTIONS, FONT_IDS);
  assert.deepEqual(Object.keys(FONT_OPTIONS), FONT_IDS);
  assert.deepEqual(DEFAULT_FONT_PREFERENCES, {
    ...DEFAULT_TARGETS,
    site: "inter",
    userScale: DEFAULT_USER_SCALE
  });
});

test("normalization accepts known choices and falls back for stale persisted values", () => {
  assert.deepEqual(normalizeFontPreferences({
    ui: "openRing",
    heading: "missing",
    site: "runescapeUF",
    userScale: 99
  }), {
    ...DEFAULT_FONT_PREFERENCES,
    ui: "openRing",
    site: "runescapeUF",
    userScale: USER_SCALE_MAX
  });

  assert.equal(normalizeFontPreferences({ userScale: 0 }).userScale, USER_SCALE_MIN);
  assert.equal(normalizeFontPreferences({ userScale: "x" }).userScale, DEFAULT_USER_SCALE);
  assert.deepEqual(
    normalizeFontPreferences({ body: "retiredFont", site: "retiredFont" }),
    DEFAULT_FONT_PREFERENCES
  );

  const storage = new MemoryStorage();
  storage.setItem(FONT_STORAGE_KEY, "not-json");
  assert.deepEqual(storedFontPreferences(storage), DEFAULT_FONT_PREFERENCES);
});

test("font metrics stay explicit and data-driven", () => {
  assert.equal(clampUserScale(1.15), 1.15);
  assert.equal(clampUserScale(99), USER_SCALE_MAX);
  assert.equal(clampUserScale(-1), USER_SCALE_MIN);
  assert.equal(clampUserScale("nope"), DEFAULT_USER_SCALE);

  const metricsByFont = Object.fromEntries(FONT_IDS.map((id) => [id, {
    scale: fontScaleFor(id),
    letterSpacing: fontLetterSpacingFor(id),
    lineHeight: fontLineHeightFor(id)
  }]));

  assert.deepEqual(metricsByFont, {
    inter: { scale: 1, letterSpacing: DEFAULT_FONT_LETTER_SPACING, lineHeight: DEFAULT_FONT_LINE_HEIGHT },
    openSans: { scale: 1, letterSpacing: DEFAULT_FONT_LETTER_SPACING, lineHeight: DEFAULT_FONT_LINE_HEIGHT },
    jetBrainsMono: { scale: 1, letterSpacing: DEFAULT_FONT_LETTER_SPACING, lineHeight: DEFAULT_FONT_LINE_HEIGHT },
    chakraPetch: { scale: 1, letterSpacing: DEFAULT_FONT_LETTER_SPACING, lineHeight: DEFAULT_FONT_LINE_HEIGHT },
    orbitron: { scale: 1, letterSpacing: DEFAULT_FONT_LETTER_SPACING, lineHeight: DEFAULT_FONT_LINE_HEIGHT },
    rajdhani: { scale: 1, letterSpacing: DEFAULT_FONT_LETTER_SPACING, lineHeight: DEFAULT_FONT_LINE_HEIGHT },
    runescapeUF: { scale: 0.95, letterSpacing: DEFAULT_FONT_LETTER_SPACING, lineHeight: DEFAULT_FONT_LINE_HEIGHT },
    openRing: { scale: 1.2, letterSpacing: "0.4px", lineHeight: DEFAULT_FONT_LINE_HEIGHT }
  });

  assert.equal(fontScaleFor("unknown"), 1);
  assert.equal(fontLetterSpacingFor("unknown"), DEFAULT_FONT_LETTER_SPACING);
  assert.equal(fontLineHeightFor("unknown"), DEFAULT_FONT_LINE_HEIGHT);
});

test("saving preferences persists, applies root CSS variables, and dispatches one event", () => {
  const storage = new MemoryStorage();
  const doc = documentStub();
  const target = eventTargetStub();

  const preferences = setFontPreferences({
    ui: "orbitron",
    heading: "openRing",
    body: "openSans",
    prose: "runescapeUF",
    label: "openRing",
    site: "openRing",
    userScale: 1.2
  }, { doc, storage, eventTarget: target });

  assert.deepEqual(JSON.parse(storage.getItem(FONT_STORAGE_KEY)), preferences);
  assert.deepEqual(appliedFonts(doc), {
    ui: fontStackFor("orbitron"),
    heading: fontStackFor("openRing"),
    body: fontStackFor("openSans"),
    prose: fontStackFor("runescapeUF"),
    label: fontStackFor("openRing")
  });
  assert.equal(doc.styles.get("--type-family-scale"), "1.2");
  assert.equal(doc.styles.get("--type-user-scale"), "1.2");
  assert.equal(doc.styles.get("--orbit-letter-spacing"), "0.4px");
  assert.equal(doc.styles.get("--orbit-line-height"), DEFAULT_FONT_LINE_HEIGHT);
  assert.equal(doc.attributes.get("data-font-site"), "openRing");
  assert.equal(target.events.length, 1);
  assert.equal(target.events[0].type, FONT_CHANGE_EVENT);
  assert.deepEqual(target.events[0].detail, { preferences });
});

test("target, site, user-scale, and reset setters preserve their boundaries", () => {
  const storage = new MemoryStorage();
  const doc = documentStub();
  const events = eventTargetStub();

  assert.throws(() => setSiteFont("missing", { doc, storage, eventTarget: events }), /Unknown font option/);
  assert.throws(() => setFontPreference("missing", "inter", { doc, storage, eventTarget: events }), /Unknown font target/);
  assert.throws(() => setFontPreference("body", "missing", { doc, storage, eventTarget: events }), /Unknown font option/);

  let preferences = setSiteFont("openRing", { doc, storage, eventTarget: events });
  for (const key of ["ui", "heading", "body", "prose", "label", "site"]) {
    assert.equal(preferences[key], "openRing");
  }
  assert.equal(doc.styles.get("--type-family-scale"), "1.2");
  assert.equal(doc.styles.get("--orbit-letter-spacing"), "0.4px");

  preferences = setFontPreference("body", "inter", { doc, storage, eventTarget: events });
  assert.equal(preferences.body, "inter");
  assert.equal(preferences.site, "openRing");
  assert.equal(doc.styles.get("--orbit-font-body"), fontStackFor("inter"));
  assert.equal(doc.styles.get("--type-family-scale"), "1.2");

  preferences = setUserScale(5, { doc, storage, eventTarget: events });
  assert.equal(preferences.userScale, USER_SCALE_MAX);
  assert.equal(doc.styles.get("--type-user-scale"), String(USER_SCALE_MAX));

  preferences = resetFontPreferences({ doc, storage, eventTarget: events });
  assert.deepEqual(preferences, DEFAULT_FONT_PREFERENCES);
  assert.deepEqual(appliedFonts(doc), defaultFontStacks());
  assert.equal(doc.styles.get("--type-family-scale"), "1");
  assert.equal(doc.styles.get("--type-user-scale"), "1");
  assert.equal(doc.styles.get("--orbit-letter-spacing"), DEFAULT_FONT_LETTER_SPACING);
  assert.equal(doc.styles.get("--orbit-line-height"), DEFAULT_FONT_LINE_HEIGHT);
  assert.equal(doc.attributes.get("data-font-site"), "inter");
});
