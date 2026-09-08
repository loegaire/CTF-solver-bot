# Persistence and Database

ctf-worker persists **all dispatcher lifecycle state** in a single SQLite
database (`DB_PATH`, default `data/ctf-worker.db`) via
[better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (synchronous, no
ORM). The schema records *lifecycle state only — never agent reasoning*.

The database is the source of truth for *what has happened* (see
[[Source-of-Truth-and-Orchestration]]): every job/challenge state transition is
a synchronous write, so the dispatcher can be killed at any instant and restart
into a consistent picture.

## 1. File Layout and PRAGMAs

```
<DB_PATH>              the database
<DB_PATH>-wal          write-ahead log (journal_mode = WAL)
<DB_PATH>-shm          shared memory index
```

`schema.sql` sets `PRAGMA journal_mode = WAL` on creation — readers (CLI,
Discord bot `/status`, status-dump) never block the writer, and a crash
mid-transaction rolls back cleanly. Better-sqlite3 runs everything
synchronously in-process; the dispatcher is single-writer by construction
(only the queue + lifecycle write).

## 2. Schema (src/database/schema.sql)

### 2.1 `challenges` — a discovered challenge (content identity)

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | INTEGER PK | row id |
| `path` | TEXT | full path in source, e.g. `challenges/neon` |
| `source` | TEXT | source id, e.g. `github:owner/name@main` |
| `commit_sha` | TEXT | **content fingerprint** at discovery (`sha256:` + 24 hex) — not the git SHA; see below |
| `files_json` | TEXT | JSON snapshot of the file list at discovery |
| `discovered_at` | TEXT | ISO timestamp |
| `status` | TEXT | one of `CHALLENGE_STATES` (mirrors job status + `REMOVED`) |
| | | **UNIQUE (path, source, commit_sha)** — the dedupe key |

Notes:

- `commit_sha` stores the **content fingerprint**
  (`sha256(sorted "name:mode:sha" lines)`), because job identity must be
  stable across commits that don't change the challenge (see
  [[Source-of-Truth-and-Orchestration]] §3).
- The `UNIQUE (path, source, commit_sha)` constraint is the race-proof dedupe:
  `insertChallenge` uses `INSERT OR IGNORE` and treats "0 changes" as
  "already known".

### 2.2 `jobs` — one solving job per challenge identity

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | INTEGER PK | job id (what `#12` refers to everywhere) |
| `challenge_id` | INTEGER FK → challenges | |
| `workspace` | TEXT | absolute path of the staged workspace |
| `pi_session_id` | TEXT **UNIQUE** | deterministic pi session id, `ctf-<12 hex of fingerprint>` |
| `status` | TEXT | job state machine — see [[Job-Lifecycle]] |
| `attempts` | INTEGER | completed runs so far (incremented on every outcome) |
| `solved` | INTEGER | 1 when SOLVED |
| `last_flag` | TEXT | extracted flag, if any |
| `last_summary` | TEXT | last agent conclusion / outcome summary |
| `last_output` | TEXT | tail of the most recent agent stdout (bounded) |
| `last_error` | TEXT | fatal error description, if any |
| `pid` | INTEGER | pid of the current/last run (NULL when not running) |
| `started_at` | TEXT | current run start (ISO) |
| `last_rotated_at` | TEXT | when this job last got a turn — **the rotation ordering key** |
| `created_at` / `updated_at` | TEXT | bookkeeping |

Indexes: `idx_jobs_status (status)`, `idx_jobs_challenge (challenge_id)`.

State values (`JOB_STATES` in `db.ts`):

```
NEW → STAGED → HANDED_OFF → RUNNING → { SOLVED | FATAL_ERROR | BLOCKED | SKIPPED }
                                └→ AGENT_STOPPED (recoverable; loops back to RUNNING)
```

plus `CHALLENGE_STATES` which adds `REMOVED` (pruned from the repo).

### 2.3 `progress` — per-attempt record (the audit trail)

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `job_id` | INTEGER FK → jobs | |
| `attempt` | INTEGER | 1-based attempt number |
| `status` | TEXT | outcome of the attempt: `CONTINUE / SOLVED / FATAL / BLOCKED` |
| `conclusion` | TEXT | the agent's final message for this attempt (from the pi session log) |
| `writeup` | TEXT | content of `WRITEUP.md` at the end of the attempt |
| `tool_calls` | INTEGER | number of tool calls this attempt |
| `tools_used` | TEXT | distinct tool names, comma-separated |
| `activity_at` | TEXT | last session activity timestamp |
| `created_at` / `updated_at` | TEXT | bookkeeping |
| | | **UNIQUE (job_id, attempt)** |

Written by `upsertProgress` (INSERT ... ON CONFLICT UPDATE) at the end of
every attempt — after the run dies (however it died), the dispatcher harvests:

1. `digestForSession(pi_session_id, workspace)` → per-attempt conclusion, tool
   stats, activity (the **session digest is authoritative for conclusions** —
   it survives even when the run was killed before emitting a final message);
2. `WRITEUP.md` from the workspace (the agent's own curated state).

Index: `idx_progress_job (job_id)`.

### 2.4 `messages` — publish dedupe ledger

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `job_id` | INTEGER FK → jobs | |
| `destination` | TEXT | publisher name, e.g. `discord` |
| `content_hash` | TEXT | sha256 of the sent content |
| `external_message_id` | TEXT | (reserved) id at the destination |
| `created_at` | TEXT | |

Index: `idx_messages_dedupe (destination, content_hash)`.

Before sending, `messageAlreadySent(destination, hash)` is checked; after a
successful send, `insertMessage` records the hash. `SQLITE_CONSTRAINT_UNIQUE`
on insert is treated as "already sent" (returns false). This makes reporting
exactly-once per unique content, even across dispatcher restarts — and makes
re-publishing safe after crashes. Status dashboards (periodic snapshots) are
deliberately **not** deduped (they're raw `publish` calls).

### 2.5 `meta` — key/value scratch

`key TEXT PRIMARY KEY, value TEXT` — generic store (`getMeta`/`setMeta`),
currently unused by the core (available for future bookkeeping without a
schema change).

## 3. Lifecycle of Rows

```
poll → pruneMissing:   challenges missing from repo → status REMOVED
                       (+ their non-terminal jobs closed out)
     → discover:       new (path, source, fingerprint) → INSERT challenge
                       + INSERT job (NEW, or SKIPPED when SOLVED.txt-listed)
run  → stage:          job NEW → STAGED (workspace filled)
     → runJob:         job → RUNNING (pid, started_at stamped)
     → applyOutcome:   progress row (attempt N) upserted
                       job → SOLVED | FATAL_ERROR | BLOCKED | AGENT_STOPPED
                       challenge.status mirrors the job's
kill -9 everything
     → restart:        RUNNING jobs → AGENT_STOPPED (continuation)
                       STAGED/HANDED_OFF → re-run
```

Deletes: `prune.test.ts` and the `migrateLegacy` tombstone purge delete
`challenges`/`jobs`/`progress`/`messages` rows when the repo drops a
challenge. Terminal-but-present history (solved jobs, fatal jobs) is kept —
it's the audit record.

## 4. The `db.ts` API (src/database/db.ts)

Grouped by concern — all synchronous, all prepared-statement based:

**Open/close/pragma**

- `openDb(dbPath)` — opens, applies `schema.sql` (idempotent
  `CREATE TABLE IF NOT EXISTS`), runs `migrateLegacy`
- `closeDb()`

**Migrations**

- `migrateLegacy(d)` — additive `ALTER TABLE` for columns added after the
  first release (`last_rotated_at`); one-time purge of pre-purge `REMOVED`
  tombstone challenges (repo is the source of truth — history of *current*
  challenges only)

**Challenges**

- `insertChallenge({...}) → ChallengeRow | null` (null = deduped away)
- `getChallengeById`, `setChallengeStatus`, `getChallengesByStatus`
- `challengeExists(path, source, commitSha) → boolean` — the discovery dedupe
- `getChallengeIdByJob(jobId)`
- `getTrackedChallengePaths(source)` / `getChallengesBySourcePath(source, path)`
  — used by `pruneMissing`

**Jobs**

- `insertJob({challengeId, workspace, piSessionId, status?}) → JobRow`
- `getJobById`, `getJobByChallenge` (latest job for a challenge)
- `updateJob(id, fields)` — dynamic partial update (also stamps `updated_at`)
- `getJobsByStatus` / `getJobsByStatuses` / `countJobsByStatus`
- `getRecentJobsWithChallenge(limit)` — join for dashboards/CLI
- `getRotationOrderedPending()` — **the rotation query**:
  pending (`AGENT_STOPPED`, `STAGED`, `NEW`) joined with challenge paths,
  `ORDER BY (last_rotated_at IS NULL) DESC, last_rotated_at ASC, id ASC`
- `getAllJobsWithChallengePath()` — panel sync

**Progress**

- `upsertProgress({jobId, attempt, status, conclusion?, writeup?, toolCalls?,
  toolsUsed?, activityAt?})`
- `getProgress(jobId) → ProgressRow[]`

**Messages (dedupe)**

- `insertMessage({...}) → boolean` (false = duplicate)
- `messageAlreadySent(destination, contentHash) → boolean`

**Meta**

- `getMeta(key)` / `setMeta(key, value)`

**Row types** exported for the rest of the codebase: `ChallengeRow`, `JobRow`,
`ProgressRow`, `MessageRow`, plus the `JOB_STATES` / `CHALLENGE_STATES`
const arrays (the TS-level enum mirrors of the schema).

## 5. Concurrency and Access Patterns

- **Single process, single writer.** The dispatcher owns the write connection.
- **Concurrent readers are safe and common** — WAL mode means the CLI
  (`node dist/cli.js status <db>`), the Discord bot (opens its own read-only
  handle for `/status`), and the PanelManager can all read while runs are in
  flight.
- **Prepared statements** are cached per function; better-sqlite3 runs them
  synchronously on the main thread — the dispatcher is deliberately
  event-loop-friendly: the only async parts are network (source downloads,
  Discord) and child processes (pi).
- **No transactions across awaits** — every write is a single statement or a
  tight synchronous transaction (e.g. the tombstone purge), so a crash can
  never leave a half-applied transition.

## 6. Durability Guarantees

- WAL + synchronous writes → every completed statement is durable across
  process crash (and machine crash, subject to SQLite's normal fsync
  semantics).
- The `messages` unique constraint gives exactly-once publishing per content
  hash even across restarts.
- The `jobs.pi_session_id UNIQUE` constraint enforces the deterministic
  session-id discipline at the storage layer, not just by convention.

## 7. Backups and Inspection

The DB is a single file plus `-wal`/`-shm` — to back up or copy while
running, use `sqlite3 <db> ".backup '<dest>'"` (or stop the worker). To
inspect:

```bash
sqlite3 data/ctf-worker.db
sqlite> SELECT status, COUNT(*) FROM jobs GROUP BY status;
sqlite> SELECT j.id, c.path, j.status, j.attempts, j.last_flag
        FROM jobs j JOIN challenges c ON c.id = j.challenge_id
        ORDER BY j.updated_at DESC LIMIT 20;
```

Or use the CLI helpers (`cli.ts`):

```bash
node dist/cli.js status data/ctf-worker.db   # counts + recent jobs
node dist/cli.js jobs   data/ctf-worker.db   # all jobs table
node dist/cli.js show 3 data/ctf-worker.db    # one job, full detail
```

And in Discord: `/status` dumps the entire DB through the same renderer
(`discord/status-dump.ts`) — see [[Discord-Integration]].
