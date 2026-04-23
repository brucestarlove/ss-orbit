// Request transport. The full edition talks to the Orbit HTTP server; a
// preview build will replace this module (or branch on `edition`) to dispatch
// the same path/body shapes to a local IndexedDB backend. Keep this file
// I/O-only — UI concerns (toasts, redirects) belong in api.js callers.

export async function request({ method = "GET", path, body, headers }) {
  const finalHeaders = { "Content-Type": "application/json", ...(headers || {}) };
  const response = await fetch(path, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(payload.error || response.statusText);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}
