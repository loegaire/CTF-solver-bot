/**
 * EchoBackend: deterministic fake agent for tests.
 *
 * It looks for a directive file in the workspace (`echo-directive.txt`,
 * one of "solved" | "unsolved" | "fatal") so tests can flip outcomes mid-run,
 * and honors the attempt count to allow scenario scripting.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
    AgentBackend,
    AgentJobSpec,
    AgentRunHandle,
    AgentRunResult,
} from './backend.js';

export interface EchoBackendOptions {
    /** Default scenario when no directive file exists. */
    defaultScript: 'solved' | 'unsolved' | 'fatal';
    /** Simulated run duration, ms. */
    durationMs?: number;
}

const PROMPTS = {
    solved: `I solved the challenge by decoding the embedded stream.

Flag: FLAG{echo_solved}

STATUS: SOLVED`,
    unsolved: `I could not solve it yet. My current approach failed; I need to try another approach.

STATUS: UNSOLVED`,
    fatal: `ERROR: API authentication failed: 401 Unauthorized (invalid API key).`,
};

export class EchoBackend implements AgentBackend {
    readonly name = 'echo';
    private opts: Required<EchoBackendOptions>;

    constructor(opts: EchoBackendOptions) {
        this.opts = { durationMs: 150, ...opts };
    }

    private readDirective(spec: AgentJobSpec): 'solved' | 'unsolved' | 'fatal' {
        const directiveFile = path.join(spec.workspace, 'echo-directive.txt');
        try {
            const v = fs.readFileSync(directiveFile, 'utf8').trim();
            if (v === 'solved' || v === 'unsolved' || v === 'fatal') return v;
        } catch {
            /* fall through */
        }
        return this.opts.defaultScript;
    }

    private run(spec: AgentJobSpec): AgentRunHandle {
        const script = this.readDirective(spec);
        const delay = this.opts.durationMs;

        let killed = false;
        let killReason: string | null = null;
        let resolveResult: ((r: AgentRunResult) => void) | null = null;

        const child = spawn(process.execPath, ['-e', `
            const delay = ${delay};
            setTimeout(() => process.stdout.write(${JSON.stringify(PROMPTS[script])}), delay);
        `], {
            cwd: spec.workspace,
            stdio: ['ignore', 'pipe', 'ignore'],
            detached: true,
        });

        let out = '';
        child.stdout!.on('data', (c: Buffer) => {
            out += c.toString('utf8');
        });

        const result = new Promise<AgentRunResult>((resolve) => {
            resolveResult = resolve;
            child.on('exit', (code) => {
                resolveResult?.({
                    exitCode: code,
                    signal: null,
                    killed,
                    killReason,
                    spawnError: null,
                    lastAssistantText: out,
                    transcriptTail: out,
                    rawTail: out,
                    stderrTail: '',
                    providerError: script === 'fatal' ? out : null,
                    durationMs: delay,
                });
            });
            child.on('error', () => {
                resolveResult?.({
                    exitCode: null,
                    signal: null,
                    killed,
                    killReason,
                    spawnError: 'echo spawn failed',
                    lastAssistantText: '',
                    transcriptTail: '',
                    rawTail: '',
                    stderrTail: '',
                    providerError: null,
                    durationMs: 0,
                });
            });
        });

        return {
            pid: child.pid ?? null,
            result,
            kill: async (reason: string) => {
                killed = true;
                killReason = reason;
                try {
                    child.kill('SIGKILL');
                } catch {
                    /* ignore */
                }
            },
        };
    }

    submit(spec: AgentJobSpec): AgentRunHandle {
        return this.run(spec);
    }

    resume(spec: AgentJobSpec): AgentRunHandle {
        return this.run(spec);
    }
}
