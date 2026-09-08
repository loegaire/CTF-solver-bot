/**
 * RPC-mode pi backend.
 *
 * Runs `pi --mode rpc` as a long-lived child per job (instead of one-shot
 * `--mode json` runs). This unlocks the interactive control panel:
 *   - steer(): inject "someone replied ..." messages into the RUNNING agent
 *   - abort(): stop the current turn (used by the ✅ done reaction)
 *   - keep one session alive across continuations (same --session-id)
 *
 * Framing per pi's RPC spec: strict JSONL, LF only (readline is NOT compliant —
 * it splits on U+2028/U+2029). Commands in, responses+events out.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type {
    AgentBackend,
    AgentJobSpec,
    AgentRunHandle,
    AgentRunResult,
} from "./backend.js";
import { sleep, truncate } from "./backend.js";
import { findProcesses, killProcessGroup } from "./pi-utils.js";
import { log } from "../log.js";

const RAW_TAIL_CHARS = 64_000;
const TRANSCRIPT_TAIL_CHARS = 8_000;
const ASSISTANT_TAIL_CHARS = 12_000;
const STDERR_TAIL_CHARS = 8_000;

interface PiContentBlock {
    type: string;
    text?: string;
}

interface PiMessage {
    role: string;
    content?: PiContentBlock[];
    stopReason?: string;
    errorMessage?: string;
}

interface RpcEvent {
    type: string;
    message?: PiMessage;
    toolName?: string;
    [k: string]: unknown;
}

function textOf(m: PiMessage | undefined): string {
    if (!m?.content) return "";
    return m.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n");
}

/** Strict JSONL reader (LF only — protocol compliant). */
function attachJsonlReader(
    stream: NodeJS.ReadableStream,
    onLine: (line: string) => void,
): void {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    stream.on("data", (chunk: Buffer | string) => {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
        for (;;) {
            const nl = buffer.indexOf("\n");
            if (nl === -1) break;
            let line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (line) onLine(line);
        }
    });
    stream.on("end", () => {
        buffer += decoder.end();
        if (buffer) {
            let line = buffer;
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (line) onLine(line);
        }
    });
}

export interface RpcBackendOptions {
    piBin: string;
    extraArgs: string[];
    runTimeoutMin: number;
    idleTimeoutMin: number;
    killGraceSec: number;
}

export class RpcBackend implements AgentBackend {
    readonly name = "pi-rpc";
    private opts: RpcBackendOptions;

    constructor(opts: RpcBackendOptions) {
        this.opts = opts;
    }

    /** Long-lived run: spawn pi in RPC mode; the job's runs happen by sending
     * prompt commands; the process lives until killed or exited. */
    submit(spec: AgentJobSpec): AgentRunHandle {
        return this.start(spec);
    }

    resume(spec: AgentJobSpec): AgentRunHandle {
        return this.start(spec);
    }

    private start(spec: AgentJobSpec): AgentRunHandle {
        if (!fs.existsSync(spec.workspace)) {
            return RpcBackend.deadHandle(
                `workspace missing: ${spec.workspace}`,
            );
        }

        // Kill orphaned pi runs for this session (double writers corrupt it).
        const orphans = findProcesses((cmdline) =>
            cmdline.includes(spec.sessionId),
        );
        if (orphans.length > 0) {
            log.warn(
                "pi",
                `job ${spec.jobId}: killing ${orphans.length} orphaned pi process(es) for session ${spec.sessionId}`,
            );
            for (const pid of orphans)
                void killProcessGroup(pid, this.opts.killGraceSec);
        }

        const rawTail: string[] = [""];
        const stderrTail: string[] = [""];
        let lastAssistantText = "";
        let transcript = "";

        let killed = false;
        let killReason: string | null = null;
        let providerError: string | null = null;

        let child: ChildProcess;
        try {
            child = spawn(
                this.opts.piBin,
                [
                    "--mode",
                    "rpc",
                    "--session-id",
                    spec.sessionId,
                    "--name",
                    spec.name,
                    "--no-approve",
                    "--no-extensions",
                    "--no-prompt-templates",
                    ...this.opts.extraArgs,
                ],
                {
                    cwd: spec.workspace,
                    env: { ...process.env },
                    stdio: ["pipe", "pipe", "pipe"],
                    detached: true,
                },
            );
        } catch (e) {
            return RpcBackend.deadHandle(
                `failed to spawn ${this.opts.piBin}: ${(e as Error).message}`,
            );
        }

        const push = (arr: string[], s: string, max: number): void => {
            arr[0] = arr[0] + s;
            if (arr[0].length > max) arr[0] = arr[0].slice(arr[0].length - max);
        };

        let settled = false;
        const started = Date.now();
        let lastActivity = Date.now();
        const pendingSteers = new Map<string, (ok: boolean) => void>();

        const send = (obj: Record<string, unknown>): void => {
            try {
                child.stdin!.write(JSON.stringify(obj) + "\n");
            } catch {
                /* stdin closed */
            }
        };

        attachJsonlReader(child.stdout!, (line) => {
            lastActivity = Date.now();
            push(rawTail, line + "\n", RAW_TAIL_CHARS);
            let ev: RpcEvent | null = null;
            try {
                ev = JSON.parse(line) as RpcEvent;
            } catch {
                return;
            }
            if (!ev) return;
            if (ev.type === "response" && ev.command === "steer") {
                const ok = ev.success === true;
                const cb = pendingSteers.get(String(ev.id ?? ""));
                if (cb) {
                    cb(ok);
                    pendingSteers.delete(String(ev.id ?? ""));
                }
                return;
            }
            if (ev.type === "message_end" && ev.message?.role === "assistant") {
                const text = textOf(ev.message);
                if (text) {
                    lastAssistantText = text;
                    transcript += `assistant: ${text}\n`;
                }
                if (
                    ev.message.stopReason === "error" &&
                    ev.message.errorMessage
                ) {
                    providerError = ev.message.errorMessage;
                }
            } else if (ev.type === "tool_execution_start") {
                transcript += `tool: ${ev.toolName}\n`;
            } else if (ev.type === "agent_settled") {
                settled = true;
            }
        });

        push(stderrTail, "", 0);
        child.stderr!.on("data", (c: Buffer) => {
            lastActivity = Date.now();
            push(stderrTail, c.toString("utf8"), STDERR_TAIL_CHARS);
        });

        const killGroup = (sig: NodeJS.Signals): void => {
            if (!child.pid) return;
            try {
                process.kill(-child.pid, sig);
            } catch {
                try {
                    child.kill(sig);
                } catch {
                    /* already gone */
                }
            }
        };

        const result = new Promise<AgentRunResult>((resolve) => {
            let stdoutEnded = false;
            let stderrEnded = false;
            let exitDone = false;

            const idleTimer = setInterval(() => {
                if (
                    Date.now() - lastActivity >=
                    this.opts.idleTimeoutMin * 60_000
                ) {
                    killRun("idle-timeout");
                }
            }, 5_000);
            const runTimer = setTimeout(
                () => killRun("run-timeout"),
                this.opts.runTimeoutMin * 60_000,
            );

            const killRun = (reason: string): void => {
                if (killed) return;
                killed = true;
                killReason = reason;
                log.warn(
                    "pi",
                    `job ${spec.jobId}: terminating run (reason=${reason})`,
                );
                killGroup("SIGTERM");
                setTimeout(
                    () => killGroup("SIGKILL"),
                    this.opts.killGraceSec * 1000,
                ).unref();
            };

            const finish = (): void => {
                clearInterval(idleTimer);
                clearTimeout(runTimer);
                resolve({
                    exitCode: exitCodeBox.code,
                    signal: exitCodeBox.signal,
                    killed,
                    killReason,
                    spawnError: spawnErrBox.err,
                    lastAssistantText: truncate(
                        lastAssistantText,
                        ASSISTANT_TAIL_CHARS,
                    ),
                    transcriptTail: truncate(transcript, TRANSCRIPT_TAIL_CHARS),
                    rawTail: truncate(rawTail[0], RAW_TAIL_CHARS),
                    stderrTail: truncate(stderrTail[0], STDERR_TAIL_CHARS),
                    providerError,
                    durationMs: Date.now() - started,
                });
            };

            const maybeFinish = (): void => {
                if (stdoutEnded && stderrEnded && exitDone) finish();
            };

            const exitCodeBox: { code: number | null; signal: string | null } =
                { code: null, signal: null };
            const spawnErrBox: { err: string | null } = { err: null };

            child.on("error", (e) => {
                spawnErrBox.err = `pi spawn error: ${e.message}`;
                stdoutEnded = stderrEnded = exitDone = true;
                maybeFinish();
            });
            child.on("exit", (code, sig) => {
                exitCodeBox.code = code;
                exitCodeBox.signal = sig;
                exitDone = true;
                maybeFinish();
            });
            child.stdout!.on("end", () => {
                stdoutEnded = true;
                maybeFinish();
            });
            child.stdout!.on("error", () => {
                stdoutEnded = true;
                maybeFinish();
            });
            child.stderr!.on("end", () => {
                stderrEnded = true;
                maybeFinish();
            });
            child.stderr!.on("error", () => {
                stderrEnded = true;
                maybeFinish();
            });

            // Fire the initial prompt once pi is up (RPC mode starts ready).
            send({ type: "prompt", message: spec.prompt });
        });

        return {
            pid: child.pid ?? null,
            result,
            kill: async (reason: string) => {
                if (killed) return;
                killed = true;
                killReason = reason;
                killGroup("SIGTERM");
                setTimeout(
                    () => killGroup("SIGKILL"),
                    this.opts.killGraceSec * 1000,
                ).unref();
            },
            // --- interactive extensions (RPC only) ---
            async steer(message: string): Promise<boolean> {
                if (killed) return false;
                return new Promise((resolve) => {
                    const id = `steer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                    pendingSteers.set(id, resolve);
                    send({ type: "steer", id, message });
                    setTimeout(() => {
                        if (pendingSteers.has(id)) {
                            pendingSteers.delete(id);
                            resolve(false);
                        }
                    }, 30_000).unref();
                });
            },
            async abort(): Promise<void> {
                if (killed) return;
                send({ type: "abort" });
            },
        } as AgentRunHandle & {
            steer?: (m: string) => Promise<boolean>;
            abort?: () => Promise<void>;
        };
    }

    private static deadHandle(err: string): AgentRunHandle {
        return {
            pid: null,
            result: Promise.resolve({
                exitCode: null,
                signal: null,
                killed: false,
                killReason: null,
                spawnError: err,
                lastAssistantText: "",
                transcriptTail: "",
                rawTail: "",
                stderrTail: "",
                providerError: null,
                durationMs: 0,
            }),
            kill: async () => {},
        };
    }
}
