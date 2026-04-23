import { createServer } from "node:http";
import {
  boardRuntime,
  handleApi,
  serveStatic,
  sendEmpty,
  sendJson,
  startSSEStream,
  startupSummary
} from "./core/board.js";

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      sendEmpty(res, 204);
      return;
    }

    if (url.pathname === "/api/events/stream" && req.method === "GET") {
      startSSEStream(req, res, url);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    if (error.status) {
      sendJson(res, error.status, { error: error.code || "request_error", message: error.message });
      return;
    }
    sendJson(res, 500, { error: "internal_error", message: error.message });
  }
});

const summary = startupSummary();
server.listen(boardRuntime.port, () => {
  console.log(`Starscape Orbit listening on ${summary.url}`);
  console.log(`Registry: ${summary.registryPath}`);
  console.log(`Boards (${summary.boardCount}):`);
  for (const path of summary.boardPaths) console.log(`  - ${path}`);
});
