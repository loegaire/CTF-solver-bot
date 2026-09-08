# Core Architecture

ctf-worker is an **autonomous CTF challenge dispatcher**. It is deliberately
split into a thin, stateless decision core (the dispatcher) and a stateful
persistence layer (SQLite), with the actual reasoning delegated entirely to an
external coding agent ([Pi](https://github.com/badlogic/pi-mono)).

The design goal: **the dispatcher owns discovery and lifecycle; the agent owns
solving.** The dispatcher only intervenes when the agent terminates, and only
enough to distinguish *continue* from *stop*.

---

## 1. The Big Picture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                            CHALLENGE SOURCE                                 │
│   GitHub repo (trees API + raw downloads)  or  local directory              │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │ polling (authoritative) + webhook (optimizer)
                               ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ WATCHER (dispatcher/watcher.ts)                                             │
│ poll every POLL_INTERVAL_SEC → current revision + full file list →          │
│ group into ChallengeRefs → read SOLVED.txt                                  │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ LIFECYCLE (dispatcher/lifecycle.ts) — the job state machine                 │
│  pruneMissing() ─ DB tracks only what the repo still has                   │
│  discover() ─ dedupe by (path, source, content fingerprint)                │
│  stage() ─ download into immutable workspace + task.txt + AGENTS.md        │
│  runJob() ─ submit/resume on the agent backend, await result               │
│  applyOutcome() ─ classify + persist + events                               │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ QUEUE (dispatcher/queue.ts) — concurrency + fairness + rotation            │
│ at most one active run per challenge; picks least-recently-rotated pending   │
│ job; MAX_CONCURRENT parallel slots                                          │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ AGENT BACKEND (agents/backend.ts contract)                                 │
│  PiBackend  — pi --mode json, deterministic --session-id, timeouts (prod)   │
│  EchoBackend— deterministic fake outcomes (tests)                           │
│  PiRpcBackend — pi --mode rpc: steer/abort a RUNNING agent (interactive)   │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │ AgentRunResult (exit code, tails, providerError)
                               ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ CLASSIFIER (errors/classifier.ts)                                          │
│ SOLVED | FATAL | CONTINUE | BLOCKED  —  "not solved is not failure"        │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               ▼
┌──────────────────────────────┴─────────────────────────────┬───────────────┐
│ SQLite (database/db.ts)          │ PUBLISHERS (publishers/*) │ DISCORD BOT   │
│ challenges / jobs / progress /   │ reporter → webhook        │ /status dump  │
│ messages / meta  (WAL mode)      │ (deduped, non-fatal)      │ + live panels │
└────────────────────────────────────────────────────────────────────────────┘
```

## 2. Component-by-Component

### 2.1 Sources (`src/sources/`)

The `ChallengeSource` interface (`source.ts`) is the only thing the dispatcher
knows about where challenges come from:

```ts
interface ChallengeSource {
    readonly id: string;                      // e.g. "github:owner/name@main"
    currentRevision(): Promise<string>;      // commit SHA (or manifest hash)
    listFiles(): Promise<RawFile[]>;         // full tree at current revision
    downloadFile(path: string): Promise<Buffer>;
}
```

- **`github.ts`** — lists the tree via the GitHub git trees API (one call for
  the whole repo, `recursive=1`), downloads blobs from
  `raw.githubusercontent.com`. Lists are cached per revision. A PAT
  (`GITHUB_TOKEN`) is strongly recommended; unauthenticated polling hits rate
  limits quickly.
- **`local.ts`** — walks a local directory. "Revision" is a content manifest
  hash (sha256 over sorted `path:mode:sha` lines), so editing a file changes
  the revision exactly like a git push would.
- **`source.ts`** also hosts the *grouping* logic (`groupChallenges`): turn a
  flat file list into `ChallengeRef`s (one per top-level directory under the
  discovery root). `PREFIX_AUTO` (the default) discovers challenges **both at
  the repo root and under `challenges/`** simultaneously — put a challenge
  anywhere in the repo and it's found. An explicit prefix pins discovery to
  that directory; an explicitly-empty prefix means root-only. `exclude` filters
  non-challenge dirs (`writeups`, `scripts`, ...) at the challenge-root level.
  `parseSolvedFile` reads `SOLVED.txt` (repo root or challenge root) for
  skip-marking.

### 2.2 Watcher (`src/dispatcher/watcher.ts`)

The discovery loop. Every `POLL_INTERVAL_SEC` (default 120s):

1. `currentRevision()` — if unchanged since last poll, stop (cheap early exit).
2. `listFiles()` → `groupChallenges()` → `ChallengeRef[]`.
3. Read `SOLVED.txt` (if present) → lines of already-solved challenge names.
4. Hand `(challenges, solvedLines)` to the main wiring's `onDiscover`
   callback — which runs prune → discover → repo-README sync → `queue.wake()`.

`watcher.trigger()` (called by the webhook receiver) just sets a
`pollNow` flag that short-circuits the sleep. **The webhook never adds state of
its own** — it can only pull a poll forward in time.

### 2.3 Stager (`src/dispatcher/stager.ts`)

Downloads a challenge's files into an **immutable per-job workspace**:

```
<jobsDir>/<challenge>-<shortSha>/     ← agent workspace, persistent
├── task.txt                         solving instructions (initial prompt)
├── AGENTS.md                        workspace rules (pi loads it automatically)
├── SOLUTION.md                      written by the agent on success
├── WRITEUP.md                       agent-maintained scratch pad
├── REPO-README.md                   repo top-level README, synced by dispatcher
├── staged-manifest.json             what/when/where was staged
└── <challenge files>                untouched originals
```

- `workspaceFor()` = `<jobsDir>/<sanitized-name>-<sha8>` — deterministic from
  the challenge identity, so re-staging is idempotent.
- `safeJoin()` refuses path traversal (`../` in challenge file paths cannot
  escape the workspace).
- Executable mode (`100755`) is preserved via `chmod`.
- The **canonical repo is never used as the workspace** — only copies are.

### 2.4 Lifecycle (`src/dispatcher/lifecycle.ts`)

The job state machine (see [[Job-Lifecycle]] for the full transition table).
Responsibilities:

- **`pruneMissing(batch, stopJob)`** — repo-sync pruning: anything tracked in
  the DB but absent from the current source listing is closed out (killed if
  running, panels updated). *The git repo is the source of truth for what
  exists.*
- **`discover(batch, solvedLines)`** — register new challenges. Dedupe key =
  `(path, source, contentFingerprint)`; test/demo-looking names
  (`test`, `demo`, `example`, ...) are never tracked; `SOLVED.txt`-listed
  challenges are created directly in `SKIPPED`.
- **`stage(jobId)`** — download files, write `task.txt` + `AGENTS.md`.
- **`runJob(backend, jobId, onSpawn)`** — build the initial or continuation
  prompt, submit/resume on the backend, persist `RUNNING` + pid, await the
  result, then classify.
- **`applyOutcome(jobId, outcome)`** — persist the outcome + per-attempt
  progress (session digest conclusion, WRITEUP.md, tool stats), transition
  job/challenge state, emit a `LifecycleEvent`.
- **`recoverInterruptedJobs()`** — startup recovery: `RUNNING` jobs (whose
  processes died with the dispatcher) become continuations; `STAGED` /
  `HANDED_OFF` leftovers are simply re-run.
- **`syncRepoReadme()`** — on every discovery pass, copy the repo's top-level
  README into every active workspace as `REPO-README.md`. This is the
  competition-wide "credentials/instances" channel: update the repo README and
  every queued/running agent sees it on its next turn.

### 2.5 Queue (`src/dispatcher/queue.ts`)

Concurrency-limited runner with two fairness rules:

1. **At most one active run per challenge** — a newer commit of challenge X
   never runs concurrently with an older one.
2. **Rotation ordering** — pending jobs (`AGENT_STOPPED`, `STAGED`, `NEW`) are
   picked least-recently-rotated first (`last_rotated_at ASC`, never-rotated
   first). With `MAX_CONCURRENT=1` this gives strict round-robin: one
   `TURN_MINUTES` turn per challenge, then the back of the queue. After every
   challenge has had a turn, the first one resumes with its Pi session and
   workspace intact.

`markDone(jobId, reason)` is the human interrupt: stop any in-flight run and
end the job in `SKIPPED` (used by the ✅ panel reaction and by pruning).
`wake()` unblocks the loop after discovery/webhooks/state changes. `stop()`
drains in-flight runs on shutdown.

### 2.6 Agent backends (`src/agents/`)

See [[Agent-Backends]] for the full contract. The dispatcher only needs:

```ts
interface AgentBackend {
    submit(spec: AgentJobSpec): AgentRunHandle;  // fresh run
    resume(spec: AgentJobSpec): AgentRunHandle;  // continuation, same session
}
interface AgentRunHandle {
    readonly pid: number | null;
    readonly result: Promise<AgentRunResult>;
    kill(reason: string): Promise<void>;
}
```

`AgentRunResult` carries exit code/signal, kill reason, bounded tails of the
transcript/stdout/stderr, the final assistant text, and — critically —
`providerError` (pi's structured `stopReason: "error"` transport error), which
the classifier trusts far more than text matching.

### 2.7 Classifier (`src/errors/classifier.ts`)

The decision point of the whole system (see [[Outcome-Classification]]).
Given an `AgentRunResult` + attempt counts + workspace, it returns exactly one
of `SOLVED / CONTINUE / FATAL / BLOCKED`.

### 2.8 Persistence (`src/database/db.ts`)

Synchronous better-sqlite3 wrapper. See [[Persistence-and-Database]]. Every
state transition in the dispatcher is a synchronous DB write — there is no
in-memory state that survives a restart, and none that can diverge from the DB.

### 2.9 Reporting (`src/publishers/`, `src/discord/`)

- **Reporter** turns lifecycle events into human messages; deduped via the
  `messages` table; publishing failures are logged and swallowed (a Discord
  outage never affects solving).
- **Status loop** publishes a dashboard every `STATUS_INTERVAL_SEC`.
- **Discord bot** (optional, in-process): `/status` dumps the whole DB;
  SOLVED announcements ping `@everyone`; one live **job panel** per challenge
  (status, attempts, WRITEUP.md content — inline or attached) with a ✅
  reaction that marks the job done. See [[Discord-Integration]].

## 3. Wiring (`src/index.ts`)

`main()` wires everything in one place, in this order:

1. `loadConfig()` + `openDb()`
2. Source (`GitHubSource` | `LocalSource`), reporter/publisher
3. Backend (`PiBackend` | `EchoBackend`) — with `runTimeoutMin = TURN_MINUTES`
   (one turn = one run-timeout slot under the rotation system)
4. `Lifecycle` (event fan-out → reporter + SOLVED @everyone announce)
5. `Queue`
6. **Startup recovery** — `recoverInterruptedJobs()`, then `RUNNING` →
   `AGENT_STOPPED` (continuation) in the DB
7. `--scan` mode: one poll, discover, exit. `--once` mode: one poll, run until
   all terminal, exit.
8. Watcher loop + webhook server (binds `WEBHOOK_HOST:WEBHOOK_PORT`, HMAC
   verified, repo/branch filtered)
9. Status loop (interval dashboard publish)
10. Discord bot + PanelManager (if `DISCORD_BOT_ENABLED`); panels attach once
    the bot is READY
11. SIGINT/SIGTERM shutdown: watcher → queue (drain) → status → panels → bot →
    webhook → DB close
12. `queue.run()` — the main loop only resolves after `queue.stop()` and all
    in-flight runs settle

## 4. Design Principles

| Principle | How it shows up in the code |
| --- | --- |
| **The repo is the source of truth for *what exists*** | `pruneMissing` deletes tracker state for anything gone from the repo; discovery re-creates it if it comes back with new content |
| **SQLite is the source of truth for *what happened*** | Every transition is a synchronous write; restarts recover purely from the DB |
| **The transcript is the source of truth for *what the agent knows*** | pi session files are parsed for per-attempt conclusions; `--session-id` is deterministic so a session can always be found and resumed |
| **Polling is authoritative; webhooks are an optimization** | Webhook only sets `pollNow`; a failed webhook delays discovery by at most one poll interval |
| **Not solved is not failure** | Only infrastructure-class errors are FATAL; "I couldn't solve it" is always CONTINUE (until the attempt budget runs out → BLOCKED) |
| **Publishing is non-fatal** | Publisher failures are logged, never thrown; dedupe prevents repeat spam |
| **Idempotence everywhere** | staging, discovery, pruning, re-running `run.sh`, deploying twice — all safe to repeat |

## 5. Where to Look in the Code

```
src/
├── index.ts                  entrypoint: wiring, recovery, shutdown
├── cli.ts                    status/jobs/show queries against the DB
├── config.ts                 env + .env file configuration
├── log.ts                    leveled logging (journald captures it)
├── types.ts                  ChallengeRef / ChallengeFile / RawFile
├── database/                 → [[Persistence-and-Database]]
├── sources/                  sources + challenge grouping
├── dispatcher/               watcher, webhook, stager, lifecycle, queue
├── agents/                   → [[Agent-Backends]]
├── errors/classifier.ts      → [[Outcome-Classification]]
├── publishers/               reporter + publishers
└── discord/                  → [[Discord-Integration]]
```
