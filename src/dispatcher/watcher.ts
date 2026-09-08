/**
 * Watcher: challenge discovery loop.
 *
 * - Polls the source on an interval (the authoritative path).
 * - Webhooks merely pull the poll forward ("trigger now"), never add state.
 * - Deduplicates challenges by (path, source, commitSha).
 */

import type { ChallengeSource } from "../sources/source.js";
import {
    groupChallenges,
    parseSolvedFile,
    PREFIX_AUTO,
} from "../sources/source.js";
import type { ChallengeRef } from "../types.js";
import { log } from "../log.js";
import { sleep } from "../agents/backend.js";

export interface WatcherOptions {
    pollIntervalSec: number;
    /** Challenge root path inside the source: "auto" (default) discovers
     *  challenges both at the root and under challenges/; "" forces root-only;
     *  a path pins discovery inside that directory. */
    prefix: string;
    /** Top-level dir names to never treat as challenges (root mode), e.g. writeups. */
    exclude: string[];
    /** Test hook: overrides sleep implementation. */
    sleepFn?: (ms: number) => Promise<void>;
}

export class Watcher {
    private src: ChallengeSource;
    private opts: WatcherOptions;
    private running = false;
    private pollNow = false;

    constructor(src: ChallengeSource, opts: WatcherOptions) {
        this.src = src;
        this.opts = opts;
    }

    /** Webhook callback: request an immediate poll (debounced to one per tick). */
    trigger(): void {
        this.pollNow = true;
    }

    stop(): void {
        this.running = false;
    }

    /** Poll once: fetch current revision + file list, group into challenges,
     * and load the repo's SOLVED.txt (if present) for skip-marking. */
    async pollOnce(): Promise<{
        revision: string;
        challenges: ChallengeRef[];
        solvedLines: string[];
    }> {
        const revision = await this.src.currentRevision();
        const files = await this.src.listFiles();
        // Whole-repo discovery (auto = ""). A pinned prefix scopes the root.
        const root = this.opts.prefix === PREFIX_AUTO ? "" : this.opts.prefix;
        const challenges = groupChallenges(
            root,
            files,
            revision,
            this.opts.exclude,
        );
        // SOLVED.txt may live at the repo root or inside the challenge root.
        const solvedLines: string[] = [];
        for (const p of ["SOLVED.txt", root ? `${root}/SOLVED.txt` : ""]) {
            if (!p) continue;
            const hit = files.find((f) => f.path === p);
            if (!hit) continue;
            try {
                const content = (
                    await this.src.downloadFile(hit.path)
                ).toString("utf8");
                solvedLines.push(...parseSolvedFile(content));
            } catch {
                /* unreadable solved list: skip */
            }
        }
        log.info(
            "watcher",
            `poll: revision=${revision.slice(0, 12)} challenges=${challenges.length}` +
                (solvedLines.length
                    ? ` solved-listed=${solvedLines.length}`
                    : ""),
        );
        return { revision, challenges, solvedLines };
    }

    /**
     * Run the watch loop forever (or until stop()). Each discovered batch is
     * handed to onDiscover together with the SOLVED.txt lines (may be empty).
     * Errors are logged and retried on the next tick.
     */
    async run(
        onDiscover: (
            batch: ChallengeRef[],
            solvedLines: string[],
        ) => Promise<void>,
    ): Promise<void> {
        this.running = true;
        while (this.running) {
            const immediate = this.pollNow;
            this.pollNow = false;
            try {
                const { challenges, solvedLines } = await this.pollOnce();
                await onDiscover(challenges, solvedLines);
            } catch (e) {
                log.warn("watcher", `poll failed: ${(e as Error).message}`);
            }
            if (!this.running) break;
            if (!immediate) {
                await (this.opts.sleepFn ?? sleep)(
                    this.opts.pollIntervalSec * 1000,
                );
            }
        }
    }
}
