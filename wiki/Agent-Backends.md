# Agent Backends

The dispatcher is decoupled from *how* the agent is launched and observed
through a small contract in `src/agents/backend.ts`. Everything the lifecycle
needs is: start a run, observe its result, kill it.

```ts
export interface AgentJobSpec {
    jobId: number;          // dispatcher job id
    challengeName: string;  // display name
    workspace: string;      // absolute workspace dir; also the agent cwd
    sessionId: string;      // backend-defined persistent session id
    name: string;           // human-readable run/session name
    prompt: string;         // full prompt (initial or continuation)
    attempts: number;       // attempts already consumed (0 on first)
}

export interface AgentRunResult {
    exitCode: number | null;       // null when killed by signal / no spawn
    signal: string | null;
    killed: boolean;               // dispatcher killed it
    killReason: string | null;      // 'run-timeout' | 'idle-timeout' | 'dispatcher-shutdown' | null
    spawnError: string | null;      // process never started (binary missing, ...)
    lastAssistantText: string;     // agent's closing report
    transcriptTail: string;       // compact human-readable tail
    rawTail: string;              // tail of raw stdout (JSON events) — fatal scanning
    stderrTail: string;           // agent's own diagnostics (NOT tool output)
    providerError: string | null; // pi stopReason:"error" transport error, if any
    durationMs: number;
}

export interface AgentRunHandle {
    readonly pid: number | null;
    readonly result: Promise<AgentRunResult>;
    kill(reason: string): Promise<void>;
}

export interface AgentBackend {
    readonly name: string;
    submit(spec: AgentJobSpec): AgentRunHandle;  // fresh run
    resume(spec: AgentJobSpec): AgentRunHandle;  // continuation, same session
}
```

Implementations: **PiBackend** (production, `pi --mode json`), **PiRpcBackend**
(`pi --mode rpc`, interactive steer/abort), **EchoBackend** (deterministic
fake for tests). All live in `src/agents/`.

---

## 1. PiBackend (`src/agents/pi.ts`) — production

Spawns headless pi runs:

```
pi --mode json --session-id <spec.sessionId> --name <spec.name> \
   --no-approve --no-extensions --no-prompt-templates \
   [PI_EXTRA_ARGS...] -- <prompt>
```

- **cwd = the job workspace**, so every tool call operates on the staged
  challenge files.
- `--session-id` is the dispatcher's deterministic id (`ctf-<fingerprint12>`)
  — this is what makes continuations *resume* rather than restart: pi appends
  to the same session file and replays the prior transcript.
- `--no-approve` — fully autonomous (no permission prompts).
- `PI_EXTRA_ARGS` is appended to every invocation (e.g. pin
  `--provider X --model Y`).
- pi reads its own model/auth config from `~/.pi/agent`
  (`settings.json`, `models.json`, `auth.json`) — the dispatcher never
  touches credentials.

**Orphan protection:** before spawning, `findProcesses` looks for any
leftover process whose command line contains the session id (e.g. after the
dispatcher was `kill -9`-ed) and kills the whole process group — two writers
on one session JSONL would corrupt the transcript.

**Timeouts** (options):

- `runTimeoutMin` — wall-clock cap. Under the rotation system this equals
  `TURN_MINUTES`: expiring it *is* the turn-expiry signal
  (`killReason: 'run-timeout'`).
- `idleTimeoutMin` — no-stream-activity cap (a wedged provider or infinite
  tool loop produces no JSON events; this catches it).
- Kill: SIGTERM to the process group, then SIGKILL after `killGraceSec`.

**Output handling:** pi emits JSONL events on stdout. The backend parses:

- `message` events → tracks the last assistant text; captures
  `stopReason: "error"` + `errorMessage` on the final message (→
  `providerError` — the structured signal the classifier trusts).
- `tool_execution_start` / tool-name fields → tool stats.
- Tails are bounded buffers (`Tail`): raw stdout 64k, transcript 8k,
  assistant text 12k, stderr 8k — the DB stores tails, not archives.
- **stderr is pi's own diagnostics** — agent *tool* output never reaches it,
  which is why the classifier's stderr scan is precise.

`submit` and `resume` both map to the same run (the session id + transcript do
the resuming); `resume` exists so other backends can differ.

## 2. PiRpcBackend (`src/agents/pi-rpc.ts`) — interactive control

Runs `pi --mode rpc` as a **long-lived child per job** instead of one-shot
json runs. Same `AgentBackend` contract, plus interactive extensions on the
handle:

```ts
handle.steer(message: string): Promise<boolean>  // inject a user message
                                                  // into the RUNNING agent
handle.abort(): Promise<void>                     // stop the current turn
```

This is what unlocks live control: steering a running agent ("someone replied
in Discord: try X"), aborting a turn (the ✅ done reaction), and keeping one
session alive across continuations.

**Framing:** strict JSONL over stdin/stdout, LF-only — the code deliberately
does *not* use `readline` because readline splits on U+2028/U+2029, which is
not protocol-compliant. A custom `StringDecoder`-based line reader is used.

Steer resolves `true` when pi acknowledges, `false` on a 30s timeout; `abort`
sends the abort command (the run's result then settles as a killed/aborted
turn).

## 3. EchoBackend (`src/agents/echo.ts`) — deterministic tests

Simulates outcomes without any model:

- Scenario = `ECHO_SCRIPT` (`solved` | `unsolved` | `fatal`) or, per-job, the
  content of `echo-directive.txt` in the workspace (lets a single test drive
  different outcomes for different challenges).
- Emits exactly the shapes the classifier consumes: e.g. `solved` ends with
  `Flag: FLAG{echo_solved}\n\nSTATUS: SOLVED`; `fatal` emits an auth-failure
  error text; `unsolved` ends `STATUS: UNSOLVED`.
- Honors `kill()` (marks killed with the reason), simulates duration
  (`durationMs`, default 150ms).

This backend is what `test/e2e.test.ts` uses to drive the full lifecycle
end-to-end (see [[Testing]]).

## 4. Prompts (`src/agents/prompts.ts`)

The STATUS protocol makes outcomes machine-readable; the prompts enforce it
(see [[Outcome-Classification]]).

### 4.1 Initial prompt (`buildInitialPrompt`) — also written to `task.txt`

Instructs the agent to:

- read the workspace README + inspect all files; the dir is a **persistent
  workspace** (everything written survives across runs);
- read `REPO-README.md` **first** — the repo-wide channel for instance URLs,
  credentials, login tokens; re-read it when a step fails in a way fresh
  credentials might fix;
- prefer configured specialized tools/skills (radare2/playwright MCP, CTF
  skills) over manual work;
- **maintain `WRITEUP.md`** continuously — three sections:
  - `## Facts` — verified truths (with how each was verified),
  - `## Hypotheses` — each marked CONFIRMED or REFUTED as tested; confirmed
    ones move to Facts; **never re-test a refuted hypothesis**,
  - `## Testing plan` — current concrete next steps;
- verify candidate flags when the challenge allows;
- **never stop merely because it isn't solved yet** ("a lack of progress is
  not a reason to terminate") — only solving or a fatal external error ends
  work;
- end the final message with exactly `STATUS: SOLVED` or `STATUS: UNSOLVED`;
- on success, write `SOLUTION.md` (Status / Flag / Summary / Artifacts).

### 4.2 Continuation prompt (`buildContinuationPrompt(attempts)`)

Sent on every resume:

- states the attempt number and that stopping is not an option ("that is only
  one approach failing, not the job");
- forces re-reading `WRITEUP.md` (recall facts, don't redo work) and
  `REPO-README.md` (credentials may have rotated);
- injects a rotating **nudge** — one of six strategic hints, cycled by attempt
  number:
  1. Take stock (established/unverified/promising paths) and pursue one.
  2. Try a different *category* of approach (static↔dynamic, brute↔clever,
     high↔low level).
  3. Re-derive assumptions from the actual files; one wrong assumption blocks
     everything.
  4. Look for easier wins (weak encodings, hardcoded secrets, metadata,
     debug leftovers, unintended paths).
  5. Write a concrete step-by-step attack plan, execute one step at a time.
  6. Reduce the problem: minimal reproducer of the suspected mechanism, then
     scale back up.
- repeats the STATUS/SOLUTION.md requirements.

### 4.3 Workspace rules (`buildWorkspaceAgentsMd`) — written as `AGENTS.md`

pi auto-loads `AGENTS.md` from the cwd, so these rules apply to *every* turn:
the persistent-workspace contract, tools guidance, REPO-README.md semantics,
WRITEUP.md requirements, completion rules ("never give up early; 'no progress
yet' is not a stopping reason"), and a pointer to `task.txt`.

## 5. Session-log digests (`src/agents/session-log.ts`)

Read-only parsing of pi's own session JSONL — the authoritative record of
everything the agent said (pi has no internal todo/goal state; **the
transcript IS the state**).

Session files live at
`~/.pi/agent/sessions/<sanitized-cwd>/<timestamp>_<sessionId>.jsonl` with one
JSON entry per line (`session`, `session_info`, `model_change`,
`thinking_level_change`, `message`). Because the session id is deterministic,
`digestForSession(sessionId, workspace)` can always locate the job's session
(by id, under the workspace's sanitized cwd) and parse it.

An **attempt** = the span from one dispatcher prompt (initial or continuation,
recognized by their literal prefixes) to the next. Per attempt the digest
extracts: the final assistant text as the running **conclusion** (earlier
assistant texts go to `otherAssistantText`), tool names invoked, and last
activity timestamp. Torn tail writes (killed mid-line) are tolerated.

This is what `applyOutcome` persists into `progress` and what Discord panels
show as the live "what the agent is doing" state — see
[[Job-Lifecycle]] §5 and [[Discord-Integration]].

## 6. pi-utils (`src/agents/pi-utils.ts`)

Process-group helpers used by backends and `run.sh`-style teardown:
`findProcesses(matcher)` scans `/proc` (or `pgrep`) for matching command
lines; `killProcessGroup(pid)` TERM-then-KILLs the whole group. Used for
orphaned-session protection and clean shutdown.
