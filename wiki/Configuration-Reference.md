# Configuration Reference

Configuration is loaded by `src/config.ts`. Resolution order:

1. **Process environment** (always wins)
2. **Env file** — `CTF_ENV_FILE` if set, else `.env` in the working
   directory, if present
3. **Built-in defaults**

(`run.sh` additionally layers `.env.deploy` — gitignored Discord secrets —
between the env file and defaults, and `deploy-remote.sh` copies it to the
remote. `env.example` documents every variable.)

`--once` (single poll, run all jobs to terminal state, exit) and `--scan`
(single poll, discover only, exit) are CLI flags, not env.

## Source

| Variable | Default | Meaning |
| --- | --- | --- |
| `SOURCE` | `github` | `github` or `local` |
| `GITHUB_REPO` | — | `owner/name`; **required** when `SOURCE=github` |
| `GITHUB_TOKEN` | — | PAT with repo read; strongly recommended (unauthenticated polling hits rate limits fast) |
| `GITHUB_BRANCH` | `main` | branch to watch |
| `GITHUB_API_BASE` | `https://api.github.com` | API base (override for GHES/proxies) |
| `GITHUB_RAW_BASE` | `https://raw.githubusercontent.com` | raw download base |
| `LOCAL_SOURCE_DIR` | — | local source directory when `SOURCE=local` |

### Discovery root

| Variable | Default | Meaning |
| --- | --- | --- |
| `GITHUB_CHALLENGES_PREFIX` | `auto` | `auto` = discover challenges **both at the repo root and under `challenges/`** simultaneously (a `challenges/` dir itself is never a challenge). A specific path = pin discovery inside that dir. An **explicitly empty** value (`GITHUB_CHALLENGES_PREFIX=`) = repo root only. (Unset ≠ empty: unset → auto.) |
| `CHALLENGE_EXCLUDE` | `writeups,scripts,docs,tools,assets,.github` | comma-separated top-level dir names to never treat as challenges (root-level discovery; also applies to direct children of `challenges/`) |

Notes:

- Test/demo-looking challenge names (`test`, `demo`, `example`, `sample`,
  `scratch`, `tmp`, ...) are *never* tracked, regardless of configuration.
- `SOLVED.txt` at the repo/challenge root pre-marks listed challenges as
  solved (`SKIPPED`).

## Discovery cadence

| Variable | Default | Meaning |
| --- | --- | --- |
| `POLL_INTERVAL_SEC` | `120` | authoritative polling interval |
| `WEBHOOK_ENABLED` | `true` | webhook receiver (only accelerates polling) |
| `WEBHOOK_HOST` / `WEBHOOK_PORT` | `127.0.0.1` / `4567` | bind address for the receiver |
| `WEBHOOK_SECRET` | — | GitHub webhook HMAC secret (empty disables verification) |

## State

| Variable | Default | Meaning |
| --- | --- | --- |
| `DB_PATH` | `data/ctf-worker.db` | SQLite database (WAL) |
| `JOBS_DIR` | `jobs` | staged workspaces root |

## Job control

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_CONCURRENT` | `1` | parallel agent runs (queue slots) |
| `MAX_ATTEMPTS` | `20` | continuation budget before `BLOCKED` |
| `TURN_MINUTES` | `10` | **rotation turn length** — minutes per challenge turn before the run is killed (WRITEUP captured), the job rotates to the back of the queue, and the next pending challenge starts; resumes after a full round |
| `RUN_TIMEOUT_MIN` | `120` | wall-clock cap per run (under rotation this is effectively `TURN_MINUTES` — the backend is configured with the turn length) |
| `IDLE_TIMEOUT_MIN` | `10` | no-stream-activity cap per run (catches wedged runs) |
| `KILL_GRACE_SEC` | `15` | SIGTERM → SIGKILL grace |

## Agent

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_BACKEND` | `pi` | `pi` or `echo` (deterministic fake for testing) |
| `PI_BIN` | `pi` | pi executable (name or absolute path) |
| `PI_EXTRA_ARGS` | — | extra args appended to every pi run, e.g. `--provider X --model Y` |
| `PI_MODEL` | — | convenience used by `run.sh` (exported for pi to pick up) |
| `ECHO_SCRIPT` | `unsolved` | default echo scenario: `solved` / `unsolved` / `fatal` |

Pi reads its own model/auth config from `~/.pi/agent` (`settings.json`,
`models.json`, `auth.json`) — the dispatcher never touches credentials.

## Reporting

| Variable | Default | Meaning |
| --- | --- | --- |
| `STATUS_INTERVAL_SEC` | `60` | Discord dashboard cadence |
| `DISCORD_WEBHOOK_URL` | — | webhook for push messages; empty = log-only publishing |
| `DISCORD_BOT_ENABLED` | `false` | run the interactive bot in-process |
| `DISCORD_BOT_TOKEN` | — | bot token (required when bot enabled) |
| `DISCORD_APPLICATION_ID` | — | application id (slash-command registration) |
| `DISCORD_ANNOUNCE_CHANNEL_ID` | — | announce channel; empty = auto-detect (`solved` → `announcements` → `general` → first text channel) |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## Node / runtime

`run.sh` resolves the node binary (`NODE_BIN`, else a user-local node22
install, else system node — pi ≥0.84 requires node ≥22 for `globSync`) and
prepending its dir to `PATH` so spawned pi agents run under it too.
