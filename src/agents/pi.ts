/**
 * PiBackend: runs the Pi coding agent headlessly as a detached process group.
 *
 * - One deterministic pi session per job (`--session-id <sessionId>`), so continuations
 *   naturally resume the same conversation transcript.
 * - `--mode json` event stream on stdout is parsed to extract the final assistant
 *   message and a compact transcript tail; raw stdout is also kept for fatal
 *   pattern classification.
 * - Idle timeout = no agent events (stream updates) for N minutes; run timeout =
 *   wall-clock cap on a single run.
 * - cwd = the job workspace; pi inherits its global config (models, auth) from
 *   ~/.pi, so the dispatcher never touches credentials.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import type {
    AgentBackend,
    AgentJobSpec,
    AgentRunHandle,
    AgentRunResult,
} from './backend.js';
import { Tail, sleep, truncate } from './backend.js';
import { log } from '../log.js';
import { findProcesses, killProcessGroup } from './pi-utils.js';


export interface PiBackendOptions {
    /** pi executable (absolute path, or a name resolved via PATH). */
    piBin: string;
    /** Extra CLI args appended to every pi invocation. */
    extraArgs: string[];
    /** Wall-clock cap for one run, minutes. */
    runTimeoutMin: number;
    /** No-stream-activity cap for one run, minutes. */
    idleTimeoutMin: number;
    /** Grace between SIGTERM and SIGKILL, seconds. */
    killGraceSec: number;
}

const RAW_TAIL_CHARS = 64_000;
const TRANSCRIPT_TAIL_CHARS = 8_000;
const ASSISTANT_TAIL_CHARS = 12_000;
const STDERR_TAIL_CHARS = 8_000;

interface PiContentBlock {
    type: string;
    text?: string;
    thinking?: string;
}

interface PiMessage {
    role: string;
    content?: PiContentBlock[];
    /** Set by pi when the provider failed: transport error text. */
    stopReason?: string;
    errorMessage?: string;
}

interface PiEvent {
    type: string;
    message?: PiMessage;
    toolName?: string;
}

function extractText(m: PiMessage | undefined): string {
    if (!m?.content) return '';
    const parts: string[] = [];
    for (const c of m.content) {
        if (c.type === 'text' && c.text) parts.push(c.text);
    }
    return parts.join('\n');
}

export class PiBackend implements AgentBackend {
    readonly name = 'pi';
    private opts: PiBackendOptions;

    constructor(opts: PiBackendOptions) {
        this.opts = opts;
    }

    /** Build the argv for a run. Protected so tests can subclass. */
    protected buildArgs(spec: AgentJobSpec): string[] {
        const args = [
            '--mode', 'json',
            '--session-id', spec.sessionId,
            '--name', spec.name,
            '--no-approve',
            '--no-extensions',
            '--no-prompt-templates',
            ...this.opts.extraArgs,
            '--', spec.prompt,
        ];
        return args;
    }

    submit(spec: AgentJobSpec): AgentRunHandle {
        return this.run(spec);
    }

    resume(spec: AgentJobSpec): AgentRunHandle {
        return this.run(spec);
    }

    private run(spec: AgentJobSpec): AgentRunHandle {
        if (!fs.existsSync(spec.workspace)) {
            return PiBackend.deadHandle(`workspace missing: ${spec.workspace}`);
        }

        // Kill any orphaned pi run for this session (e.g. left behind by a
        // crashed/killed dispatcher): two writers on one session file would
        // corrupt the transcript.
        const orphans = findProcesses((cmdline) => cmdline.includes(spec.sessionId));
        if (orphans.length > 0) {
            log.warn('pi', `job ${spec.jobId}: killing ${orphans.length} orphaned pi process(es) for session ${spec.sessionId}`);
            for (const pid of orphans) {
                void killProcessGroup(pid, this.opts.killGraceSec);
            }
        }

        const rawTail = new Tail(RAW_TAIL_CHARS);
        const stderrTail = new Tail(STDERR_TAIL_CHARS);
        let lastAssistantText = '';
        let transcript = '';
        /** Provider transport error from the final assistant message, if any. */
        let providerError: string | null = null;

        const started = Date.now();
        let lastActivity = started;
        let exitCode: number | null = null;
        let signal: string | null = null;
        let killed = false;
        let killReason: string | null = null;
        let spawnError: string | null = null;

        let child: ChildProcess;
        try {
            child = spawn(this.opts.piBin, this.buildArgs(spec), {
                cwd: spec.workspace,
                env: { ...process.env },
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: true, // own process group so we can kill pi + its tool children
            });
        } catch (e) {
            return PiBackend.deadHandle(`failed to spawn ${this.opts.piBin}: ${(e as Error).message}`);
        }

        const killGroup = (sig: NodeJS.Signals): void => {
            if (!child.pid) return;
            try {
                process.kill(-child.pid, sig); // negative pid = whole process group
            } catch {
                /* group already gone; fall back to direct kill */
                try {
                    child.kill(sig);
                } catch {
                    /* fully gone */
                }
            }
        };

        const result = new Promise<AgentRunResult>((resolve) => {
            let stdoutEnded = false;
            let stderrEnded = false;
            let exitDone = false;

            const idleTimer = setInterval(() => {
                const idleMs = Date.now() - lastActivity;
                const limitMs = this.opts.idleTimeoutMin * 60_000;
                if (idleMs >= limitMs) {
                    killRun('idle-timeout');
                }
            }, 5_000);
            const runTimer = setTimeout(() => killRun('run-timeout'), this.opts.runTimeoutMin * 60_000);

            const killRun = (reason: string): void => {
                if (killed) return;
                killed = true;
                killReason = reason;
                log.warn('pi', `job ${spec.jobId}: terminating run (reason=${reason})`);
                killGroup('SIGTERM');
                setTimeout(() => killGroup('SIGKILL'), this.opts.killGraceSec * 1000).unref();
            };

            const finish = (): void => {
                clearInterval(idleTimer);
                clearTimeout(runTimer);
                resolve({
                    exitCode,
                    signal,
                    killed,
                    killReason,
                    spawnError,
                    lastAssistantText: truncate(lastAssistantText, ASSISTANT_TAIL_CHARS),
                    transcriptTail: truncate(transcript, TRANSCRIPT_TAIL_CHARS),
                    rawTail: truncate(rawTail.toString(), RAW_TAIL_CHARS),
                    stderrTail: truncate(stderrTail.toString(), STDERR_TAIL_CHARS),
                    providerError,
                    durationMs: Date.now() - started,
                });
            };

            const maybeFinish = (): void => {
                if (stdoutEnded && stderrEnded && exitDone) finish();
            };

            child.on('error', (e) => {
                spawnError = `pi spawn error: ${e.message}`;
                stdoutEnded = true;
                stderrEnded = true;
                exitDone = true;
                maybeFinish();
            });

            child.on('exit', (code, sig) => {
                exitCode = code;
                signal = sig;
                exitDone = true;
                maybeFinish();
            });

            child.stdout!.on('data', (chunk: Buffer) => {
                lastActivity = Date.now();
                const s = chunk.toString('utf8');
                rawTail.push(s);
                for (const line of s.split('\n')) {
                    if (!line.trim()) continue;
                    let ev: PiEvent | null = null;
                    try {
                        ev = JSON.parse(line) as PiEvent;
                    } catch {
                        continue;
                    }
                    if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
                        const text = extractText(ev.message);
                        if (text) {
                            lastAssistantText = text;
                            transcript += `assistant: ${text}\n`;
                        }
                        if (ev.message.stopReason === 'error' && ev.message.errorMessage) {
                            providerError = ev.message.errorMessage;
                        }
                    } else if (ev.type === 'tool_execution_start') {
                        transcript += `tool: ${ev.toolName}\n`;
                    }
                }
            });
            child.stdout!.on('end', () => {
                stdoutEnded = true;
                maybeFinish();
            });
            child.stdout!.on('error', () => {
                stdoutEnded = true;
                maybeFinish();
            });

            child.stderr!.on('data', (chunk: Buffer) => {
                lastActivity = Date.now();
                stderrTail.push(chunk.toString('utf8'));
            });
            child.stderr!.on('end', () => {
                stderrEnded = true;
                maybeFinish();
            });
            child.stderr!.on('error', () => {
                stderrEnded = true;
                maybeFinish();
            });
        });

        return {
            pid: child.pid ?? null,
            result,
            kill: async (reason: string) => {
                if (killed) return;
                killed = true;
                killReason = reason;
                log.warn('pi', `job ${spec.jobId}: kill requested (reason=${reason})`);
                killGroup('SIGTERM');
                setTimeout(() => killGroup('SIGKILL'), this.opts.killGraceSec * 1000).unref();
                // result promise resolves when the process exits; no need to await here
            },
        };
    }

    /** A handle for a run that never started (bad workspace, spawn failure). */
    private static deadHandle(err: string): AgentRunHandle {
        return {
            pid: null,
            result: Promise.resolve({
                exitCode: null,
                signal: null,
                killed: false,
                killReason: null,
                spawnError: err,
                lastAssistantText: '',
                transcriptTail: '',
                rawTail: '',
                stderrTail: '',
                providerError: null,
                durationMs: 0,
            }),
            kill: async () => {},
        };
    }
}
