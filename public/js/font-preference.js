export const FONT_STORAGE_KEY = "orbit_font_preferences";
export const FONT_CHANGE_EVENT = "orbit:font-preference-change";

// Inter is the primary content font. App chrome and labels default to Orbitron,
// while the site font drives global font metrics such as size, spacing, and
// line-height.
export const DEFAULT_SITE_FONT = "inter";
export const DEFAULT_USER_SCALE = 1;
export const USER_SCALE_MIN = 0.85;
export const USER_SCALE_MAX = 1.3;
export const USER_SCALE_STEP = 0.05;
export const DEFAULT_FONT_LETTER_SPACING = "0.3px";
export const DEFAULT_FONT_LINE_HEIGHT = "normal";

export const SITE_FONT_OPTIONS = Object.freeze([
  "inter",
  "openSans",
  "jetBrainsMono",
  "chakraPetch",
  "orbitron",
  "rajdhani",
  "runescapeUF",
  // TEMP — local font trial only; revert this block before committing/release.
  "openRing"
]);

export const FONT_OPTIONS = Object.freeze({
  inter: {
    label: "Inter",
    stack: "\"Orbit Inter\", \"Inter\", \"Segoe UI Variable\", \"Segoe UI\", Arial, sans-serif",
    className: "font-inter",
    scale: 1
  },
  openSans: {
    label: "Open Sans",
    stack: "\"Orbit Open Sans\", \"Open Sans\", \"Segoe UI Variable\", \"Segoe UI\", Arial, sans-serif",
    className: "font-open-sans",
    scale: 1
  },
  jetBrainsMono: {
    label: "JetBrains Mono",
    stack: "\"Orbit JetBrains Mono\", \"JetBrains Mono\", \"Cascadia Mono\", \"SFMono-Regular\", Consolas, monospace",
    className: "font-jetbrains-mono",
    scale: 1
  },
  chakraPetch: {
    label: "Chakra Petch",
    stack: "\"Orbit Chakra Petch\", \"Chakra Petch\", \"Segoe UI Variable\", \"Segoe UI\", Arial, sans-serif",
    className: "font-chakra-petch",
    scale: 1
  },
  orbitron: {
    label: "Orbitron",
    stack: "\"Orbit Orbitron\", \"Orbitron\", \"Segoe UI Variable\", \"Segoe UI\", Arial, sans-serif",
    className: "font-orbitron",
    scale: 1
  },
  rajdhani: {
    label: "Rajdhani",
    stack: "\"Orbit Rajdhani\", \"Rajdhani\", \"Segoe UI Variable\", \"Segoe UI\", Arial, sans-serif",
    className: "font-rajdhani",
    scale: 1
  },
  runescapeUF: {
    label: "Runescape UF",
    stack: "\"Orbit Runescape UF\", \"Cascadia Mono\", monospace",
    className: "font-runescape-uf",
    scale: 0.95
  },
  openRing: {
    label: "Open Ring",
    stack: "\"Orbit Open Ring\", \"Segoe UI Variable\", \"Segoe UI\", Arial, sans-serif",
    scale: 1.2,
    letterSpacing: "0.4px"
  }
});

export const FONT_TARGETS = Object.freeze({
  ui: {
    label: "App chrome",
    cssVar: "--orbit-font-ui",
    dataAttr: "fontUi"
  },
  heading: {
    label: "Headings",
    cssVar: "--orbit-font-heading",
    dataAttr: "fontHeading"
  },
  body: {
    label: "Paragraphs & descriptions",
    cssVar: "--orbit-font-body",
    dataAttr: "fontBody"
  },
  prose: {
    label: "Prose / editor",
    cssVar: "--orbit-font-prose",
    dataAttr: "fontProse"
  },
  label: {
    label: "Labels",
    cssVar: "--orbit-font-label",
    dataAttr: "fontLabel"
  }
});

export const DEFAULT_FONT_TARGET_PREFERENCES = Object.freeze({
  ui: "orbitron",
  heading: DEFAULT_SITE_FONT,
  body: DEFAULT_SITE_FONT,
  prose: DEFAULT_SITE_FONT,
  label: "orbitron"
});

export const DEFAULT_FONT_PREFERENCES = Object.freeze({
  ...DEFAULT_FONT_TARGET_PREFERENCES,
  // Primary site font (drives the global --type-family-scale).
  site: DEFAULT_SITE_FONT,
  // User size slider multiplier (drives --type-user-scale).
  userScale: DEFAULT_USER_SCALE
});

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function clampUserScale(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_USER_SCALE;
  return Math.min(USER_SCALE_MAX, Math.max(USER_SCALE_MIN, number));
}

export function normalizeFontPreferences(value) {
  const input = value && typeof value === "object" ? value : {};
  const normalized = { ...DEFAULT_FONT_PREFERENCES };
  for (const key of Object.keys(FONT_TARGETS)) {
    if (typeof input[key] === "string" && hasOwn(FONT_OPTIONS, input[key])) {
      normalized[key] = input[key];
    }
  }
  if (typeof input.site === "string" && hasOwn(FONT_OPTIONS, input.site)) {
    normalized.site = input.site;
  }
  if (input.userScale !== undefined) {
    normalized.userScale = clampUserScale(input.userScale);
  }
  return normalized;
}

export function storedFontPreferences(storage = globalThis.localStorage) {
  if (!storage) return { ...DEFAULT_FONT_PREFERENCES };
  try {
    const raw = storage.getItem(FONT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_FONT_PREFERENCES };
    return normalizeFontPreferences(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_FONT_PREFERENCES };
  }
}

export function fontStackFor(optionId) {
  return FONT_OPTIONS[optionId]?.stack || FONT_OPTIONS[DEFAULT_SITE_FONT].stack;
}

// Per-font preset size scaler. Naturally-large fonts ship a value < 1 so they
// default to a comfortable size; fonts without a preset render at 1.
export function fontScaleFor(optionId) {
  const scale = FONT_OPTIONS[optionId]?.scale;
  return typeof scale === "number" && scale > 0 ? scale : 1;
}

export function fontLetterSpacingFor(optionId) {
  return FONT_OPTIONS[optionId]?.letterSpacing || DEFAULT_FONT_LETTER_SPACING;
}

export function fontLineHeightFor(optionId) {
  return FONT_OPTIONS[optionId]?.lineHeight || DEFAULT_FONT_LINE_HEIGHT;
}

export function applyFontPreferences(preferences = storedFontPreferences(), { doc = globalThis.document } = {}) {
  const normalized = normalizeFontPreferences(preferences);
  const root = doc?.documentElement;
  if (!root) return normalized;

  for (const [target, config] of Object.entries(FONT_TARGETS)) {
    const optionId = normalized[target];
    root.style?.setProperty?.(config.cssVar, fontStackFor(optionId));
    root.setAttribute?.(`data-${config.dataAttr.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`, optionId);
  }

  // The two size multipliers: the active site font's preset, and the slider.
  root.style?.setProperty?.("--type-family-scale", String(fontScaleFor(normalized.site)));
  root.style?.setProperty?.("--type-user-scale", String(normalized.userScale));
  root.style?.setProperty?.("--orbit-letter-spacing", fontLetterSpacingFor(normalized.site));
  root.style?.setProperty?.("--orbit-line-height", fontLineHeightFor(normalized.site));
  root.setAttribute?.("data-font-site", normalized.site);
  return normalized;
}

export function setFontPreferences(preferences, {
  doc = globalThis.document,
  storage = globalThis.localStorage,
  eventTarget = globalThis.window
} = {}) {
  const normalized = normalizeFontPreferences(preferences);
  storage?.setItem?.(FONT_STORAGE_KEY, JSON.stringify(normalized));
  applyFontPreferences(normalized, { doc });
  eventTarget?.dispatchEvent?.(new CustomEvent(FONT_CHANGE_EVENT, { detail: { preferences: normalized } }));
  return normalized;
}

export function resetFontPreferences(options = {}) {
  options.storage?.removeItem?.(FONT_STORAGE_KEY);
  return setFontPreferences(DEFAULT_FONT_PREFERENCES, options);
}

export function setFontPreference(target, optionId, options = {}) {
  if (!hasOwn(FONT_TARGETS, target)) throw new Error(`Unknown font target: ${target}`);
  if (!hasOwn(FONT_OPTIONS, optionId)) throw new Error(`Unknown font option: ${optionId}`);
  return setFontPreferences({ ...storedFontPreferences(options.storage), [target]: optionId }, options);
}

// Swap the whole site to a primary font: sets every target plus the `site`
// driver (so --type-family-scale follows). Per-target overrides can be applied
// afterward via setFontPreference.
export function setSiteFont(optionId, options = {}) {
  if (!hasOwn(FONT_OPTIONS, optionId)) throw new Error(`Unknown font option: ${optionId}`);
  const next = { ...storedFontPreferences(options.storage) };
  for (const target of Object.keys(FONT_TARGETS)) next[target] = optionId;
  next.site = optionId;
  return setFontPreferences(next, options);
}

export function setUserScale(value, options = {}) {
  return setFontPreferences(
    { ...storedFontPreferences(options.storage), userScale: clampUserScale(value) },
    options
  );
}

export function applyStoredFontPreferences(options = {}) {
  return applyFontPreferences(storedFontPreferences(options.storage), options);
}
