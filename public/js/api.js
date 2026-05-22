// Network layer. `api()` is the single fetch wrapper used everywhere; it
// delegates raw I/O to transport.js (swappable per edition) and surfaces
// errors as toasts. Path helpers live here because they're shared by every
// caller regardless of transport.

import { state } from "./state.js";
import { toast } from "./toast.js";
import { request } from "./transport.js";

/** Bootstrap for the currently selected board (server opens the right DB). */
export function bootstrapPath() {
  const q = state.boardId
    ? `?board_id=${encodeURIComponent(state.boardId)}`
    : state.boardSlug
      ? `?board=${encodeURIComponent(state.boardSlug)}`
      : "";
  return `/api/bootstrap${q}`;
}

/** Append board_id for ticket/state/entry routes when the path has no board prefix. */
export function withBoardQuery(path) {
  if (!state.boardId || path.includes("board_id=")) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}board_id=${encodeURIComponent(state.boardId)}`;
}

export async function api(path, options = {}) {
  try {
    return await request({
      method: options.method || "GET",
      path,
      body: options.body,
      headers: options.headers
    });
  } catch (err) {
    toast.error(err.payload?.error || err.message || "Request failed");
    throw err;
  }
}
