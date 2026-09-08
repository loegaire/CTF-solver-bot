# Deployment and Operations

## 1. Local: `run.sh` (the on/off switch)

`./run.sh` is the single entry point on any machine — no SSH logic inside;
it works wherever the repo lives.

```bash
./run.sh          # ON:  full teardown of anything old, then start fresh
./run.sh stop     # OFF: full teardown — processes killed, systemd unit
                  #      hard-deleted, agent runs killed. Nothing left behind.
./run.sh status   # state of the running worker
./run.sh logs     # tail the log (ctf-worker.log)
```

Every start does a **full teardown** first (idempotent redeploy):

1. `ctf-worker` systemd service (if present): stopped, disabled, unit file
   hard-deleted, `daemon-reload` — tolerates no-sudo.
2. Dispatcher + Discord bot processes killed (TERM, then KILL) — matched by
   full paths only.
3. In-flight pi agent runs (`--session-id ctf-*`) killed **with their process
   groups**.
4. Pidfile removed; log truncated.

Then: env resolution (env vars → `.env` / `CTF_ENV_FILE` → `.env.deploy` for
Discord secrets → defaults), optional rebuild (`tsc` only when sources
changed), and a fresh background start (dispatcher + optional Discord bot)
with a pidfile. Restarting jobs recover automatically (see
[[Job-Lifecycle]] §8) — re-running is safe and is the intended redeploy
path.

## 2. systemd (optional boot persistence)

`ctf-worker.service` is provided for hosts where you want the service
supervised by init:

```ini
[Unit]
Description=Autonomous CTF Dispatcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ctf
WorkingDirectory=/opt/ctf-worker
EnvironmentFile=/etc/ctf-worker/env
ExecStart=/usr/bin/node /opt/ctf-worker/dist/index.js
Restart=always
RestartSec=5
```

Hardening is deliberately light (the agent runs challenge binaries — prefer a
container for real isolation; see §7). Journald captures dispatcher output
and (via journal) run logs. `run.sh` *removes* the systemd unit on start —
choose **either** run.sh **or** systemd supervision on a given host, not
both.

## 3. Remote VPS deployment

Two scripts, both idempotent:

- **`setup-remote.sh <user@host>`** — one-time provisioning, designed for an
  *unreliable* box: the work runs **detached on the remote** (nohup + log) so
  SSH disconnects don't interrupt it; this script kicks it off and polls the
  log. Steps: swap file → system packages (gdb, python3, sqlite, rsync, git,
  wget) → Node 22 → radare2 as a **prebuilt static tarball** (never compiled
  on the box) → pi (global npm) → directories (`/opt/ctf-worker`,
  `/var/lib/ctf-worker/{jobs,challenges}`).
- **`deploy-remote.sh <user@host>`** — the deploy path when the VPS is
  reachable: runs setup (if needed), rsyncs code + `node_modules` + run.sh to
  `/opt/ctf-worker` (excluding secrets/keys/state), copies `.env.deploy`
  (chmod 600), and runs `./run.sh` **on the remote** — the same script used
  locally. The remote then runs exactly like the local machine: same run.sh,
  same layout, `run.sh` is the supervisor (no systemd installed by this
  path).

Both scripts take the SSH identity from `DEPLOY_SSH_KEY` (default
`~/.ssh/id_ed25519`) and never read keys from inside the repo.

Remote control afterwards:

```bash
ssh <user@host> 'cd /opt/ctf-worker && ./run.sh status|logs|stop'
```

The remote uses `SOURCE=local` with challenges in
`/var/lib/ctf-worker/challenges` — drop challenge dirs there via scp/rsync
(or point the worker at a GitHub repo instead, same as local).

There is also `deploy-delldeb.sh` — a host-specific example of deploying to
a second box while copying this host's pi config (`settings.json`, `mcp.json`,
`models.json` — with remote backups) and matching pi npm packages. Treat it
as a template for "deploy to another machine".

## 4. GitHub source + webhook

For `SOURCE=github`, set `GITHUB_REPO`, `GITHUB_BRANCH`, and (recommended)
`GITHUB_TOKEN`. Push challenges to the repo — any top-level directory (or
directory under `challenges/`, in auto mode) is a challenge.

Optional webhook for instant discovery instead of waiting for the poll:
Repository → Settings → Webhooks → Add webhook:

- Payload URL: `http://<host>:<WEBHOOK_PORT>/webhook`
- Content type: `application/json`
- Secret: the `WEBHOOK_SECRET` value
- Events: **Just the push event**

The receiver verifies the HMAC (`X-Hub-Signature-256`), filters by repo and
branch, and triggers an immediate poll. A public tunnel or reverse proxy is
needed if the host isn't directly reachable. Without any webhook everything
still works via polling — a missed webhook only delays discovery by at most
one `POLL_INTERVAL_SEC`.

## 5. Operating

### CLI queries (read-only, safe during runs)

```bash
node dist/cli.js status [dbPath]   # counts per status + recent jobs
node dist/cli.js jobs   [dbPath]   # full job table
node dist/cli.js show <id> [dbPath] # one job: status, attempts, flag,
                                    # workspace, pi session, last output
```

### Discord

- `/status` — full DB dump (inline or attached `.txt`).
- One live panel per challenge with the current WRITEUP.md; **✅ reaction =
  mark done** (job → `SKIPPED`).
- SOLVED announcements with `@everyone` in the auto-detected announce channel.

### Logs

`run.sh` writes `ctf-worker.log`; under systemd, journald captures everything
(`journalctl -u ctf-worker -f`). Log lines are tagged by component
(`main`, `watcher`, `lifecycle`, `queue`, `pi`, `classifier`, `webhook`, ...)
— see `src/log.ts` (leveled; `LOG_LEVEL` filters).

### Routine checks

- `./run.sh status` — processes alive?
- `/status` or `cli.js status` — any `FATAL_ERROR` (needs a human: usually
  provider credentials/quota) or long-lived `BLOCKED` (attempt budget spent)?
- `BLOCKED`/`FATAL_ERROR` challenges: fix the cause (rotate the API key,
  bump `MAX_ATTEMPTS`, or solve by hand) then re-trigger discovery by pushing
  a content change to the challenge (new fingerprint → new job).

## 6. Restart / upgrade / wipe

- **Restart** — `./run.sh` again (safe; recovery is automatic).
- **Upgrade** — `git pull && ./run.sh` (rebuild happens if sources changed);
  schema migrations are additive and automatic on start (`migrateLegacy`).
- **Wipe** — `./run.sh stop`, then delete `data/` (DB + announce state) and
  `jobs/` (workspaces). The next start re-discovers everything from the
  source and re-solves from scratch (solved-status memory lives in the DB).

## 7. Security boundary

Challenge files are **untrusted input**. The dispatcher:

- stages them into per-job workspaces and never executes them itself;
- spawns pi per job with the workspace as cwd;
- **but runs everything as the service user on the host** — the agent will
  execute challenge binaries on your machine.

For real adversarial use, wrap the agent in a container/sandbox
(systemd-nspawn, Docker with dropped capabilities, or a dedicated VM). The
`AgentBackend` interface ([[Agent-Backends]]) is the plug-in point: a
container backend can be added without touching the dispatcher core.

Secrets hygiene in the repo itself: `.env` / `.env.deploy` / SSH keys /
`data/` / `jobs/` / logs are gitignored; the dispatcher never handles
provider credentials (pi owns `~/.pi/agent`).
