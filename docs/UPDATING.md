# Updating Orbit

Orbit checks GitHub for a newer version and surfaces it in the app:

- a purple dot on the **Settings** button in the topbar,
- a one-time toast on load (**“Orbit vX.Y.Z is available →”**), and
- a **Version & Updates** card at the top of **Settings → Data** with the
  current version, a **Check now** button, a **Back up all boards** button, and
  the exact commands for your deployment.

The check reads the `version` field of `package.json` on the project's default
branch. Your board data lives in `DATA_DIR` (default `~/.orbit`, `/data` in
Docker) — **outside** the app folder — so updating never touches it. Even so,
the card nudges you to **back up all boards** to a ZIP first.

---

## Before you update: back up

Settings → Data → **Version & Updates → Back up all boards**, or the Board chip
→ **Export → Export All**. Both download a single ZIP of every board's
`.orbit.json` snapshot.

---

## Update flows

### Local machine or your own server (git checkout)

```sh
git pull
pnpm install
pnpm run build:bundle   # rebuild the production bundle dist/full
# then restart Orbit (re-run `orbit serve` / `pnpm dev`, or your service)
```

The rebuild matters: when `dist/full` exists, Orbit serves it instead of raw
`public/` sources, so a `git pull` alone won't show new UI.

### Docker

No image is published to a registry yet, so update by rebuilding from source:

```sh
git pull
docker compose build      # or: docker build -t orbit .
docker compose up -d      # or restart your `docker run` container
```

Your boards persist in the `/data` volume across the rebuild.

### Global npm install

```sh
npm install -g @starlove/orbit@latest
# then restart Orbit
```

---

## One-click self-update (opt-in, advanced)

If you run Orbit from a git checkout **under a process supervisor that
auto-restarts it**, you can enable a **Update now** button that performs the
pull + rebuild + restart for you.

Set `ORBIT_SELF_UPDATE=1` in the server environment. The button then appears in
the Version & Updates card whenever an update is available and calls
`POST /api/update`, which runs [`scripts/update.sh`](../scripts/update.sh).
Without the flag the endpoint returns `404` and the button stays hidden.

The script pulls, reinstalls, runs `build:bundle`, writes a log to
`DATA_DIR/update.log`, then signals the server process to exit so the
supervisor restarts it on the new build. **It only works if something restarts
the process** — otherwise Orbit simply stops and you restart it yourself.

Example systemd unit (`/etc/systemd/system/orbit.service`):

```ini
[Unit]
Description=Starscape Orbit
After=network.target

[Service]
WorkingDirectory=/home/you/apps/ss-orbit
ExecStart=/usr/bin/node src/server.js
Environment=NODE_ENV=production
Environment=ORBIT_SELF_UPDATE=1
Restart=always
RestartSec=2
User=you

[Install]
WantedBy=multi-user.target
```

`Restart=always` is what turns the script's "exit" into a clean restart on the
updated code.

---

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `ORBIT_UPDATE_CHECK` | on | Set `0` to disable the update check entirely. |
| `ORBIT_UPDATE_TTL` | `60` | Minutes the server caches the GitHub result. |
| `ORBIT_UPDATE_BRANCH` | `master` | Branch whose `package.json` version is read. |
| `ORBIT_GITHUB_TOKEN` | — | Optional PAT for private repos / higher rate limit. |
| `ORBIT_SELF_UPDATE` | off | Set `1` to enable the gated `POST /api/update`. |

The server fetches GitHub's contents API (not the raw CDN), so the result isn't
stale-cached upstream; freshness is governed by `ORBIT_UPDATE_TTL`, and
**Check now** bypasses it (`/api/version?refresh=1`).
