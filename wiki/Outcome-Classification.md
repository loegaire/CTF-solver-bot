# Outcome Classification

`src/errors/classifier.ts` is the "continue vs stop" decision point of the
whole system. Given an `AgentRunResult` (see [[Agent-Backends]]) plus attempt
counts and the workspace path, `classify()` returns exactly one of:

```ts
type Outcome =
    | { kind: "SOLVED";  flag: string | null; summary: string }
    | { kind: "CONTINUE"; summary: string; reason: string }
    | { kind: "FATAL";   summary: string; reason: string }
    | { kind: "BLOCKED"; summary: string; reason: string };
```

The governing principle: **"not solved is not failure."** An agent that
merely stops without solving is forced to continue; only conditions that no
amount of retrying can fix end the job early.

## 1. Decision Order (as implemented)

The checks run in a strict order — earlier checks win:

```
1. spawn failure                       → FATAL (always)
2. explicit STATUS marker              → SOLVED / UNSOLVED (authoritative,
                                         even over a trailing provider error)
3. provider transport error            → transient → CONTINUE (retry)
   (pi stopReason:"error" on the        permanent (auth/quota/billing) → FATAL
    final message)
4. run completed normally?
   4a. YES + agent-reported fatal      → FATAL (explicit "cannot continue
       construction (AGENT_REPORTED_)      because infrastructure" phrasing)
   4b. NO (abnormal end) + fatal text  → FATAL (pattern scan of stderr and
       patterns in stderr/stdout tails    the END of the raw stream only)
5. SOLUTION.md with a solved status    → SOLVED (backup marker)
6. attempts ≥ MAX_ATTEMPTS             → BLOCKED
7. otherwise                           → CONTINUE (recoverable by default)
```

### 1.1 Spawn failure (step 1)

`spawnError` is set by the backend when the process never started (pi binary
missing, workspace deleted). Nothing can fix that → FATAL with the
description.

### 1.2 The STATUS protocol (step 2)

Every run must end its final message with exactly one line:

```
STATUS: SOLVED
STATUS: UNSOLVED
```

Enforced by the initial and continuation prompts ([[Agent-Backends]]). The
classifier extracts the marker from the final assistant message:

- `STATUS: SOLVED` → outcome SOLVED; flag extracted from a `Flag: ...` line
  (nearby, with brace heuristics — the flag is usually the first
  brace-containing token on the line).
- `STATUS: UNSOLVED` → *by definition recoverable* → CONTINUE (or BLOCKED at
  the attempt limit).
- A completed run's explicit verdict is **authoritative even if a transient
  provider error surfaced on the very last message** (e.g. the follow-up
  request rate-limited after the agent already concluded) — provider health
  only matters when it *prevented* a conclusion.

### 1.3 Provider transport errors (step 3)

When pi ends a run with a structured `stopReason: "error"` + `errorMessage`
(surfaced by the backend as `providerError`), the classifier splits by
recoverability (`transportErrorKind`):

- **Transient → CONTINUE** (retry): 5xx, overloaded, `cache_only_cold`
  (free-tier cold cache), generic network blips. The free tier throws these
  constantly; retrying the run fixes them.
- **Permanent → FATAL** (retrying cannot fix money or keys): 401/403,
  unauthorized/forbidden, invalid API key, quota/billing/payment/credit
  exhausted.

At the attempt limit, transient errors produce **BLOCKED, not FATAL** (they
weren't fatal — the budget just ran out).

### 1.4 Completed-normally fatal reports (step 4a)

A run that exited cleanly and produced a final message is never
fatal-pattern-matched against transport regexes — challenge tool output
legitimately contains strings like "403 Forbidden" (a CTF server rejecting an
exploit!) or "rate limit". Instead, fatal requires an **explicit
agent-reported infrastructure stop**, matched by `AGENT_REPORTED_FATAL`
patterns like:

```
cannot|unable to|can't|failed to  +  continue|proceed|make progress|reach|access
... (auth|quota|billing|api key|credit|balance|payment) ...
```

with a `label` like "agent-reported auth/quota error". The matched context
(±~120–220 chars) is kept as the summary for the report.

### 1.5 Abnormal-end pattern scan (step 4b)

Only when the run **did not complete normally** (crash, kill, empty output) are
the `FATAL_PATTERNS` regexes run — and only against:

- the tail of **stderr** (agent tool output never reaches pi's stderr — a pi
  CLI startup error like `Error: Model ... not found` is precise), and
- the **end** of the raw stdout stream (last 4096 chars), and
- the last 2048 chars of the transcript tail.

Patterns and labels:

| Label | Matches (examples) |
| --- | --- |
| auth failure | `401/403 … unauthorized/forbidden/token/api key` (and reversed) |
| rate limit | `429`, `rate limit(ed)` |
| quota exhausted | `quota` |
| billing required | `billing`, `payment required` |
| invalid API key | `invalid/missing/expired api key` (both orders) |
| agent CLI error | `^\s*Error:\s+\S` on stderr (pi startup errors) |
| pi executable unavailable | `executable … not found`, `no such file … pi` |
| model unavailable | `no model(s)`, `no provider`, `no api key configured` |
| permission denied | `permission denied` |
| filesystem error | `EACCES`, `EISDIR` |
| network failure | `ENOTFOUND`, `ECONNREFUSED`, `EAI_AGAIN`, `ETIMEDOUT` |
| resource exhaustion | `ENOSPC`, `EMFILE`, `ENOMEM` |
| crash | `segmentation fault` |

**Why the END of streams only:** transient transport errors that pi
auto-recovered mid-run appear in the middle of the raw stream; if the run
then completed, they don't matter. Scanning only the end means a pattern only
counts if the run actually *died* with it.

### 1.6 SOLUTION.md fallback (step 5)

No STATUS marker but a `SOLUTION.md` exists in the workspace with
`Status: SOLVED` (and a `Flag:` line) → SOLVED. The prompts instruct the
agent to write this file on success, so a killed run that had *just* solved
and written the file still counts.

### 1.7 BLOCKED (step 6)

`MAX_ATTEMPTS` (default 20) exhausted without SOLVED → BLOCKED with reason
`attempt limit reached (N)`. This is the honest "needs a human" state — it is
not an error.

## 2. Worked Examples

| Run | Classification |
| --- | --- |
| Clean exit, final message ends `STATUS: SOLVED`, `Flag: flag{...}` | **SOLVED** |
| Clean exit, `STATUS: UNSOLVED`, attempts 3/20 | **CONTINUE** ("agent reported UNSOLVED") |
| Clean exit, `STATUS: UNSOLVED`, attempts 20/20 | **BLOCKED** |
| Clean exit, final message: "the challenge server returned 403 Forbidden on my exploit" | **CONTINUE** (completed normally; transport patterns not scanned) |
| Clean exit, "I cannot continue: the API key is invalid" | **FATAL** (agent-reported, AGENT_REPORTED_FATAL) |
| `stopReason:"error"` = 503 cache_only_cold, attempts 5/20 | **CONTINUE** (transient) |
| `stopReason:"error"` = 503, attempts 20/20 | **BLOCKED** (not fatal) |
| `stopReason:"error"` = 401 unauthorized | **FATAL** (permanent) |
| Exit 0 but no output at all, stderr ends `Error: Model xyz not found` | **FATAL** (agent CLI error) |
| Killed at TURN_MINUTES (rotation), WRITEUP captured | **CONTINUE** — logged as turn expiry; job rotates |
| Idle-timeout kill (no stream activity) | **CONTINUE** (recoverable) |
| pi binary missing | **FATAL** (spawn failure) |
| Killed by user ✅ then outcome arrives | ignored (job stays SKIPPED) |

## 3. Design Rationale: False-Fatals Are the Worst Failure Mode

A false-FATAL aborts a healthy, potentially solvable challenge — the exact
opposite of the system's purpose. Hence the deliberate layering:

1. **Structured signal first** (pi's own `errorMessage` on the final message
   is authoritative — transient 429s that pi auto-retried mid-run never
   surface there).
2. **Text patterns only on abnormal ends**, and only at the *end* of streams.
3. **Agent-reported fatals on normal completion** need an explicit
   "cannot continue because" construction.
4. **The STATUS verdict beats everything** except spawn failure.

The test suite (`test/classifier.test.ts`) pins this matrix — see
[[Testing]]. The live validation suite confirmed: an agent *discussing* "403
Forbidden" from a challenge server continues; a provider 403 ends the job.

## 4. Where Outcomes Go

`applyOutcome` (see [[Job-Lifecycle]] §5) maps outcomes onto job/challenge
state, progress rows, and lifecycle events; the reporter turns those into
Discord messages (✅ SOLVED, ⛔ fatal, ⏸ blocked, ↻ continuing).
