import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REDUCE_MOTION_STORAGE_KEY,
  applyReducedMotionPreference,
  browserPrefersReducedMotion,
  effectiveReducedMotionPreference,
  setReducedMotionPreference,
  storedReducedMotionPreference
} from "../public/js/motion-preference.js";

class MemoryStorage {
  #items = new Map();
  getItem(key) { return this.#items.has(key) ? this.#items.get(key) : null; }
  setItem(key, value) { this.#items.set(key, String(value)); }
  removeItem(key) { this.#items.delete(key); }
}

function mediaMatcher(matches) {
  return () => ({ matches });
}

test("reduced motion defaults to browser preference when no setting is stored", () => {
  const storage = new MemoryStorage();

  assert.equal(storedReducedMotionPreference(storage), null);
  assert.equal(browserPrefersReducedMotion(mediaMatcher(true)), true);
  assert.equal(effectiveReducedMotionPreference({ storage, mediaMatcher: mediaMatcher(true) }), true);
  assert.equal(effectiveReducedMotionPreference({ storage, mediaMatcher: mediaMatcher(false) }), false);
});

test("stored reduced motion preference overrides browser default", () => {
  const storage = new MemoryStorage();

  setReducedMotionPreference(false, storage);
  assert.equal(storage.getItem(REDUCE_MOTION_STORAGE_KEY), "false");
  assert.equal(storedReducedMotionPreference(storage), false);
  assert.equal(effectiveReducedMotionPreference({ storage, mediaMatcher: mediaMatcher(true) }), false);

  setReducedMotionPreference(true, storage);
  assert.equal(storage.getItem(REDUCE_MOTION_STORAGE_KEY), "true");
  assert.equal(storedReducedMotionPreference(storage), true);
  assert.equal(effectiveReducedMotionPreference({ storage, mediaMatcher: mediaMatcher(false) }), true);
});

test("applyReducedMotionPreference writes the effective motion state to the document", () => {
  const storage = new MemoryStorage();
  const attributes = new Map();
  const doc = {
    documentElement: {
      setAttribute(name, value) { attributes.set(name, value); }
    }
  };

  applyReducedMotionPreference({ doc, storage, mediaMatcher: mediaMatcher(true) });
  assert.equal(attributes.get("data-reduced-motion"), "reduce");

  setReducedMotionPreference(false, storage);
  applyReducedMotionPreference({ doc, storage, mediaMatcher: mediaMatcher(true) });
  assert.equal(attributes.get("data-reduced-motion"), "allow");
});
