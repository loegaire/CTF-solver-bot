/**
 * Agent backend abstraction.
 *
 * The dispatcher is decoupled from *how* the agent is launched: it only needs a
 * handle with an observable result (exit code + captured output) and a kill
 * switch. PiBackend is the production implementation; EchoBackend simulates
 * outcomes for tests.
 */

export interface AgentJobSpec {
    /** Dispatcher job id. */
    jobId: number;
    /** Challenge name (for display). */
    challengeName: string;
    /** Absolute workspace directory; also the agent cwd. */
    workspace: string;
    /** Backend-defined persistent conversation/session id. */
    sessionId: string;
    /** Human-readable run/session name. */
    name: string;
    /** Full prompt for this run (initial or continuation). */
    prompt: string;
    /** Number of attempts already consumed before this run (0 for the first). */
    attempts: number;
}

export interface AgentRunResult {
    /** Process exit code, or null when killed by signal / failed to spawn. */
    exitCode: number | null;
    /** Terminating signal name, if any. */
    signal: string | null;
    /** True when the dispatcher killed the run (timeout). */
    killed: boolean;
    /** Why the dispatcher killed it: 'run-timeout' | 'idle-timeout' | 'dispatcher-shutdown' | null. */
    killReason: string | null;
    /** Spawn failure description (e.g. executable missing), if the process never started. */
    spawnError: string | null;
    /** Final assistant message text (agent's closing report). */
    lastAssistantText: string;
    /** Compact human-readable tail of the run transcript. */
    transcriptTail: string;
    /** Tail of raw stdout (JSON events for pi) — used for fatal-pattern scanning. */
    rawTail: string;
    /** Tail of agent stderr (agent's own diagnostics, not tool output). */
    stderrTail: string;
    /** Provider/transport error from the agent's final message (pi stopReason=error). Null when the run ended cleanly. */
    providerError: string | null;
    durationMs: number;
}

export interface AgentRunHandle {
    readonly pid: number | null;
    readonly result: Promise<AgentRunResult>;
    /** Politely then forcefully terminate the whole process group. */
    kill(reason: string): Promise<void>;
}

export interface AgentBackend {
    readonly name: string;
    /** Start a fresh run for a job. */
    submit(spec: AgentJobSpec): AgentRunHandle;
    /** Resume/relaunch the job with the spec's (continuation) prompt, preserving prior context. */
    resume(spec: AgentJobSpec): AgentRunHandle;
}

/** Bounded tail buffer: keeps the last `maxChars` characters pushed into it. */
export class Tail {
    private buf = '';
    constructor(private maxChars: number) {}

    push(s: string): void {
        this.buf += s;
        if (this.buf.length > this.maxChars) {
            this.buf = this.buf.slice(this.buf.length - this.maxChars);
        }
    }

    toString(): string {
        return this.buf;
    }
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)) + '…';
}
