#!/usr/bin/env node
// Tiny static server for testing dist/site/ before deploying. Serves files
// with correct MIME types and the same /app/ rewrite Vercel will apply.

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "dist", "site");
const PORT = Number(process.env.PORT || 4310);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".map": "application/json"
};

if (!existsSync(ROOT)) {
  console.error(`Missing ${ROOT}. Run "npm run build" first.`);
  process.exit(1);
}

createServer((req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (pathname === "/install" || pathname === "/install/" || pathname === "/support" || pathname === "/support/") pathname = "/index.html";
  if (pathname === "/app" || pathname === "/app/") pathname = "/app/index.html";
  if (pathname.endsWith("/")) pathname += "index.html";
  const filePath = join(ROOT, pathname);
  if (!filePath.startsWith(ROOT) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}).listen(PORT, () => {
  console.log(`Serving dist/site at http://localhost:${PORT}`);
  console.log(`  /        marketing landing`);
  console.log(`  /app/    preview kanban`);
});
