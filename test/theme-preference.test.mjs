import { test } from "node:test";
import assert from "node:assert/strict";

import {
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
  applyStoredThemePreference,
  currentTheme,
  setThemePreference,
  storedThemePreference,
  toggleThemePreference
} from "../public/js/theme-preference.js";

class MemoryStorage {
  #items = new Map();
  getItem(key) { return this.#items.has(key) ? this.#items.get(key) : null; }
  setItem(key, value) { this.#items.set(key, String(value)); }
  removeItem(key) { this.#items.delete(key); }
}

function documentStub(initialTheme = null) {
  const attributes = new Map();
  if (initialTheme !== null) attributes.set("data-theme", initialTheme);

  return {
    attributes,
    documentElement: {
      getAttribute(name) { return attributes.get(name) ?? null; },
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

test("theme preference defaults to light when nothing is stored or applied", () => {
  const storage = new MemoryStorage();
  const doc = documentStub();

  assert.equal(storedThemePreference(storage), null);
  assert.equal(currentTheme({ doc, storage }), "light");
});

test("stored theme is applied to the document", () => {
  const storage = new MemoryStorage();
  const doc = documentStub();
  storage.setItem(THEME_STORAGE_KEY, "dark");

  assert.equal(applyStoredThemePreference({ doc, storage }), "dark");
  assert.equal(doc.attributes.get("data-theme"), "dark");
});

test("setting a theme persists, applies, and notifies", () => {
  const storage = new MemoryStorage();
  const doc = documentStub();
  const target = eventTargetStub();

  setThemePreference("dark", { doc, storage, eventTarget: target });

  assert.equal(storage.getItem(THEME_STORAGE_KEY), "dark");
  assert.equal(doc.attributes.get("data-theme"), "dark");
  assert.equal(target.events.length, 1);
  assert.equal(target.events[0].type, THEME_CHANGE_EVENT);
  assert.deepEqual(target.events[0].detail, { theme: "dark" });
});

test("theme toggles from the effective current theme", () => {
  const storage = new MemoryStorage();
  const doc = documentStub("dark");

  assert.equal(toggleThemePreference({ doc, storage, eventTarget: eventTargetStub() }), "light");
  assert.equal(doc.attributes.get("data-theme"), "light");
  assert.equal(storage.getItem(THEME_STORAGE_KEY), "light");
});
