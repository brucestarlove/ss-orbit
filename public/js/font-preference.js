export const FONT_STORAGE_KEY = "orbit_font_preferences";
export const FONT_CHANGE_EVENT = "orbit:font-preference-change";

// Inter is the default site font and for most categories; badges default to
// Orbitron. The site font drives global font metrics such as size, spacing,
// and line-height.
export const DEFAULT_SITE_FONT = "inter";
export const DEFAULT_BADGE_FONT = "orbitron";
export const DEFAULT_USER_SCALE = 1;
export const USER_SCALE_MIN = 0.85;
export const USER_SCALE_MAX = 1.3;
export const USER_SCALE_STEP = 0.05;

export const SITE_FONT_OPTIONS = Object.freeze([
  "inter",
  "openSans",
  "jetBrainsMono",
  "chakraPetch",
  "orbitron",
  "rajdhani",
  "runescapeUF",
  "openRing"
]);

export const FONT_OPTIONS = Object.freeze({
  inter: {
    label: "Inter",
    stack: "\"Orbit Inter\", \"Inter\", \"Segoe UI Variable\", \"Segoe UI\", Arial, sans-serif",
    className: "font-inter"
  },
  openSans: {
    label: "Open Sans",
    stack: "\"Orbit Open Sans\", \"Open Sans\", \"Segoe UI Variable\", \"Segoe UI\", Arial, sans-serif",
    className: "font-open-sans"
  },
  jetBrainsMono: {
    label: "JetBrains Mono",
    stack: "\"Orbit JetBrains Mono\", \"JetBrains Mono\", \"Cascadia Mono\", \"SFMono-Regular\", Consolas, monospace",
    className: "font-jetbrains-mono"
  },
  chakraPetch: {
    label: "Chakra Petch",
    stack: "\"Orbit Chakra Petch\", \"Chakra Petch\", \"Segoe UI Variable\", \"Segoe UI\", Arial, sans-serif",
    className: "font-chakra-petch"
  },
  orbitron: {
    label: "Orbitron",
    stack: "\"Orbit Orbitron\", \"Orbitron\", \"Segoe UI Variable\", \"Segoe UI\", Arial, sans-serif",
    className: "font-orbitron"
  },
  rajdhani: {
    label: "Rajdhani",
    stack: "\"Orbit Rajdhani\", \"Rajdhani\", \"Segoe UI Variable\", \"Segoe UI\", Arial, sans-serif",
    className: "font-rajdhani"
  },
  runescapeUF: {
    label: "Runescape UF",
    stack: "\"Orbit Runescape UF\", \"Cascadia Mono\", monospace",
    className: "font-runescape-uf"
  },
  openRing: {
    label: "Open Ring",
    stack: "\"Orbit Open Ring\", \"Segoe UI Variable\", \"Segoe UI\", Arial, sans-serif",
    className: "font-open-ring"
  }
});

// Per-category overrides shown in the Appearance grid. Body text is not a
// target: it always follows the primary font (`site`), so it drives
// --orbit-font-body directly in applyFontPreferences instead.
export const FONT_TARGETS = Object.freeze({
  heading: {
    label: "Headings",
    cssVar: "--orbit-font-heading",
    dataAttr: "fontHeading"
  },
  control: {
    label: "Controls",
    cssVar: "--orbit-font-control",
    dataAttr: "fontControl"
  },
  label: {
    label: "Labels",
    cssVar: "--orbit-font-label",
    dataAttr: "fontLabel"
  },
  badge: {
    label: "Badges",
    cssVar: "--orbit-font-badge",
    dataAttr: "fontBadge"
  }
});

export const LEGACY_FONT_TARGET_ALIASES = Object.freeze({
  ui: "control"
});

export const DEFAULT_FONT_TARGET_PREFERENCES = Object.freeze({
  control: DEFAULT_SITE_FONT,
  heading: DEFAULT_SITE_FONT,
  label: DEFAULT_SITE_FONT,
  badge: DEFAULT_BADGE_FONT
});

export const DEFAULT_FONT_PREFERENCES = Object.freeze({
  ...DEFAULT_FONT_TARGET_PREFERENCES,
  // Primary font: drives body text and the default for every override category.
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
  const explicitTargets = new Set();
  for (const key of Object.keys(FONT_TARGETS)) {
    if (typeof input[key] === "string" && hasOwn(FONT_OPTIONS, input[key])) {
      normalized[key] = input[key];
      explicitTargets.add(key);
    }
  }
  for (const [legacyKey, target] of Object.entries(LEGACY_FONT_TARGET_ALIASES)) {
    if (!explicitTargets.has(target) && typeof input[legacyKey] === "string" && hasOwn(FONT_OPTIONS, input[legacyKey])) {
      normalized[target] = input[legacyKey];
    }
  }
  if (typeof input.site === "string" && hasOwn(FONT_OPTIONS, input.site)) {
    normalized.site = input.site;
  }
  if (input.userScale !== undefined) {
    normalized.userScale = clampUserScale(input.userScale);
  }
  // Before the split, one "label" target drove both categories. Preserve a
  // customized label choice for badges unless badge was saved separately.
  if (!hasOwn(input, "badge") && hasOwn(input, "label") && input.label !== DEFAULT_SITE_FONT) {
    normalized.badge = normalized.label;
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

export function applyFontPreferences(preferences = storedFontPreferences(), { doc = globalThis.document } = {}) {
  const normalized = normalizeFontPreferences(preferences);
  const root = doc?.documentElement;
  if (!root) return normalized;

  for (const [target, config] of Object.entries(FONT_TARGETS)) {
    const optionId = normalized[target];
    root.style?.setProperty?.(config.cssVar, fontStackFor(optionId));
    root.setAttribute?.(`data-${config.dataAttr.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`, optionId);
  }

  // Body text (paragraphs, card titles, long-form prose, editors) always tracks
  // the primary font rather than being an independent category.
  root.style?.setProperty?.("--orbit-font-body", fontStackFor(normalized.site));
  // The only size lever is the Appearance slider; font family no longer changes size.
  root.style?.setProperty?.("--type-user-scale", String(normalized.userScale));
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
// driver. Per-target overrides can be applied afterward via setFontPreference.
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
