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
import { closeAllConnections } from "./core/db.js";

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

const requestedPort = boardRuntime.port;
const hasExplicitPort = Boolean(process.env.PORT);
const maxAutoPort = requestedPort + 99;
let currentPort = requestedPort;

server.on("error", (error) => {
  if (!hasExplicitPort && error?.code === "EADDRINUSE" && currentPort < maxAutoPort) {
    currentPort += 1;
    console.warn(`[orbit] Port ${currentPort - 1} is in use; trying ${currentPort}.`);
    server.listen(currentPort);
    return;
  }

  console.error(error);
  closeAllConnections();
  process.exit(1);
});

server.listen(currentPort);

server.on("listening", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : currentPort;
  const summary = startupSummary(port);
  console.log(`Starscape Orbit listening on ${summary.url}`);
  console.log(`Registry: ${summary.registryPath}`);
  console.log(`Boards (${summary.boardCount}):`);
  for (const path of summary.boardPaths) console.log(`  - ${path}`);
});

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    closeAllConnections();
    process.exit(0);
  });
  setTimeout(() => {
    closeAllConnections();
    process.exit(0);
  }, 1500).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.once("exit", () => closeAllConnections());
