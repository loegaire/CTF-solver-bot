# Testing

Tests use the Node built-in runner (`node:test`) via `tsx`:

```bash
npm test        # tsx --test test/*.test.ts
```

44 tests, all offline (no network, no model). The `EchoBackend`
([[Agent-Backends]] §3) is what makes full-lifecycle tests possible: it
emits exactly the shapes the classifier consumes (`STATUS:` markers, fatal
error texts) deterministically, per the `echo-directive.txt` file in a
workspace or the `ECHO_SCRIPT` default.

## Suites

### `test/classifier.test.ts` — the classification matrix

Pins every rule in [[Outcome-Classification]]:

- `STATUS: SOLVED` marker → SOLVED with flag extraction
- `STATUS: UNSOLVED` → CONTINUE ("not solved is not failure")
- no marker → CONTINUE as recoverable default
- attempts exhausted → BLOCKED
- SOLVED status wins over a trailing provider error (a completed conclusion
  is authoritative)
- UNSOLVED + trailing provider error → CONTINUE, not FATAL
- permanent provider error *without* any conclusion → FATAL (it prevented the
  work)
- provider transport error (pi `stopReason:"error"`) → FATAL
- `503 cache_only_cold` (free-tier cold cache) → CONTINUE, not FATAL
- transient 503 at the attempt limit → BLOCKED (not FATAL)
- auth/quota provider errors remain FATAL (retrying cannot fix money/keys)

### `test/e2e.test.ts` — full lifecycle with the echo backend

Drives the real `Lifecycle` + `Queue` + DB end-to-end:

- discover → stage → run → forced continuation → BLOCKED (attempt budget)
- re-discovery identity: unchanged content does not create a second job
- interrupted-run recovery (RUNNING → continuation on startup)

### `test/discovery.test.ts` — grouping + fingerprints

`groupChallenges` prefix modes (auto/""/pinned), `exclude` handling, test/
demo-name filtering, and the content-fingerprint identity rules.

### `test/prune.test.ts` — repo-sync pruning

- challenges removed from the source are closed out (jobs stopped, state
  final)
- prune is a no-op when nothing was deleted
- DB-only-tracks-what-the-repo-has invariant

## Manual smoke tests

From the README quick start — a fully offline lifecycle test without any
model:

```bash
SOURCE=local LOCAL_SOURCE_DIR=/tmp/challenges AGENT_BACKEND=echo \
  ECHO_SCRIPT=unsolved MAX_ATTEMPTS=3 DB_PATH=data/demo.db \
  JOBS_DIR=data/jobs WEBHOOK_ENABLED=false npm start
```

The echo backend runs, reports unsolved, and is forced to continue until
`MAX_ATTEMPTS` → BLOCKED. With `ECHO_SCRIPT=solved` it solves immediately.
`--scan` / `--once` modes give one-shot discovery / drain passes:

```bash
npm run scan    # tsx src/index.ts --scan
npm run once    # tsx src/index.ts --once
```

## What is deliberately *not* tested automatically

- Real pi runs (provider config, model quality) — covered by the live
  validation suite and the classifier's structured-signal-first design.
- Discord delivery — publishers are fire-and-forget by design; dedupe logic
  is DB-level and covered by the e2e suite's message assertions.
