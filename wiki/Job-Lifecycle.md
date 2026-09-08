# Job Lifecycle

The job state machine is implemented in `src/dispatcher/lifecycle.ts` and
driven by the queue (`src/dispatcher/queue.ts`). All transitions are
persisted synchronously in SQLite (see [[Persistence-and-Database]]); this page
walks the states, the transitions, and the rules that govern them.

## 1. State Machine

```
                     ┌──────────────────────────────────────────────┐
                     │                    SOLVED                     │
                     └──────────────────────────────────────────────┘
                                        ▲
NEW ──stage()──► STAGED ──run()──► RUNNING ────(STATUS: SOLVED)────────┘
                                  │   │
                                  │   ├──(fatal pattern / provider
                                  │   │   error / spawn fail)──► FATAL_ERROR
                                  │   ├──(attempts ≥ MAX_ATTEMPTS)─► BLOCKED
                                  │   └──(agent stopped unsolved /
                                  │       turn expired / killed)──► AGENT_STOPPED
                                  │            │                    (re-queued; loops
                                  │            └──resume()────────► back to RUNNING)
                                  └──(user ✅ / removed from repo)──► SKIPPED
```

`HANDED_OFF` is a legacy intermediate between STAGED and RUNNING (kept for
compatibility; recovery re-runs jobs found in it).

Challenge rows mirror the latest job's status (plus `REMOVED` after pruning),
so panels and dashboards only need one join.

## 2. Discovery → Job Creation

On every poll (see [[Source-of-Truth-and-Orchestration]]):

1. **Prune first** — `pruneMissing(batch, stopJob)`:
   - Challenges in the DB missing from the current repo listing are marked
     `REMOVED`; their non-terminal jobs are closed via `queue.markDone`
     (kills an in-flight run if any) so the queue stops working on them and
     panels show a final "removed from repo" state.
2. **Then discover** — `discover(batch, solvedLines)`:
   - Test/demo names (`test`, `demo`, `example`, `sample`, `scratch`, `tmp`,
     ...) are ignored — never tracked.
   - Dedupe: `challengeExists(path, source, fingerprint)` — already-known
     content identities are skipped.
   - `SOLVED.txt`-listed challenges (repo root or challenge root) are created
     directly as `SKIPPED` — no job will run for them.
   - Otherwise: INSERT challenge (`NEW`) + INSERT job (`NEW`) with:
     - `workspace = <jobsDir>/<sanitized-name>-<sha8>` (deterministic)
     - `pi_session_id = "ctf-" + fingerprint.slice(7,19)` (deterministic —
       the resumable session identity)

## 3. Staging

`stage(jobId)` (only for `NEW` jobs, immediately before their first run):

1. Recreate the `ChallengeRef` from the stored `files_json` snapshot.
2. `stageChallenge()` downloads every file into the workspace
   (`safeJoin` refuses traversal; `100755` modes preserved), writes
   `staged-manifest.json`.
3. Write `task.txt` (the initial prompt — same text the first run gets) and
   `AGENTS.md` (persistent workspace rules; pi auto-loads it).
4. Job → `STAGED`, challenge → `STAGED`, `staged` event.

Staging is **idempotent** — re-running just re-downloads over the same layout.

## 4. Running

`runJob(backend, jobId, onSpawn)`:

1. Load job + challenge. `isResume = attempts > 0`.
2. Prompt = `buildInitialPrompt(name)` or `buildContinuationPrompt(attempts+1)`
   (see [[Agent-Backends]] for prompt contents — the continuation prompt is a
   *nudge*: it instructs the agent to re-read WRITEUP.md and REPO-README.md,
   never restart from scratch, and rotates through strategic hints).
3. `backend.resume(spec)` / `backend.submit(spec)`; `onSpawn(handle)` lets the
   queue keep the kill switch.
4. Persist `RUNNING` + `pid` + `started_at`; challenge → `RUNNING`; `started`
   event (resume flag distinguishes "continuing (attempt N)" from "started").
5. `await handle.result` — the AgentRunResult (see [[Agent-Backends]]).
6. Persist `last_output` (transcript/raw tail), clear `pid`.
7. `classify(result, attempts+1, maxAttempts, workspace)` → outcome.
8. `applyOutcome(jobId, outcome, {killReason})`.

## 5. Applying Outcomes

`applyOutcome` is the only place terminal/recoverable state is written:

**Before anything else** — per-attempt harvest (always):

- `digestForSession(pi_session_id, workspace)` → this attempt's conclusion,
  tool names/count, last activity — **the session digest is authoritative for
  conclusions** (it survives kills that prevented a final message).
- `WRITEUP.md` content from the workspace.
- `upsertProgress(jobId, attempt, outcome.kind, ...)`.

**Then the transition:**

| Outcome | Job → | Challenge → | Event |
| --- | --- | --- | --- |
| `SOLVED` (flag, summary) | `SOLVED`, `solved=1`, `attempts+1`, `last_flag`, `last_summary`, `last_error=null` | `SOLVED` | `solved` (reporter sends ✅ + flag; bot also @everyone-announces) |
| `FATAL` (reason) | `FATAL_ERROR`, `last_error=reason` | `FATAL_ERROR` | `fatal` (⛔ message) |
| `BLOCKED` (reason) | `BLOCKED`, `last_error=reason` | `BLOCKED` | `blocked` (⏸ message) |
| `CONTINUE` | `AGENT_STOPPED`, `attempts+1`, `last_summary` | `AGENT_STOPPED` | `continue` — *not terminal*: the queue re-picks it later in rotation order |

Special cases inside `applyOutcome`:

- **User already marked done**: if the job was set `SKIPPED` while the run was
  in flight (✅ reaction), the outcome is *ignored* — a killed run must not
  resurrect the job as `AGENT_STOPPED`.
- **Turn expiry**: when `killReason === "run-timeout"` under the rotation
  system, the CONTINUE is logged as a **turn expiry** — WRITEUP was captured,
  the job rotates to the back of the queue; the next round resumes the same
  session. (Not an error, not an attempt failure.)

The classification rules themselves (which runs are SOLVED/FATAL/CONTINUE/
BLOCKED and why) are on [[Outcome-Classification]].

## 6. What Ends a Job

- **SOLVED** — agent reports `STATUS: SOLVED` (or writes a solved
  `SOLUTION.md`).
- **FATAL_ERROR** — a condition no amount of retrying can fix:
  - spawn failure (pi binary missing, workspace gone),
  - a *permanent* provider transport error on the agent's final message
    (pi's structured `stopReason: "error"` + `errorMessage` — 401/403, quota,
    billing),
  - a pi CLI startup error on stderr (`Error: Model ... not found` — agent
    tool output never reaches pi's stderr, so this is precise),
  - or the agent explicitly reporting it cannot continue due to
    infrastructure.
- **BLOCKED** — `MAX_ATTEMPTS` exhausted without solving (gave it N honest
  tries; needs a human).
- **SKIPPED** — human decision (✅ reaction on the panel) or `SOLVED.txt`.

Anything else — including run timeouts and idle timeouts — is **recoverable**:
`AGENT_STOPPED`, re-enqueued with a continuation prompt.

## 7. Continuation Forcing ("not solved is not failure")

The central loop of the whole system:

1. Agent stops without SOLVED and without a fatal condition.
2. Classifier returns `CONTINUE` (or the turn expired).
3. Job → `AGENT_STOPPED`; attempts+1.
4. Queue re-picks it (rotation order) and `runJob` sees `attempts > 0` →
   `buildContinuationPrompt(attempts+1)` → `backend.resume(spec)` — **same
   session id** (full transcript), **same workspace** (all artifacts).
5. The continuation prompt nudges strategy rotation (take stock / different
   approach class / re-derive assumptions / easier wins / explicit plan /
   minimal reproducer — cycled), and forces re-reading WRITEUP.md and
   REPO-README.md so no work is redone and new credentials are noticed.
6. Repeat until SOLVED, FATAL, BLOCKED, or SKIPPED.

The only budget is `MAX_ATTEMPTS` (default 20) → `BLOCKED`.

## 8. Startup Recovery

On every start (`recoverInterruptedJobs` in `lifecycle.ts`, wired in
`index.ts`):

- **`RUNNING`** jobs → their owning process is gone by definition → job
  becomes `AGENT_STOPPED` (a continuation; the backend kills any orphaned pi
  process for that session at next spawn before resuming).
- **`STAGED` / `HANDED_OFF`** jobs → re-run (staging idempotent).

So a dispatcher restart, VPS reboot, or `kill -9` never loses a challenge —
every job resumes from its transcript on the next turn.

## 9. Human Interactions with the Lifecycle

- **✅ reaction on a panel** → `queue.markDone(jobId, "done reaction")`:
  kills an in-flight run, job ends `SKIPPED` (and later run outcomes for it
  are ignored — see §5).
- **`SOLVED.txt`** in the repo → discovery-time skip (job created `SKIPPED`).
- **Removing a challenge from the repo** → prune closes it out.
- **Editing a challenge's files** → new content fingerprint → new challenge
  row + new job (the old job's history stays).
- **Editing the repo top-level README** → `REPO-README.md` refreshed into all
  active workspaces on the next poll (no job state changes).
