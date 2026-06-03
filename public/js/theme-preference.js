export const THEME_STORAGE_KEY = "mab_theme";
export const THEME_CHANGE_EVENT = "orbit:theme-change";

const THEMES = new Set(["light", "dark"]);

function safeStorage(storage) {
  try {
    return storage ?? globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function safeDocument(doc) {
  try {
    return doc ?? globalThis.document ?? null;
  } catch {
    return null;
  }
}

function safeEventTarget(eventTarget) {
  try {
    return eventTarget ?? globalThis.window ?? null;
  } catch {
    return null;
  }
}

export function normalizeTheme(theme) {
  return THEMES.has(theme) ? theme : "light";
}

export function storedThemePreference(storage = safeStorage()) {
  const store = safeStorage(storage);
  const value = store?.getItem?.(THEME_STORAGE_KEY);
  return THEMES.has(value) ? value : null;
}

function systemTheme() {
  try {
    return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function currentTheme({ doc = safeDocument(), storage = safeStorage() } = {}) {
  const rootTheme = safeDocument(doc)?.documentElement?.getAttribute?.("data-theme");
  if (THEMES.has(rootTheme)) return rootTheme;
  return storedThemePreference(storage) ?? systemTheme();
}

export function applyStoredThemePreference({
  doc = safeDocument(),
  storage = safeStorage()
} = {}) {
  const theme = storedThemePreference(storage) ?? systemTheme();
  safeDocument(doc)?.documentElement?.setAttribute?.("data-theme", theme);
  return theme;
}

export function setThemePreference(theme, {
  doc = safeDocument(),
  storage = safeStorage(),
  eventTarget = safeEventTarget(),
  notify = true
} = {}) {
  const next = normalizeTheme(theme);
  safeDocument(doc)?.documentElement?.setAttribute?.("data-theme", next);
  safeStorage(storage)?.setItem?.(THEME_STORAGE_KEY, next);

  if (notify) {
    dispatchThemeChange(next, eventTarget);
  }

  return next;
}

export function toggleThemePreference(options = {}) {
  const next = currentTheme(options) === "dark" ? "light" : "dark";
  return setThemePreference(next, options);
}

function dispatchThemeChange(theme, eventTarget = safeEventTarget()) {
  const target = safeEventTarget(eventTarget);
  if (typeof target?.dispatchEvent !== "function") return;

  if (typeof CustomEvent === "function") {
    target.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme } }));
    return;
  }

  target.dispatchEvent({ type: THEME_CHANGE_EVENT, detail: { theme } });
}
