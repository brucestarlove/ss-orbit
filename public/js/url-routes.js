import { SETTINGS_TAB_IDS } from "./settings-tabs.js";

const EMPTY_ROUTE = Object.freeze({ boardSlug: "", view: "board", ticketId: "", tab: "" });

function emptyRoute() {
  return { ...EMPTY_ROUTE };
}

function normalizeLocation(input = globalThis.location) {
  if (typeof input === "string") {
    const url = new URL(input, "http://orbit.local");
    return { pathname: url.pathname || "/", search: url.search || "", hash: url.hash || "" };
  }
  return {
    pathname: input?.pathname || "/",
    search: input?.search || "",
    hash: input?.hash || ""
  };
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function routeSegments(value) {
  return String(value || "")
    .replace(/^#/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
}

function routeFromSegments(parts) {
  if (!parts.length) return null;

  const out = emptyRoute();
  let i = 0;

  if (parts[i] === "b") {
    if (!parts[i + 1]) return null;
    out.boardSlug = decodeSegment(parts[i + 1]);
    i += 2;
  } else if (parts[i] !== "t" && parts[i] !== "settings") {
    return null;
  }

  if (parts[i] === "t" && parts[i + 1]) {
    out.view = "ticket";
    out.ticketId = decodeSegment(parts[i + 1]);
  } else if (parts[i] === "settings") {
    out.view = "settings";
    const tab = parts[i + 1] ? decodeSegment(parts[i + 1]) : "";
    if (tab && SETTINGS_TAB_IDS.has(tab)) out.tab = tab;
  }

  return out;
}

export function parseLegacyHashRoute(hash) {
  const raw = String(hash || "");
  if (!raw || raw === "#" || raw === "#/") return null;
  return routeFromSegments(routeSegments(raw));
}

export function parseRoute(input = globalThis.location) {
  const loc = normalizeLocation(input);
  return parseLegacyHashRoute(loc.hash) || emptyRoute();
}

export function hasRoute(input = globalThis.location) {
  const loc = normalizeLocation(input);
  return Boolean(parseLegacyHashRoute(loc.hash));
}

export function buildRoute({ boardSlug = "", view = "board", ticketId = "", tab = "" } = {}) {
  const segs = [];
  if (boardSlug) segs.push("b", encodeURIComponent(boardSlug));
  if (view === "ticket" && ticketId) segs.push("t", encodeURIComponent(ticketId));
  else if (view === "settings") {
    segs.push("settings");
    if (tab && SETTINGS_TAB_IDS.has(tab)) segs.push(tab);
  }
  return "#/" + segs.join("/");
}

export function isCanonicalRouteUrl(input = globalThis.location, routeObj = parseRoute(input)) {
  const loc = normalizeLocation(input);
  return loc.hash === buildRoute(routeObj);
}
