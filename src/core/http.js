import { readFile } from "node:fs/promises";
import { extname, resolve as resolvePath } from "node:path";
import { PUBLIC_DIR } from "./paths.js";
import { httpError } from "./util.js";

export function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization,X-Orbit-Actor-Type,X-Orbit-Actor-Name,X-Orbit-Actor-Id,X-Orbit-Agent-Name"
  );
}

export function sendJson(res, status, body) {
  setCors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

export function sendEmpty(res, status) {
  setCors(res);
  res.writeHead(status);
  res.end();
}

export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw httpError(413, "payload_too_large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "invalid_json");
  }
}

function contentType(filePath) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml"
  };
  return types[extname(filePath)] || "application/octet-stream";
}

export async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendEmpty(res, 405);
    return;
  }

  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolvePath(PUBLIC_DIR, `.${decodeURIComponent(requested)}`);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendEmpty(res, 403);
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-store"
    });
    if (req.method !== "HEAD") res.end(data);
    else res.end();
  } catch {
    if (pathname !== "/") {
      await serveStatic(req, res, "/");
    } else {
      sendEmpty(res, 404);
    }
  }
}
