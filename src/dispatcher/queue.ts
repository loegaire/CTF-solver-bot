/**
 * Queue: concurrency-limited job runner.
 *
 * Fairness rule: at most one active run per challenge (a newer commit of the same
 * challenge path must not run concurrently with an older one — first discovered
 * wins, later ones wait until the active one settles).
 *
 * The queue processes:
 *   1. AGENT_STOPPED jobs → continuation runs (attempt budget via maxAttempts)
 *   2. NEW jobs → stage → handoff
 *   3. STAGED jobs → handoff
 *
 * All work is claimed straight from SQLite, so a dispatcher restart resumes
 * exactly where it left off.
 */

import * as db from "../database/db.js";
import type { AgentBackend, AgentRunHandle } from "../agents/backend.js";
import type { Lifecycle } from "./lifecycle.js";
import { log } from "../log.js";

export interface QueueOptions {
    maxConcurrent: number;
    /** Poll resolution while waiting for work / free slots. */
    tickMs?: number;
}

export class Queue {
    private opts: QueueOptions;
    private lifecycle: Lifecycle;
    private backend: AgentBackend;
    /** jobId -> challengeId for all in-flight runs (including staging). */
    private active = new Map<number, number>();
    /** Handles of in-flight agent runs, so shutdown can kill them. */
    private handles = new Map<number, AgentRunHandle>();
    private stopped = false;
    private wakers: Array<() => void> = [];

    constructor(
        backend: AgentBackend,
        lifecycle: Lifecycle,
        opts: QueueOptions,
    ) {
        this.backend = backend;
        this.lifecycle = lifecycle;
        this.opts = opts;
    }

    /** Kick the loop (after discovery, webhook, or external state change). */
    /**
     * User marked this job done (✅ reaction on its panel): stop any in-flight
     * run and prevent further attempts. The job ends in SKIPPED status.
     */
    markDone(jobId: number, reason = "done reaction"): void {
        const job = db.getJobById(jobId);
        if (!job) return;
        const terminal = ["SOLVED", "FATAL_ERROR", "BLOCKED", "SKIPPED"];
        if (terminal.includes(job.status)) return; // nothing to stop
        log.info("queue", `job #${jobId}: stopping (${reason})`);
        db.updateJob(jobId, {
            status: "SKIPPED",
            last_error: `stopped: ${reason}`,
            pid: null,
        });
        // challenge status is set by the caller when the challenge itself is
        // being closed (prune sets REMOVED; user-done sets SKIPPED)
        // kill an in-flight run, if any
        const handle = this.handles.get(jobId);
        if (handle) {
            void handle.kill("user-done").catch(() => {});
        }
        this.wake();
    }

    wake(): void {
        for (const w of this.wakers.splice(0)) w();
    }

    stop(): void {
        this.stopped = true;
        this.wake();
    }

    get runningCount(): number {
        return this.active.size;
    }

    private sleepInterruptible(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const t = setTimeout(() => {
                this.wakers = this.wakers.filter((w) => w !== wake);
                resolve();
            }, ms);
            const wake = () => {
                clearTimeout(t);
                resolve();
            };
            this.wakers.push(wake);
        });
    }

    /** Next job eligible to run, or null. FIFO by job id (discovery order) so
     * hot continuation loops cannot starve newly discovered challenges. */
    private pickNext(): db.JobRow | null {
        const eligible = (j: db.JobRow): boolean =>
            !this.active.has(j.id) && !this.activeByChallenge(j.challenge_id);

        // Rotation ordering: never-turned (NEW) challenges first — clears the
        // low-hanging fruit across the whole field before resuming hard ones;
        // among rotated ones, the least-recently-rotated goes next, so after a
        // full round the initial challenge resumes.
        return db.getRotationOrderedPending().find(eligible) ?? null;
    }

    private activeByChallenge(challengeId: number): boolean {
        for (const cid of this.active.values())
            if (cid === challengeId) return true;
        return false;
    }

    /** Main loop: claim jobs up to maxConcurrent, run them, repeat until stopped. */
    async run(): Promise<void> {
        this.stopped = false;
        while (!this.stopped) {
            let started = 0;
            while (
                !this.stopped &&
                this.active.size < this.opts.maxConcurrent
            ) {
                const job = this.pickNext();
                if (!job) break;
                this.startJob(job.id); // fire-and-forget; startJob manages its slot
                started++;
            }
            if (started === 0) {
                await this.sleepInterruptible(this.opts.tickMs ?? 2000);
            }
        }
        // Graceful stop: kill in-flight runs (they will be recovered as
        // continuations on next start), then wait for the slots to clear.
        // The loop keeps killing because a run may spawn between passes.
        while (this.active.size > 0) {
            for (const [, handle] of this.handles) {
                try {
                    await handle.kill("dispatcher-shutdown");
                } catch {
                    /* best effort */
                }
            }
            await this.sleepInterruptible(200);
        }
    }

    /** Run every currently-pending job (including forced continuations spawned
     * by those runs) to a terminal state, then return. For --once mode. */
    async runOnce(): Promise<void> {
        this.stopped = false;
        for (;;) {
            while (this.active.size < this.opts.maxConcurrent) {
                const job = this.pickNext();
                if (!job) break;
                this.startJob(job.id);
            }
            if (this.active.size === 0) {
                const more = this.pickNext();
                if (!more) break; // nothing pending and nothing running: done
                this.startJob(more.id);
            }
            await this.sleepInterruptible(300);
        }
    }

    private startJob(jobId: number): void {
        const job = db.getJobById(jobId);
        if (!job) return;
        this.active.set(jobId, job.challenge_id);

        void (async () => {
            try {
                if (job.status === "NEW") {
                    await this.lifecycle.stage(jobId);
                }
                if (this.stopped) {
                    // Shutdown during staging: leave as STAGED for the next start.
                    log.info(
                        "queue",
                        `job #${jobId}: shutdown during start; leaving STAGED`,
                    );
                    return;
                }
                db.updateJob(jobId, {
                    last_rotated_at: new Date().toISOString(),
                });
                await this.lifecycle.runJob(this.backend, jobId, (handle) => {
                    this.handles.set(jobId, handle);
                });
            } catch (e) {
                log.error(
                    "queue",
                    `job #${jobId} failed in dispatcher: ${(e as Error).stack}`,
                );
                db.updateJob(jobId, {
                    status: "FATAL_ERROR",
                    last_error: `dispatcher bug: ${(e as Error).message}`,
                });
                db.setChallengeStatus(job.challenge_id, "FATAL_ERROR");
            } finally {
                this.active.delete(jobId);
                this.handles.delete(jobId);
                this.wake();
            }
        })();
    }
}
