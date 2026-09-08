/**
 * Pi process utilities: orphan detection and process-group cleanup.
 */

import * as fs from 'node:fs';
import { sleep } from './backend.js';

/** True when `pid` is a live process whose command line references our session id. */
export function isPiProcess(pid: number, sessionId: string): boolean {
    try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        return cmdline.includes(sessionId);
    } catch {
        return false; // /proc unavailable (non-Linux) or process gone
    }
}

/** Kill a whole process group: SIGTERM, wait up to graceSec, then SIGKILL. */
export async function killProcessGroup(pid: number, graceSec: number): Promise<void> {
    const sig = (s: NodeJS.Signals): void => {
        try {
            process.kill(-pid, s); // negative pid = whole group (pi runs as group leader)
        } catch {
            try {
                process.kill(pid, s); // not a group leader; kill directly
            } catch {
                /* already gone */
            }
        }
    };
    sig('SIGTERM');
    const deadline = Date.now() + graceSec * 1000;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0); // liveness probe
        } catch {
            return; // exited
        }
        await sleep(200);
    }
    sig('SIGKILL');
}

/**
 * Best-effort discovery of a live process matching a predicate over its cmdline.
 * Linux-only (reads /proc); returns [] elsewhere.
 */
export function findProcesses(match: (cmdline: string) => boolean): number[] {
    const out: number[] = [];
    let entries: string[];
    try {
        entries = fs.readdirSync('/proc');
    } catch {
        return out;
    }
    for (const e of entries) {
        if (!/^\d+$/.test(e)) continue;
        let cmdline = '';
        try {
            cmdline = fs.readFileSync(`/proc/${e}/cmdline`, 'utf8');
        } catch {
            continue;
        }
        if (match(cmdline)) out.push(Number(e));
    }
    return out;
}
