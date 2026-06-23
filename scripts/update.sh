#!/usr/bin/env bash
# Orbit self-update. Triggered only by POST /api/update when ORBIT_SELF_UPDATE=1.
#
# Pulls the latest code, reinstalls deps, rebuilds the production bundle, then
# signals the running server to exit so a process supervisor restarts it on the
# new build. THIS ONLY WORKS UNDER A SUPERVISOR THAT AUTO-RESTARTS the process
# (systemd `Restart=always`, pm2, `docker compose` restart policy, etc.). Run
# from a git checkout — Docker images carry no git tree and update by rebuild.
#
# Your board data lives in ORBIT_DATA_DIR (default ~/.orbit, /data in Docker),
# outside the repo, so updating never touches it.
set -euo pipefail

REPO_DIR="${ORBIT_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG="${ORBIT_DATA_DIR:-$HOME/.orbit}/update.log"
mkdir -p "$(dirname "$LOG")"

{
  echo "=== orbit self-update $(date -u +%FT%TZ) ==="
  cd "$REPO_DIR"

  echo "[1/3] git pull --ff-only"
  git pull --ff-only

  echo "[2/3] install dependencies"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install
  else
    npm install
  fi

  echo "[3/3] build production bundle"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm run build:bundle
  else
    npm run build:bundle
  fi

  echo "build complete"
} >>"$LOG" 2>&1

# Restart: ask the running server to exit; the supervisor brings it back on the
# freshly built code. Without a supervisor the app simply stops — restart it
# manually. Give the HTTP 202 a moment to flush before the parent dies.
if [[ -n "${ORBIT_SERVER_PID:-}" ]]; then
  ( sleep 2; kill "$ORBIT_SERVER_PID" >/dev/null 2>&1 || true ) &
fi
