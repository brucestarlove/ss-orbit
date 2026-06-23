import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FONT_PREFERENCES,
  DEFAULT_SITE_FONT,
  DEFAULT_USER_SCALE,
  FONT_CHANGE_EVENT,
  FONT_OPTIONS,
  FONT_STORAGE_KEY,
  LEGACY_FONT_TARGET_ALIASES,
  SITE_FONT_OPTIONS,
  USER_SCALE_MAX,
  USER_SCALE_MIN,
  clampUserScale,
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
  control: "inter",
  heading: "orbitron",
  label: "inter",
  badge: "orbitron"
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

// Body text is not a category target: it tracks the primary font (`site`), so
// --orbit-font-body is asserted separately from the override categories.
function appliedFonts(doc) {
  return {
    control: doc.styles.get("--orbit-font-control"),
    heading: doc.styles.get("--orbit-font-heading"),
    label: doc.styles.get("--orbit-font-label"),
    badge: doc.styles.get("--orbit-font-badge")
  };
}

function defaultFontStacks() {
  return {
    control: fontStackFor("inter"),
    heading: fontStackFor("orbitron"),
    label: fontStackFor("inter"),
    badge: fontStackFor("orbitron")
  };
}

test("registry and defaults describe the supported font profile", () => {
  assert.equal(DEFAULT_SITE_FONT, "inter");
  assert.deepEqual(SITE_FONT_OPTIONS, FONT_IDS);
  assert.deepEqual(Object.keys(FONT_OPTIONS), FONT_IDS);
  assert.deepEqual(LEGACY_FONT_TARGET_ALIASES, { ui: "control" });
  assert.deepEqual(DEFAULT_FONT_PREFERENCES, {
    ...DEFAULT_TARGETS,
    site: "inter",
    userScale: DEFAULT_USER_SCALE
  });
});

test("normalization accepts known choices and falls back for stale persisted values", () => {
  assert.deepEqual(normalizeFontPreferences({
    control: "openRing",
    ui: "orbitron",
    heading: "missing",
    site: "runescapeUF",
    userScale: 99
  }), {
    ...DEFAULT_FONT_PREFERENCES,
    control: "openRing",
    site: "runescapeUF",
    userScale: USER_SCALE_MAX
  });

  assert.equal(normalizeFontPreferences({ userScale: 0 }).userScale, USER_SCALE_MIN);
  assert.equal(normalizeFontPreferences({ userScale: "x" }).userScale, DEFAULT_USER_SCALE);
  assert.deepEqual(
    normalizeFontPreferences({ body: "retiredFont", site: "retiredFont" }),
    DEFAULT_FONT_PREFERENCES
  );
  assert.deepEqual(normalizeFontPreferences({ ui: "orbitron" }), {
    ...DEFAULT_FONT_PREFERENCES,
    control: "orbitron"
  });
  assert.deepEqual(normalizeFontPreferences({ label: "rajdhani" }), {
    ...DEFAULT_FONT_PREFERENCES,
    label: "rajdhani",
    badge: "rajdhani"
  });
  assert.deepEqual(normalizeFontPreferences({ label: "rajdhani", badge: "orbitron" }), {
    ...DEFAULT_FONT_PREFERENCES,
    label: "rajdhani",
    badge: "orbitron"
  });
  assert.deepEqual(normalizeFontPreferences({ control: "openSans", ui: "orbitron" }), {
    ...DEFAULT_FONT_PREFERENCES,
    control: "openSans"
  });

  const storage = new MemoryStorage();
  storage.setItem(FONT_STORAGE_KEY, "not-json");
  assert.deepEqual(storedFontPreferences(storage), DEFAULT_FONT_PREFERENCES);
});

test("user scale is the only size lever and stays clamped", () => {
  assert.equal(clampUserScale(1.15), 1.15);
  assert.equal(clampUserScale(99), USER_SCALE_MAX);
  assert.equal(clampUserScale(-1), USER_SCALE_MIN);
  assert.equal(clampUserScale("nope"), DEFAULT_USER_SCALE);

  // Font options carry only a label + stack now — no per-font size/metric presets.
  for (const id of FONT_IDS) {
    assert.deepEqual(Object.keys(FONT_OPTIONS[id]).sort(), ["className", "label", "stack"]);
  }
});

test("saving preferences persists, applies root CSS variables, and dispatches one event", () => {
  const storage = new MemoryStorage();
  const doc = documentStub();
  const target = eventTargetStub();

  const preferences = setFontPreferences({
    control: "orbitron",
    heading: "openRing",
    label: "openRing",
    badge: "orbitron",
    site: "rajdhani",
    userScale: 1.2
  }, { doc, storage, eventTarget: target });

  assert.deepEqual(JSON.parse(storage.getItem(FONT_STORAGE_KEY)), preferences);
  assert.deepEqual(appliedFonts(doc), {
    control: fontStackFor("orbitron"),
    heading: fontStackFor("openRing"),
    label: fontStackFor("openRing"),
    badge: fontStackFor("orbitron")
  });
  // Body text follows the primary font rather than a standalone category.
  assert.equal(doc.styles.get("--orbit-font-body"), fontStackFor("rajdhani"));
  assert.equal(doc.styles.get("--type-user-scale"), "1.2");
  assert.equal(doc.styles.get("--type-family-scale"), undefined);
  assert.equal(doc.attributes.get("data-font-site"), "rajdhani");
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
  assert.throws(() => setFontPreference("body", "inter", { doc, storage, eventTarget: events }), /Unknown font target/);
  assert.throws(() => setFontPreference("heading", "missing", { doc, storage, eventTarget: events }), /Unknown font option/);

  let preferences = setSiteFont("openRing", { doc, storage, eventTarget: events });
  for (const key of ["control", "heading", "label", "badge", "site"]) {
    assert.equal(preferences[key], "openRing");
  }
  // Body text tracks the primary font, not a standalone target.
  assert.equal(doc.styles.get("--orbit-font-body"), fontStackFor("openRing"));

  preferences = setFontPreference("heading", "inter", { doc, storage, eventTarget: events });
  assert.equal(preferences.heading, "inter");
  assert.equal(preferences.site, "openRing");
  assert.equal(doc.styles.get("--orbit-font-heading"), fontStackFor("inter"));
  assert.equal(doc.styles.get("--orbit-font-body"), fontStackFor("openRing"));

  preferences = setUserScale(5, { doc, storage, eventTarget: events });
  assert.equal(preferences.userScale, USER_SCALE_MAX);
  assert.equal(doc.styles.get("--type-user-scale"), String(USER_SCALE_MAX));

  preferences = resetFontPreferences({ doc, storage, eventTarget: events });
  assert.deepEqual(preferences, DEFAULT_FONT_PREFERENCES);
  assert.deepEqual(appliedFonts(doc), defaultFontStacks());
  assert.equal(doc.styles.get("--type-user-scale"), "1");
  assert.equal(doc.attributes.get("data-font-site"), "inter");
});
