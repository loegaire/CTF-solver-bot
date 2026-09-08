# Source of Truth and Orchestration

This page documents **what is authoritative for what**, and how the dispatcher
orchestrates everything around those sources of truth without ever becoming one
itself.

## 1. The Three Sources of Truth

| Question | Source of truth | Mechanism |
| --- | --- | --- |
| *What challenges exist right now?* | **The challenge git repo** (or local dir) | polling + pruning; DB rows are just a cache of history |
| *What has happened to a job?* | **The SQLite DB** | every transition is a synchronous write; restarts recover from it |
| *What does the agent know / where was it in its reasoning?* | **The Pi session transcript** (JSONL under `~/.pi/agent/sessions/...`) | deterministic `--session-id` per job; `resume()` replays it |

Everything else is derived or disposable:

- The **webhook** holds no state — it can only trigger an early poll.
- The **Discord panels/messages** are projections of DB state.
- The **`progress` table** is a snapshot digest of what the transcript + workspace
  contained at the end of each attempt.
- The **staged workspace** is a disposable copy of the repo content (re-staging
  is idempotent), but its agent-written files (`WRITEUP.md`, `SOLUTION.md`,
  scripts) are the agent's persistent working memory across runs.

### 1.1 Why the repo is authoritative for existence

Discovery is a **reconciliation**, not an append:

1. `pruneMissing(batch)` runs *before* `discover(batch)`: challenges tracked in
   the DB but missing from the current source listing are closed out —
   in-flight runs are killed (via `queue.markDone`), jobs end in a removed
   state, panels show a final "removed from repo" state.
2. `discover(batch)` then registers anything new, deduplicating on
   **content identity** (see §3).
3. A later push that re-adds the same path creates a *new* challenge row (new
   content fingerprint) and a fresh job — history of the old one is preserved
   in the DB.

Because of this, the DB never accumulates state for things the repo no longer
has (the pre-purge "REMOVED tombstone" scheme was deliberately migrated away —
see `migrateLegacy()` in `db.ts`: *"the git repo is the source of truth — drop
those tombstones so the DB only tracks what's in the repo"*).

### 1.2 Why SQLite is authoritative for history

The dispatcher process holds **no authoritative in-memory state**. Any
memory (queue bookkeeping, active-run handles) is reconstructable:

- `RUNNING` jobs at startup → their processes are gone by definition (the
  dispatcher owns them), so they become continuations
  (`recoverInterruptedJobs` + `RUNNING → AGENT_STOPPED`).
- `STAGED`/`HANDED_OFF` leftovers → re-run; staging is idempotent.
- Orphaned pi processes for a session (e.g. dispatcher was `kill -9`-ed) are
  detected by `findProcesses` at the next spawn for that session and killed —
  two writers on one session JSONL would corrupt the transcript.

Consequence: you can `kill -9` the whole tree at any moment and lose nothing
but wall-clock time; the next start resumes every job from exactly where the
transcript says it was.

### 1.3 Why the transcript is authoritative for agent state

Pi has no internal "todo/goal" state the dispatcher can read — **the session
transcript IS the agent's state**. Therefore:

- Every job pins a deterministic session id:
  `pi_session_id = "ctf-" + fingerprint.slice(7, 19)`.
- Continuations don't re-send context — they `resume()` the same session id;
  pi replays the prior transcript and the conversation continues.
- The dispatcher additionally asks the agent to curate its own state in
  `WRITEUP.md` (Facts / Hypotheses / Testing plan) — see
  [[Agent-Backends]] — which both survives kills (it's a file) and is what
  humans see in Discord panels.
- `digestForSession()` (agents/session-log.ts) parses the session JSONL to
  extract, per attempt: the final conclusion, tools used, and activity
  timestamps. This is *read-only* observation — the dispatcher never edits the
  transcript.

## 2. Orchestration: The Main Loop

`src/index.ts` wires exactly one of each component and lets them talk through
three narrow interfaces:

```
watcher.run(onDiscover)────────┐
webhook ──trigger()──► watcher │
                               ▼
              onDiscover(batch, solvedLines):
                1. lifecycle.pruneMissing(batch, queue.markDone)
                2. lifecycle.discover(batch, solvedLines)
                3. syncRepoReadme(src, jobsDir)
                4. queue.wake()
                               │
                               ▼
queue.run():  while true:
   - pick next pending job (rotation order, one-run-per-challenge)
   - NEW → lifecycle.stage(jobId)
   - lifecycle.runJob(backend, jobId)  ──► backend.submit/resume(spec)
   - result ──► classify() ──► lifecycle.applyOutcome()
       SOLVED/FATAL/BLOCKED → terminal, emit event
       CONTINUE → status AGENT_STOPPED (re-picked by the queue later)
```

Key orchestration properties:

- **Single writer discipline.** Only the queue starts runs; only the lifecycle
  writes job state; the DB is the meeting point. No component holds
  authoritative state outside it.
- **Events, not calls, for reporting.** Lifecycle emits `LifecycleEvent`s
  (`staged`, `started`, `solved`, `fatal`, `blocked`, `continue`); the reporter
  subscribes. Reporting can fail without touching the core loop.
- **Wake-based scheduling.** The queue sleeps when there is nothing to do;
  discovery, webhook activity, and human `markDone` all call `wake()`.

## 3. Discovery and Deduplication: Content Identity

A challenge's identity is **(path, source) + content fingerprint** — *not* the
commit SHA:

```
challengeFingerprint(ref) = sha256(
    sorted files: "name:mode:sha\n" for each file
).slice(24)   → "sha256:…" prefix
```

Consequences:

- Two commits with identical challenge content produce **one** job (a push that
  only changes `writeups/` triggers nothing).
- A push that changes **one** challenge creates **one** new job — the other
  challenges' fingerprints are unchanged, so they are skipped by
  `challengeExists(path, source, fingerprint)`.
- Challenge rows keep the real commit SHA too (`commit_sha` stores the
  fingerprint; the discovered revision is in the source listing) for
  provenance.

Test/demo-looking challenges (`^(test|demo|example|sample|scratch|tmp|...)`)
are ignored entirely — no rows, no panels.

**Skip-marking:** `SOLVED.txt` at the repo root or challenge root can
pre-mark challenges as solved — they are created directly in `SKIPPED`
status (useful for re-watching a competition repo after manually solving
something, or excluding challenges you don't want automated).

**Repo-wide info channel:** the repo's top-level `README.md` is synced into
every active workspace as `REPO-README.md` on every discovery pass. The
prompts instruct agents to read it first and re-read it when a connection/auth
step fails — credentials and instance URLs can be rotated mid-competition by
editing the repo README, with no dispatcher involvement.

## 4. Rotation: Round-Robin Turn-Taking

With multiple pending challenges and `MAX_CONCURRENT=1` (default), the queue
runs a **rotation system**:

- One "turn" = `TURN_MINUTES` (default 10) of wall-clock run time — implemented
  as the backend's run timeout for that run.
- When the turn expires, the run is killed (`killReason: "run-timeout"`),
  `WRITEUP.md` + session digest are captured into `progress`, the job's
  `last_rotated_at` is stamped, and the job goes to the **back** of the
  rotation order.
- The queue picks the next pending challenge (least-recently-rotated first;
  never-rotated jobs — brand-new challenges — get their first turn before any
  resume, so easy new challenges aren't starved behind hard old ones).
- After every challenge has had a turn, the initial challenge resumes — **same
  Pi session, same workspace, no context lost**.

The rotation ordering SQL (see [[Persistence-and-Database]]):

```sql
ORDER BY (last_rotated_at IS NULL) DESC, last_rotated_at ASC, id ASC
```

This makes the system good at *breadth-first* progress across a whole CTF
repository instead of tunnel-visioning on one challenge for `MAX_ATTEMPTS`
runs.

## 5. Polling vs Webhook

- **Polling** (`POLL_INTERVAL_SEC`, default 120) is the authoritative
  discovery path: every tick re-lists the source; if the revision changed, the
  full reconcile (prune/discover/README-sync) runs.
- **Webhook** (`dispatcher/webhook.ts`, optional, default enabled) is a
  tiny HTTP server: POST `/webhook`, HMAC-SHA256-verified against
  `WEBHOOK_SECRET` when set, filtered by repo and branch, and its only action
  is `watcher.trigger()` — pull the next poll forward.
- Failure modes are all benign: invalid signature → 403 + log; wrong repo or
  branch → ignored; webhook server fails to start at boot → dispatcher
  continues without it (polling still discovers everything, just later).

## 6. Crash Consistency Model

Because all state is either in the DB (synchronous writes, WAL) or
reconstructable from the transcript, the crash story is simple:

| Crash victim | What happens on restart |
| --- | --- |
| Dispatcher mid-run | `RUNNING` job → `AGENT_STOPPED` (continuation); next turn resumes the same session |
| pi agent mid-run | Transcript has a torn tail line — session-log parsing tolerates it; the next continuation continues from the last well-formed entries |
| Whole machine (VPS reboot) | Same as dispatcher crash; systemd `Restart=always` (or `run.sh`) brings it back; orphaned pi processes for a session are killed at that session's next spawn |
| Discord at publish time | Message is logged as failed; lifecycle state is unaffected; dedupe hash not recorded, so a re-event re-sends |

## 7. Invariants

If you're modifying the code, preserve these:

1. **One active run per challenge** (queue fairness rule).
2. **At most one writer per pi session** (orphan killing at spawn).
3. **Prune before discover** in every poll (else removed challenges linger).
4. **No state outside the DB survives a restart** (no "resume from memory").
5. **Publishing never blocks or fails the core loop.**
6. **The classifier never marks FATAL on a run that completed normally** unless
   the agent explicitly reported an infrastructure stop (false-fatals are the
   worst failure mode — see [[Outcome-Classification]]).
7. **Workspaces are copies, never the canonical repo.**
