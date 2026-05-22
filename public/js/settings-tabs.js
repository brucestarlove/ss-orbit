/** Settings drawer tab ids — must match URL segments `#/b/…/settings/:tab` and `settings.js` tab config. */
export const SETTINGS_TAB_IDS = new Set(["lanes", "appearance", "ai", "notes", "journal", "repository", "archive"]);

export function normalizeSettingsTab(raw) {
  if (!raw || !SETTINGS_TAB_IDS.has(raw)) return "lanes";
  return raw;
}
