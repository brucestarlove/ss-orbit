export const REDUCE_MOTION_STORAGE_KEY = "mab_reduce_motion";

function safeStorage(storage) {
  try {
    return storage ?? globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function defaultMediaMatcher(query) {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query)
    : { matches: false };
}

export function storedReducedMotionPreference(storage = safeStorage()) {
  const store = safeStorage(storage);
  const value = store?.getItem?.(REDUCE_MOTION_STORAGE_KEY);
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function browserPrefersReducedMotion(mediaMatcher = defaultMediaMatcher) {
  try {
    return !!mediaMatcher("(prefers-reduced-motion: reduce)")?.matches;
  } catch {
    return false;
  }
}

export function effectiveReducedMotionPreference({ storage = safeStorage(), mediaMatcher = defaultMediaMatcher } = {}) {
  const stored = storedReducedMotionPreference(storage);
  return stored ?? browserPrefersReducedMotion(mediaMatcher);
}

export function setReducedMotionPreference(reduce, storage = safeStorage()) {
  const store = safeStorage(storage);
  const value = reduce ? "true" : "false";
  store?.setItem?.(REDUCE_MOTION_STORAGE_KEY, value);
  return reduce;
}

export function applyReducedMotionPreference({
  doc = globalThis.document,
  storage = safeStorage(),
  mediaMatcher = defaultMediaMatcher
} = {}) {
  const reduce = effectiveReducedMotionPreference({ storage, mediaMatcher });
  doc?.documentElement?.setAttribute("data-reduced-motion", reduce ? "reduce" : "allow");
  return reduce;
}
