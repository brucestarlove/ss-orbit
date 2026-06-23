// Update checking. The server reads its own version from package.json and
// compares it against the `version` field of package.json on the project's
// GitHub default branch. We hit the GitHub *contents API* (not the raw CDN):
// it honours conditional requests / no-cache so the answer is authoritative,
// and because only the server polls — not every browser — GitHub's 60 req/hr
// unauthenticated limit is a non-issue. Results are cached in-memory for
// ORBIT_UPDATE_TTL minutes; `force` bypasses the cache for a "Check now".
//
// Env:
//   ORBIT_UPDATE_CHECK=0    disable the check entirely (returns enabled:false)
//   ORBIT_UPDATE_TTL=<min>  cache lifetime, default 60
//   ORBIT_UPDATE_BRANCH     branch to read, default the repo default (master)
//   ORBIT_GITHUB_TOKEN      optional PAT (private repos / higher rate limit)
//   ORBIT_SELF_UPDATE=1     enable the gated POST /api/update self-update
//   ORBIT_DOCKER=1          force "docker" deploy mode

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ROOT_DIR, DATA_DIR } from "./paths.js";

const DEFAULT_OWNER = "brucestarlove";
const DEFAULT_REPO = "ss-orbit";
const CHECK_TIMEOUT_MS = 5000;

let pkgCache = null;
function readPackage() {
  if (pkgCache) return pkgCache;
  try {
    pkgCache = JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf8"));
  } catch {
    pkgCache = {};
  }
  return pkgCache;
}

/** Parse owner/repo out of package.json repository.url, falling back to the
 *  known Orbit repo so the check still works on odd checkouts. */
function repoCoordinates() {
  const url = readPackage()?.repository?.url || "";
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  return { owner: match?.[1] || DEFAULT_OWNER, repo: match?.[2] || DEFAULT_REPO };
}

function localVersion() {
  return readPackage()?.version || "0.0.0";
}

function updateBranch() {
  return process.env.ORBIT_UPDATE_BRANCH || "master";
}

/** How this instance is running, which decides the update instructions the
 *  client shows. Docker images carry no git tree, so they're rebuild-only. */
function detectDeployMode() {
  if (process.env.ORBIT_DOCKER === "1" || existsSync("/.dockerenv")) return "docker";
  if (existsSync(join(ROOT_DIR, ".git"))) return "source";
  return "dist";
}

/** Numeric "a.b.c" comparison (ignores any prerelease suffix). Returns true
 *  when `latest` is strictly newer than `current`. */
function isNewer(latest, current) {
  const parse = (v) => String(v).replace(/^v/, "").split(/[.+-]/).map((n) => Number(n) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

async function fetchLatestVersion() {
  const { owner, repo } = repoCoordinates();
  const branch = updateBranch();
  const headers = {
    Accept: "application/vnd.github.raw+json",
    "User-Agent": "orbit-update-check"
  };
  if (process.env.ORBIT_GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.ORBIT_GITHUB_TOKEN}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/package.json?ref=${encodeURIComponent(branch)}`,
      { headers, signal: controller.signal, cache: "no-store" }
    );
    if (res.status === 403 || res.status === 429) return { error: "rate_limited" };
    if (!res.ok) return { error: `http_${res.status}` };
    const pkg = JSON.parse(await res.text());
    if (!pkg?.version) return { error: "no_version" };
    return { latest: String(pkg.version) };
  } catch (err) {
    return { error: err?.name === "AbortError" ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

let cache = null; // { at: epochMs, payload }

function staticPayload(extra) {
  const { owner, repo } = repoCoordinates();
  const branch = updateBranch();
  return {
    current: localVersion(),
    deployMode: detectDeployMode(),
    selfUpdate: process.env.ORBIT_SELF_UPDATE === "1",
    repoUrl: `https://github.com/${owner}/${repo}`,
    changesUrl: `https://github.com/${owner}/${repo}/commits/${branch}`,
    ...extra
  };
}

/** Get current/latest version info, cached for ORBIT_UPDATE_TTL minutes.
 *  Never throws — network problems surface as `{ error, updateAvailable:false }`. */
export async function getVersionInfo({ force = false } = {}) {
  if (process.env.ORBIT_UPDATE_CHECK === "0") {
    return staticPayload({ enabled: false, latest: null, updateAvailable: false, error: null, checkedAt: null });
  }

  const ttlMs = (Number(process.env.ORBIT_UPDATE_TTL) || 60) * 60 * 1000;
  if (!force && cache && Date.now() - cache.at < ttlMs) return cache.payload;

  const result = await fetchLatestVersion();
  const current = localVersion();
  const payload = staticPayload({
    enabled: true,
    latest: result.latest ?? null,
    updateAvailable: Boolean(result.latest) && isNewer(result.latest, current),
    error: result.error ?? null,
    checkedAt: new Date().toISOString()
  });
  cache = { at: Date.now(), payload };
  return payload;
}

/** Kick off scripts/update.sh detached and hand back immediately. Only ever
 *  reached when ORBIT_SELF_UPDATE=1 (the router gates the route). The script
 *  rebuilds and then signals this process so a supervisor restarts it. */
export function startSelfUpdate() {
  const script = join(ROOT_DIR, "scripts", "update.sh");
  if (!existsSync(script)) return { started: false, error: "script_missing" };
  const child = spawn("bash", [script], {
    cwd: ROOT_DIR,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ORBIT_REPO_DIR: ROOT_DIR, ORBIT_SERVER_PID: String(process.pid), ORBIT_DATA_DIR: DATA_DIR }
  });
  child.unref();
  return { started: true };
}
