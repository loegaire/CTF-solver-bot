# ctf-worker

A self-hosted, completely free **autonomous CTF challenge dispatcher**: watches a
challenge source (GitHub repository or local directory), stages each challenge,
hands it to the [Pi](https://github.com/badlogic/pi-mono) coding agent, watches
the run, classifies the outcome (solved / fatal / recoverable), and **forces the
agent to continue** until the challenge is solved or genuinely blocked. Status
and results are published to Discord (optional).

> The dispatcher owns discovery and lifecycle; Pi owns solving. The dispatcher
> only intervenes when Pi terminates, and only enough to distinguish
> “continue” from “stop.”

## Architecture

```
Challenge source (GitHub repo, polling + optional webhook)
        │
        ▼
┌───────────────────────────────┐
│  ctf-worker (systemd service)  │
│  watcher → detector → stager  │
│  SQLite state → Pi handoff     │
│  exit/error classifier         │
│  continuation forcing          │
│  Discord reporter (optional)   │
└───────────────┬───────────────┘
                │  pi --mode json --session-id ctf-<jobId> (headless)
                ▼
         Pi agent (workspace = staged challenge)
                │
        stdout events / exit code
                ▼
┌───────────────────────────────┐
│  SOLVED     → done            │
│  FATAL      → stop + report   │
│  UNSOLVED   → CONTINUE loop   │  ← “not solved is not failure”
│  attempts exhausted → BLOCKED │
└───────────────────────────────┘
```

Key properties:

- **Stateless w.r.t. agent reasoning** — the dispatcher never interprets the
  solution; it only manages lifecycle.
- **Stateful in SQLite** — every discovery, job, attempt, and published message
  is persisted; restarts lose nothing.
- **Webhook is an optimization** — polling is authoritative; a missed webhook
  only delays discovery.
- **Per-challenge content identity** — a challenge is (path + content
  fingerprint). A push that changes one challenge only creates one new job.
- **“Not solved is not failure”** — an agent that stops without a fatal
  condition is forced to continue with a nudge prompt, resuming the same Pi
  session (transcript + workspace preserved).
- **Fatal vs recoverable classification** — auth/quota/billing/infrastructure
  errors stop the job; ordinary failure-to-solve continues. Transient
  transport errors that Pi auto-recovered mid-run are ignored (they only count
  if the run actually died because of them).

## Layout

```
ctf-worker/
├── src/
│   ├── index.ts                  entrypoint: wiring, recovery, shutdown
│   ├── cli.ts                    status/jobs/show queries against the DB
│   ├── config.ts                 env + .env file configuration
│   ├── log.ts                    leveled logging (journald captures it)
│   ├── types.ts                  ChallengeRef / ChallengeFile / RawFile
│   ├── database/
│   │   ├── db.ts                 SQLite wrapper (challenges, jobs, messages, meta)
│   │   └── schema.sql
│   ├── sources/
│   │   ├── source.ts             ChallengeSource abstraction + challenge grouping
│   │   ├── github.ts             GitHub trees API + raw file downloads
│   │   └── local.ts              local directory source (content-hashed revisions)
│   ├── dispatcher/
│   │   ├── watcher.ts            polling loop (+ webhook trigger hook)
│   │   ├── webhook.ts            GitHub webhook receiver (HMAC verified)
│   │   ├── stager.ts             immutable per-job workspace staging
│   │   ├── lifecycle.ts          job state machine + outcome application
│   │   └── queue.ts              concurrency-limited runner
│   ├── agents/
│   │   ├── backend.ts            AgentBackend abstraction
│   │   ├── pi.ts                  PiBackend: headless pi, JSON events, timeouts
│   │   ├── echo.ts               deterministic fake backend for tests
│   │   └── prompts.ts            initial/continuation prompts, AGENTS.md rules
│   ├── errors/
│   │   └── classifier.ts         solved/fatal/continue/blocked classification
│   └── publishers/
│       ├── publisher.ts          Publisher interface + dedupe hash
│       ├── discord.ts            Discord webhook + log fallback publisher
│       └── reporter.ts            lifecycle events + status dashboard → Discord
├── test/                         node:test suites (classifier, e2e lifecycle)
├── ctf-worker.service            systemd unit
└── env.example                   environment reference
```

## Status protocol

Every agent run must end its final message with exactly one of:

```
STATUS: SOLVED
STATUS: UNSOLVED
```

This is enforced by the initial and continuation prompts (see
`src/agents/prompts.ts`), which also instruct the agent to write a
`SOLUTION.md` (Status / Flag / Summary / Artifacts) into the workspace when
solved. The classifier reads the marker from the final assistant message, with
`SOLUTION.md` as a fallback, and extracts the flag from `Flag: ...` lines.

## Job lifecycle

```
NEW → STAGED → RUNNING ──→ SOLVED
              │     │
              │     ├──(fatal pattern)──→ FATAL_ERROR
              ├──(agent stopped unsolved)→ AGENT_STOPPED → RUNNING (continue)
              └──(attempts ≥ MAX_ATTEMPTS)→ BLOCKED
```

## Quick start (local source, no GitHub needed)

```bash
npm install
npm run build

mkdir -p /tmp/challenges/hello
cat > /tmp/challenges/hello/README.md <<'EOF'
# hello
The flag is flag{hello_world}. Find it (it's in hidden.txt).
EOF
echo 'flag{hello_world}' > /tmp/challenges/hello/hidden.txt

SOURCE=local \
LOCAL_SOURCE_DIR=/tmp/challenges \
AGENT_BACKEND=pi \
DB_PATH=data/demo.db \
JOBS_DIR=data/jobs \
WEBHOOK_ENABLED=false \
npm start
```

Stop with Ctrl-C. Query state:

```bash
node dist/cli.js status data/demo.db
node dist/cli.js jobs   data/demo.db
node dist/cli.js show 1 data/demo.db
```

For a fully offline test of the lifecycle without any model:

```bash
SOURCE=local LOCAL_SOURCE_DIR=/tmp/challenges AGENT_BACKEND=echo ECHO_SCRIPT=unsolved \
  MAX_ATTEMPTS=3 DB_PATH=data/demo.db JOBS_DIR=data/jobs WEBHOOK_ENABLED=false npm start
```

The echo backend will run, report unsolved, and be forced to continue until
`MAX_ATTEMPTS` → BLOCKED. With `ECHO_SCRIPT=solved` it solves immediately.

## Configuration

Copy `env.example` to `/etc/ctf-worker/env` (or `.env` in the working
directory). Highlights:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SOURCE` | `github` | `github` or `local` |
| `GITHUB_REPO` | — | `owner/name` (required for github) |
| `GITHUB_TOKEN` | — | PAT; strongly recommended (API rate limits) |
| `GITHUB_BRANCH` | `main` | branch to watch |
| `GITHUB_CHALLENGES_PREFIX` | `challenges` | challenge root inside the repo |
| `POLL_INTERVAL_SEC` | `120` | authoritative polling interval |
| `WEBHOOK_ENABLED` | `true` | webhook receiver (accelerates polling) |
| `WEBHOOK_PORT` / `WEBHOOK_HOST` | `4567` / `127.0.0.1` | bind for webhook receiver |
| `WEBHOOK_SECRET` | — | GitHub webhook HMAC secret |
| `DB_PATH` | `data/ctf-worker.db` | SQLite state |
| `JOBS_DIR` | `jobs` | staged workspaces root |
| `MAX_CONCURRENT` | `1` | parallel agent runs |
| `MAX_ATTEMPTS` | `20` | continuation budget before BLOCKED |
| `RUN_TIMEOUT_MIN` | `120` | wall-clock cap per run |
| `IDLE_TIMEOUT_MIN` | `10` | no-stream-activity cap per run |
| `AGENT_BACKEND` | `pi` | `pi` or `echo` |
| `PI_BIN` | `pi` | pi executable |
| `PI_EXTRA_ARGS` | — | extra args for every pi run |
| `STATUS_INTERVAL_SEC` | `60` | Discord dashboard cadence |
| `DISCORD_WEBHOOK_URL` | — | empty = log-only publishing |

Pi reads its own model/auth configuration from `~/.pi/agent` (settings.json,
models.json, auth.json). Configure the model there (e.g. a local or free
provider) — the dispatcher never touches credentials. `PI_EXTRA_ARGS` can pin
`--provider`/`--model` if desired.

## Challenge source format

```
challenges/
├── challenge-a/
│   ├── README.md
│   ├── binary
│   └── files/
├── challenge-b/
│   ├── README.md
│   └── source.zip
```

Each top-level directory under the prefix is one challenge. Identity is
(path + content fingerprint of its files) — unchanged challenges are never
re-run even across new commits; any real change creates a new job.

## Running

`./run.sh` is the single entry point on any machine (local or remote) — no SSH
logic inside:

```bash
./run.sh          # (re)start: kills old processes, removes any systemd unit,
                   # rebuilds if sources changed, starts dispatcher + discord bot
./run.sh stop      # kill everything, start nothing
./run.sh status    # process state
./run.sh logs      # tail the log (ctf-worker.log)
```

Re-running is safe and is the intended redeploy path. Every start: stops +
hard-deletes any `ctf-worker` systemd service, kills the previous dispatcher /
bot / agent runs, then starts fresh in the background with logging to
`ctf-worker.log` and a pidfile at `ctf-worker.pid`.

Configuration resolution: environment variables → `.env` (or `CTF_ENV_FILE`) →
`.env.deploy` (Discord secrets, gitignored) → built-in defaults. Default local
setup: `SOURCE=local`, challenges in `./challenges/` (auto-detects that the dir
is already the challenge root), state in `./data/`, jobs in `./jobs/`.

## Remote deployment

When the VPS is reachable:

```bash
./setup-remote.sh     # once: swap, packages, node 22, r2 (prebuilt static — never
                      # compiled on the box), pi, pi config copied from this host
./deploy-remote.sh    # then: provisions via setup if needed, rsyncs repo +
                      # node_modules + .env.deploy, and runs ./run.sh ON THE
                      # REMOTE — the same script used locally
```

Remote control afterwards:

```bash
ssh <user@host> 'cd /opt/ctf-worker && ./run.sh status|logs|stop'
```

The remote uses `SOURCE=local` with challenges in
`/var/lib/ctf-worker/challenges` — drop challenge dirs there via scp/rsync.

## Security boundary

Challenge files are untrusted input. The dispatcher:

- stages them into per-job workspaces and never executes them itself;
- spawns Pi per job with the workspace as cwd;
- but **runs everything as the service user on the host**. For real adversarial
  use, wrap the agent in a container/sandbox (systemd-nspawn, Docker with
  dropped capabilities, or a dedicated VM) — the `AgentBackend` interface is the
  place to plug that in (`PiBackend` is one implementation; a container backend
  can be added without touching the dispatcher core).

## GitHub webhook (optional)

Repository → Settings → Webhooks → Add webhook:

- Payload URL: `http://<host>:<port>/webhook`
- Content type: `application/json`
- Secret: the `WEBHOOK_SECRET` value
- Events: Just the push event

Each push triggers an immediate poll. A public tunnel (or reverse proxy) is
needed if the host isn't directly reachable. Without any webhook, everything
still works via polling.

## What ends a job

- **SOLVED** — agent reports `STATUS: SOLVED` (or writes a solved SOLUTION.md).
- **FATAL_ERROR** — a condition no amount of retrying can fix:
  - spawn failure (pi binary missing, workspace gone),
  - a provider transport error surfacing on the agent's final message
    (pi's structured `stopReason: "error"` + `errorMessage` — 401/403/429,
    quota, billing, network),
  - a pi CLI startup error on stderr ("Error: Model ... not found" — agent tool
    output never reaches pi's stderr, so this is precise),
  - or the agent explicitly reporting it cannot continue due to infrastructure.
- **BLOCKED** — `MAX_ATTEMPTS` exhausted without solving.

Anything else — including run timeouts and idle timeouts — is treated as
recoverable and re-enqueued with a continuation prompt. A continuation nudge
cycles through different strategic hints (re-derive assumptions, change
approach class, write a plan, reduce the problem, ...) so the agent is pushed
to explore rather than repeat itself.

### Classification precision

False-fatals are the worst failure mode (they'd abort a healthy job), so the
classifier is deliberately layered:

1. **Structured signal first**: pi's own `errorMessage` on the final assistant
   message is authoritative — transient 429s that pi auto-retried mid-run never
   surface there.
2. **Text patterns only on abnormal ends**: when a run dies abnormally (crash,
   kill, empty output), the *tail* of stderr/stdout is scanned for
   infrastructure patterns (401/403/429/quota/billing/ENOTFOUND/...). A run
   that *completed normally* is never fatal-matched against transport patterns
   — challenge tool output legitimately contains such strings (a CTF server
   returning 403 to the agent's exploit, "rate limit" discussion, etc.).
3. **Agent-reported infrastructure errors** on normal completion require an
   explicit "cannot continue because ..." construction.

The live validation suite confirmed: an agent discussing "403 Forbidden" from a
challenge server continues; a provider 403 ends the job.

## Tests

```bash
npm test
```

`test/classifier.test.ts` covers the classification matrix; `test/e2e.test.ts`
drives the full lifecycle (discover → stage → run → continue → blocked →
re-discovery identity → interrupted-run recovery) with the echo backend.
