# ctf-worker — Wiki

A self-hosted, completely free **autonomous CTF challenge dispatcher**: watches a
challenge source (GitHub repository or local directory), stages each challenge,
hands it to the [Pi](https://github.com/badlogic/pi-mono) coding agent, watches
the run, classifies the outcome (solved / fatal / recoverable), and **forces the
agent to continue** until the challenge is solved or genuinely blocked. Status
and results are published to Discord (optional).

> **The dispatcher owns discovery and lifecycle; Pi owns solving.** The
> dispatcher only intervenes when Pi terminates, and only enough to distinguish
> "continue" from "stop."

## Documentation Map

| Page | Contents |
| --- | --- |
| [[Core-Architecture]] | The big picture: components, data flow, module walkthrough, design principles |
| [[Source-of-Truth-and-Orchestration]] | What is authoritative (repo → DB → transcript), discovery, dedup, pruning, rotation, polling vs webhook |
| [[Persistence-and-Database]] | SQLite schema, every table and column, indexes, WAL, migrations, the `db.ts` API surface |
| [[Job-Lifecycle]] | The full job state machine, transitions, continuation forcing, recovery after restart |
| [[Outcome-Classification]] | SOLVED / FATAL / CONTINUE / BLOCKED rules, fatal patterns, transient vs permanent provider errors |
| [[Agent-Backends]] | The `AgentBackend` abstraction, PiBackend (json + RPC modes), EchoBackend, prompts, session-log digests |
| [[Discord-Integration]] | Reporter, publishers, /status bot, live job panels, ✅ done reaction |
| [[Configuration-Reference]] | Every environment variable with defaults |
| [[Deployment-and-Operations]] | run.sh, systemd, remote provisioning, CLI queries, security boundary |
| [[Testing]] | Test suites and what each covers |

## The System in One Diagram

```
Challenge source (GitHub repo, polling + optional webhook)
        │
        ▼
┌───────────────────────────────┐
│  ctf-worker (systemd service) │
│  watcher → detector → stager  │
│  SQLite state → Pi handoff    │
│  exit/error classifier        │
│  continuation forcing         │
│  Discord reporter (optional)  │
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
│  UNSOLVED   → CONTINUE loop   │  ← "not solved is not failure"
│  attempts exhausted → BLOCKED │
└───────────────────────────────┘
```

## Key Properties (30-second version)

- **Stateless w.r.t. agent reasoning** — the dispatcher never interprets the
  solution; it only manages lifecycle.
- **Stateful in SQLite** — every discovery, job, attempt, and published message
  is persisted; restarts lose nothing.
- **Webhook is an optimization** — polling is authoritative; a missed webhook
  only delays discovery.
- **Per-challenge content identity** — a challenge is (path + content
  fingerprint). A push that changes one challenge only creates one new job.
- **"Not solved is not failure"** — an agent that stops without a fatal
  condition is forced to continue with a nudge prompt, resuming the same Pi
  session (transcript + workspace preserved).
- **Fatal vs recoverable classification** — auth/quota/billing/infrastructure
  errors stop the job; ordinary failure-to-solve continues.
- **Round-robin turn rotation** — each challenge gets a `TURN_MINUTES` turn,
  then rotates to the back of the queue; sessions resume intact after a full
  round.

## Quick Start

```bash
npm install
npm run build

# fully offline lifecycle test (no model needed):
SOURCE=local LOCAL_SOURCE_DIR=/tmp/challenges AGENT_BACKEND=echo \
  ECHO_SCRIPT=unsolved MAX_ATTEMPTS=3 DB_PATH=data/demo.db \
  JOBS_DIR=data/jobs WEBHOOK_ENABLED=false npm start
```

See [[Configuration-Reference]] and [[Deployment-and-Operations]] for the full
setup, or the [README](https://github.com/loegaire/CTF-solver-bot) for a
tour.
