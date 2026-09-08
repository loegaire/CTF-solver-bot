/**
 * Lifecycle: the job state machine (DISCOVER → STAGE → HANDOFF → OBSERVE →
 * SOLVED | FATAL | CONTINUE → ...). One run per job at a time; the Queue drives
 * concurrency. All transitions are persisted synchronously in SQLite.
 *
 * The central rule: "not solved is not failure" — an agent that merely stops
 * without a fatal condition is forced to continue with a nudge prompt, reusing
 * the same pi session (transcript) and workspace.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type {
    AgentBackend,
    AgentRunHandle,
    AgentJobSpec,
} from "../agents/backend.js";
import {
    buildInitialPrompt,
    buildContinuationPrompt,
    buildWorkspaceAgentsMd,
} from "../agents/prompts.js";
import { classify, type Outcome } from "../errors/classifier.js";
import * as db from "../database/db.js";
import type { ChallengeRef } from "../types.js";
import type { ChallengeSource } from "../sources/source.js";
import { isMarkedSolved } from "../sources/source.js";
import { stageChallenge, workspaceFor } from "./stager.js";
import { digestForSession } from "../agents/session-log.js";
import { log } from "../log.js";

/** Sync the repo's top-level README into every active workspace as
 * REPO-README.md — the central credentials/instances list. Called on discovery
 * polls so GitHub README updates reach running/queued jobs' workspaces. */
export async function syncRepoReadme(
    src: ChallengeSource,
    jobsDir: string,
): Promise<void> {
    let readme: string | null = null;
    try {
        // listFiles is cached per revision; find the top-level README
        // (repo root, or inside the pinned prefix root).
        // Cheap: one download, reused for every workspace.
        const files = await src.listFiles();
        const hit = files.find(
            (f) =>
                f.path === "README.md" ||
                f.path === "readme.md" ||
                f.path === "Readme.md",
        );
        if (!hit) return;
        readme = (await src.downloadFile(hit.path)).toString("utf8");
    } catch {
        return; // source unreachable: keep the existing copies
    }
    if (!readme) return;
    if (!fs.existsSync(jobsDir)) return;
    for (const entry of fs.readdirSync(jobsDir)) {
        const ws = path.join(jobsDir, entry);
        try {
            if (!fs.statSync(ws).isDirectory()) continue;
            const dest = path.join(ws, "REPO-README.md");
            let changed = true;
            try {
                changed = fs.readFileSync(dest, "utf8") !== readme;
            } catch {
                /* absent */
            }
            if (changed) {
                fs.writeFileSync(dest, readme);
                log.info("lifecycle", `synced REPO-README.md -> ${entry}`);
            }
        } catch {
            /* unreadable workspace: skip */
        }
    }
}

/** Read WRITEUP.md from a workspace, null when absent/empty. */
function readWriteup(workspace: string): string | null {
    try {
        const text = fs
            .readFileSync(path.join(workspace, "WRITEUP.md"), "utf8")
            .trim();
        return text || null;
    } catch {
        return null;
    }
}

export interface LifecycleOptions {
    maxAttempts: number;
    /** Turn duration for the rotation system (minutes). A run killed for
     * run-timeout is a TURN EXPIRY: WRITEUP captured, job rotated to the back
     * of the queue, next pending challenge starts. */
    turnMinutes: number;
    /** Event callback for reporting layers (Discord, status). Optional. */
    onEvent?: (event: LifecycleEvent) => void;
}

export type LifecycleEvent =
    | { type: "staged"; jobId: number; challenge: string; workspace: string }
    | {
          type: "started";
          jobId: number;
          challenge: string;
          attempt: number;
          resume: boolean;
      }
    | {
          type: "solved";
          jobId: number;
          challenge: string;
          flag: string | null;
          summary: string;
      }
    | {
          type: "fatal";
          jobId: number;
          challenge: string;
          reason: string;
          summary: string;
      }
    | { type: "blocked"; jobId: number; challenge: string; reason: string }
    | {
          type: "continue";
          jobId: number;
          challenge: string;
          attempt: number;
          reason: string;
      };

function nameOf(challengePath: string): string {
    return challengePath.split("/").filter(Boolean).pop() ?? challengePath;
}

/** Test/demo challenge detector: names that look like scratch or test data
 * (test, demo, example, sample, scratch, tmp, rot13git-style probe names).
 * These are never tracked in the database. */
export function isTestChallenge(ref: { name: string; path: string }): boolean {
    const base = (ref.path.split("/").pop() ?? ref.name).toLowerCase();
    return /^(test|demo|example|sample|scratch|tmp|testcase)[-_a-z0-9]*$/.test(
        base,
    );
}

/** Content identity of a challenge: sorted "name:mode:sha" lines hashed.
 * Two challenges with identical file lists are the same job even when the
 * rest of the repository moved on. */
export function challengeFingerprint(ref: ChallengeRef): string {
    const h = crypto.createHash("sha256");
    for (const f of [...ref.files].sort((a, b) =>
        a.name.localeCompare(b.name),
    )) {
        h.update(`${f.name}:${f.mode}:${f.sha ?? f.size}\n`);
    }
    return `sha256:${h.digest("hex").slice(0, 24)}`;
}

export class Lifecycle {
    private opts: LifecycleOptions;
    private src: ChallengeSource;
    private jobsDir: string;

    constructor(src: ChallengeSource, jobsDir: string, opts: LifecycleOptions) {
        this.opts = opts;
        this.src = src;
        this.jobsDir = jobsDir;
    }

    /** Register newly discovered challenges; returns created job ids.
     *
     * Identity = (path, source) + content fingerprint of the challenge's files
     * (sorted path:sha list). Two commits with identical challenge content are the
     * same job; any real change (even only in one challenge) creates a new job
     * only for that challenge.
     */
    /**
     * Repo-sync prune: challenges tracked in the DB but no longer present in
     * the source listing are marked REMOVED; their non-terminal jobs are
     * closed out so the queue stops working on them and their panels show a
     * final "removed from repo" state. Called after every discovery poll.
     *
     * `stopJob` is provided by the queue: it kills an in-flight run for a
     * RUNNING job. Returns the number of challenges pruned.
     */
    pruneMissing(
        batch: ChallengeRef[],
        stopJob?: (jobId: number, reason: string) => void,
    ): number {
        const inRepo = new Set(batch.map((r) => r.path));
        const tracked = db.getTrackedChallengePaths(this.src.id);
        const removed: string[] = [];
        for (const p of tracked) {
            if (inRepo.has(p)) continue;
            removed.push(p);
        }
        if (removed.length === 0) return 0;
        let stopped = 0;
        for (const p of removed) {
            const rows = db.getChallengesBySourcePath(this.src.id, p);
            for (const ch of rows) {
                const job = db.getJobByChallenge(ch.id);
                if (job && job.status === "RUNNING") {
                    stopJob?.(job.id, "removed from repo");
                    stopped++;
                }
                // Source-of-truth purge: the git repo is the source of truth.
                // What is no longer in the repo is deleted from the DB
                // entirely (jobs, progress, messages, challenge row). Any
                // in-flight run's applyOutcome finds its job row gone and
                // no-ops.
                db.purgeChallenge(ch.id);
            }
            log.info(
                "lifecycle",
                `purged ${p} — removed from repo (DB rows deleted)`,
            );
        }
        if (stopped > 0) {
            log.info("lifecycle", `purge killed ${stopped} in-flight run(s)`);
        }
        return removed.length;
    }

    async discover(
        batch: ChallengeRef[],
        solvedLines: string[] = [],
    ): Promise<number[]> {
        const created: number[] = [];
        for (const ref of batch) {
            // Test/demo challenges are never tracked: no DB rows, no panels.
            if (isTestChallenge(ref)) {
                log.info(
                    "lifecycle",
                    `ignoring ${ref.path} (test/demo challenge — not tracked)`,
                );
                continue;
            }
            const fingerprint = challengeFingerprint(ref);
            if (db.challengeExists(ref.path, this.src.id, fingerprint))
                continue;
            const markedSolved = isMarkedSolved(ref, solvedLines);
            const ch = db.insertChallenge({
                path: ref.path,
                source: this.src.id,
                commitSha: fingerprint,
                filesJson: JSON.stringify(ref.files),
                status: markedSolved ? "SKIPPED" : "NEW",
            });
            if (!ch) continue;
            const job = db.insertJob({
                challengeId: ch.id,
                workspace: workspaceFor(this.jobsDir, {
                    ...ref,
                    commitSha: fingerprint,
                }),
                piSessionId: `ctf-${challengeFingerprint(ref).slice(7, 19)}`,
                status: markedSolved ? "SKIPPED" : "NEW",
            });
            if (markedSolved) {
                log.info(
                    "lifecycle",
                    `discovered ${ref.path} -> SKIPPED (marked solved in SOLVED.txt)`,
                );
                continue;
            }
            created.push(job.id);
            log.info(
                "lifecycle",
                `discovered ${ref.path}@${fingerprint.slice(0, 12)} -> job #${job.id}`,
            );
        }
        return created;
    }

    /** Stage a NEW job: download files, write task.txt + AGENTS.md. */
    async stage(jobId: number): Promise<void> {
        const job = db.getJobById(jobId);
        if (!job || job.status !== "NEW") return;
        const ch = db.getChallengeById(job.challenge_id);
        if (!ch) return;

        const files = (() => {
            try {
                return JSON.parse(
                    ch.files_json || "[]",
                ) as ChallengeRef["files"];
            } catch {
                return [] as ChallengeRef["files"];
            }
        })();
        const ref: ChallengeRef = {
            name: nameOf(ch.path),
            path: ch.path,
            commitSha: ch.commit_sha,
            files,
        };
        const staged = await stageChallenge(this.src, ref, this.jobsDir);

        fs.writeFileSync(
            path.join(staged.workspace, "task.txt"),
            buildInitialPrompt(nameOf(ch.path)),
        );
        fs.writeFileSync(
            path.join(staged.workspace, "AGENTS.md"),
            buildWorkspaceAgentsMd(),
        );

        db.updateJob(jobId, { status: "STAGED", workspace: staged.workspace });
        db.setChallengeStatus(ch.id, "STAGED");
        this.opts.onEvent?.({
            type: "staged",
            jobId,
            challenge: ch.path,
            workspace: staged.workspace,
        });
    }

    /** Start (or resume) an agent run for a job; resolves when the run completes. */
    async runJob(
        backend: AgentBackend,
        jobId: number,
        onSpawn?: (handle: AgentRunHandle) => void,
    ): Promise<void> {
        let job = db.getJobById(jobId);
        if (!job) return;
        const ch = db.getChallengeById(job.challenge_id);
        if (!ch) return;

        const isResume = job.attempts > 0;
        const prompt = isResume
            ? buildContinuationPrompt(job.attempts + 1)
            : buildInitialPrompt(nameOf(ch.path));

        const spec: AgentJobSpec = {
            jobId,
            challengeName: nameOf(ch.path),
            workspace: job.workspace,
            sessionId: job.pi_session_id,
            name: `ctf-${nameOf(ch.path)}-${job.id}`,
            prompt,
            attempts: job.attempts,
        };

        const handle = isResume ? backend.resume(spec) : backend.submit(spec);
        onSpawn?.(handle);

        db.updateJob(jobId, {
            status: "RUNNING",
            started_at: new Date().toISOString(),
            pid: handle.pid,
        });
        db.setChallengeStatus(ch.id, "RUNNING");
        this.opts.onEvent?.({
            type: "started",
            jobId,
            challenge: ch.path,
            attempt: job.attempts + 1,
            resume: isResume,
        });

        const result = await handle.result;

        job = db.getJobById(jobId);
        if (!job) return; // job row deleted mid-run; nothing to persist

        db.updateJob(jobId, {
            last_output: result.transcriptTail || result.rawTail.slice(-2000),
            pid: null,
        });

        const outcome = classify(
            result,
            job.attempts + 1,
            this.opts.maxAttempts,
            job.workspace,
        );
        await this.applyOutcome(jobId, outcome, {
            killReason: result.killReason,
        });
    }

    /** Apply a classified outcome to the job (state transition + events + persistence). */
    async applyOutcome(
        jobId: number,
        outcome: Outcome,
        runResult?: { killReason: string | null },
    ): Promise<void> {
        const job = db.getJobById(jobId);
        if (!job) return;
        const ch = db.getChallengeById(job.challenge_id);
        if (!ch) return;
        // User marked this job done while it was running: keep SKIPPED; the
        // killed run's outcome must not resurrect the job as AGENT_STOPPED.
        if (job.status === "SKIPPED") {
            log.info(
                "lifecycle",
                `job #${jobId} was marked done by user; ignoring ${outcome.kind} outcome`,
            );
            return;
        }

        // Record per-attempt progress: the agent's final conclusion, the
        // WRITEUP.md scratch pad, and tool-call statistics. The session digest
        // is authoritative for conclusions (survives even when the run was
        // killed before emitting a final message); WRITEUP.md is the agent's
        // own curated state.
        const attempt = job.attempts + 1;
        const digest = digestForSession(job.pi_session_id, job.workspace);
        const attemptDigest = digest?.attempts.find(
            (a) => a.attempt === attempt,
        );
        const sessionConclusion = attemptDigest?.conclusion ?? null;
        const writeup = readWriteup(job.workspace);
        const toolCalls = attemptDigest?.tools.length ?? 0;
        const toolsUsed = [...new Set(attemptDigest?.tools ?? [])].join(",");
        const activityAt =
            attemptDigest?.lastActivity ?? digest?.lastActivity ?? null;
        db.upsertProgress({
            jobId,
            attempt,
            status: outcome.kind,
            conclusion: sessionConclusion,
            writeup,
            toolCalls,
            toolsUsed,
            activityAt,
        });

        switch (outcome.kind) {
            case "SOLVED": {
                db.updateJob(jobId, {
                    status: "SOLVED",
                    solved: 1,
                    attempts: job.attempts + 1,
                    last_flag: outcome.flag,
                    last_summary: outcome.summary,
                    last_error: null,
                });
                db.setChallengeStatus(ch.id, "SOLVED");
                this.opts.onEvent?.({
                    type: "solved",
                    jobId,
                    challenge: ch.path,
                    flag: outcome.flag,
                    summary: outcome.summary,
                });
                log.info(
                    "lifecycle",
                    `job #${jobId} (${nameOf(ch.path)}) SOLVED flag=${outcome.flag ?? "?"}`,
                );
                break;
            }
            case "FATAL": {
                db.updateJob(jobId, {
                    status: "FATAL_ERROR",
                    attempts: job.attempts + 1,
                    last_error: outcome.reason,
                    last_summary: outcome.summary,
                });
                db.setChallengeStatus(ch.id, "FATAL_ERROR");
                this.opts.onEvent?.({
                    type: "fatal",
                    jobId,
                    challenge: ch.path,
                    reason: outcome.reason,
                    summary: outcome.summary,
                });
                log.error(
                    "lifecycle",
                    `job #${jobId} (${nameOf(ch.path)}) FATAL: ${outcome.reason}`,
                );
                break;
            }
            case "BLOCKED": {
                db.updateJob(jobId, {
                    status: "BLOCKED",
                    attempts: job.attempts + 1,
                    last_error: outcome.reason,
                    last_summary: outcome.summary,
                });
                db.setChallengeStatus(ch.id, "BLOCKED");
                this.opts.onEvent?.({
                    type: "blocked",
                    jobId,
                    challenge: ch.path,
                    reason: outcome.reason,
                });
                log.warn(
                    "lifecycle",
                    `job #${jobId} (${nameOf(ch.path)}) BLOCKED: ${outcome.reason}`,
                );
                break;
            }
            case "CONTINUE": {
                db.updateJob(jobId, {
                    status: "AGENT_STOPPED",
                    attempts: job.attempts + 1,
                    last_summary: outcome.summary,
                });
                db.setChallengeStatus(ch.id, "AGENT_STOPPED");
                this.opts.onEvent?.({
                    type: "continue",
                    jobId,
                    challenge: ch.path,
                    attempt: job.attempts + 1,
                    reason: outcome.reason,
                });
                // Rotation: a run-timeout under the rotation system means the
                // TURN expired — WRITEUP.md was captured above (upsertProgress),
                // the job goes to the back of the rotation order, and the queue
                // picks the next pending challenge. After every challenge has
                // had a turn, the least-recently-rotated (the initial one)
                // resumes with its session + workspace intact.
                if (runResult?.killReason === "run-timeout") {
                    log.info(
                        "lifecycle",
                        `job #${jobId} (${nameOf(ch.path)}) turn expired after ${this.opts.turnMinutes}min — rotated; WRITEUP captured`,
                    );
                } else {
                    log.info(
                        "lifecycle",
                        `job #${jobId} (${nameOf(ch.path)}) continuing (attempt ${job.attempts + 1}: ${outcome.reason})`,
                    );
                }
                break;
            }
        }
    }

    /**
     * Startup recovery: after a dispatcher restart no run belongs to us.
     * - ALL RUNNING jobs → continuations (orphaned pi processes for their
     *   sessions are killed by the backend at the next spawn)
     * - STAGED jobs → re-run (staging is idempotent)
     */
    recoverInterruptedJobs(
        _backend: AgentBackend,
    ): Array<{ jobId: number; action: "rerun" | "continue" }> {
        void _backend;
        const actions: Array<{ jobId: number; action: "rerun" | "continue" }> =
            [];
        for (const job of db.getJobsByStatus("RUNNING")) {
            actions.push({ jobId: job.id, action: "continue" });
        }
        for (const status of ["STAGED", "HANDED_OFF"] as const) {
            for (const job of db.getJobsByStatus(status)) {
                actions.push({ jobId: job.id, action: "rerun" });
            }
        }
        return actions;
    }
}
