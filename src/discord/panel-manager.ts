/**
 * PanelManager: keeps ONE control message per challenge in sync.
 *
 * Message layout (single message):
 *   - text: meta head — challenge name, status, flag, pending, instruction
 *   - when the whole WRITEUP.md doesn't fit the text limit: attached as a
 *     WRITEUP.md file on the SAME message (text keeps the meta)
 *
 * ✅ done reaction on the control message → queue.markDone.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as db from "../database/db.js";
import { log } from "../log.js";
import {
    PanelRegistry,
    renderPanelMessages,
    type PanelData,
    type PanelStatus,
} from "./panels.js";

interface BotLike {
    /** Post the control message (text + optional file); returns message id. */
    postPanel(
        channelId: string,
        content: string,
        file: { name: string; data: string } | null,
    ): Promise<string | null>;
    /** Update the control message (text + optional file). */
    updatePanel(
        channelId: string,
        messageId: string,
        content: string,
        file: { name: string; data: string } | null,
    ): Promise<void>;
    onDoneReaction: ((jobId: number) => void) | null;
    panelJobForMessage: ((messageId: string) => number | null) | null;
    panelsChannelId: string | null;
    announceChannelId: string | null;
}

export interface PanelManagerOptions {
    /** Where panel message-id state lives (alongside the DB). */
    stateDir: string;
    /** Refresh interval for panels (ms). */
    refreshMs: number;
    /** Job workspaces root (to read WRITEUP.md). */
    jobsDir: string;
}

export class PanelManager {
    private bot: BotLike | null = null;
    private registry: PanelRegistry;
    private opts: PanelManagerOptions;
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    /** Wired to queue.markDone by index.ts. */
    doneHandler: ((jobId: number) => void) | null = null;
    private lastRender = new Map<number, string>();
    private updateCount = 0;

    constructor(opts: PanelManagerOptions) {
        this.opts = opts;
        this.registry = new PanelRegistry(opts.stateDir);
    }

    /** Bind the bot; call once channels are resolved (post-READY). */
    attach(bot: BotLike): void {
        this.bot = bot;
        bot.onDoneReaction = (jobId) => this.doneHandler?.(jobId);
        bot.panelJobForMessage = (messageId) =>
            this.registry.jobForMessage(messageId);
    }

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(
            () => void this.refreshAll().catch(() => {}),
            this.opts.refreshMs,
        );
        void this.refreshAll().catch(() => {});
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    // ---------------------------------------------------------------- helpers

    private readWriteup(workspace: string): string | null {
        try {
            const text = fs
                .readFileSync(path.join(workspace, "WRITEUP.md"), "utf8")
                .trim();
            return text || null;
        } catch {
            return null;
        }
    }

    private statusOf(job: db.JobRow): PanelStatus {
        const ch = db.getChallengeById(job.challenge_id);
        if (ch?.status === "REMOVED") return "REMOVED";
        switch (job.status) {
            case "NEW":
            case "STAGED":
            case "HANDED_OFF":
            case "AGENT_STOPPED":
                return "PENDING";
            case "RUNNING":
                return "RUNNING";
            case "SOLVED":
                return "SOLVED";
            case "BLOCKED":
                return "BLOCKED";
            case "FATAL_ERROR":
                return "FATAL_ERROR";
            case "SKIPPED":
                return "SKIPPED";
        }
    }

    private panelData(job: db.JobRow, challengePath: string): PanelData {
        const status = this.statusOf(job);
        let writeup: string | null = null;
        if (status === "RUNNING" || status === "PENDING") {
            writeup = this.readWriteup(job.workspace);
        } else if (
            status === "SOLVED" ||
            status === "BLOCKED" ||
            status === "FATAL_ERROR"
        ) {
            writeup = job.last_summary || this.readWriteup(job.workspace);
        }
        return {
            jobId: job.id,
            challengePath,
            status,
            writeup,
            flag: job.last_flag,
        };
    }

    /** Render fingerprint: skip syncing when nothing changed. */
    private fingerprintOf(data: PanelData): string {
        return `${data.status}|${data.flag ?? ""}|${data.writeup ?? ""}`;
    }

    // ---------------------------------------------------------------- sync

    /** Sync all control messages: create missing, update changed, remove stale. */
    async refreshAll(): Promise<void> {
        const channelId =
            this.bot?.panelsChannelId ?? this.bot?.announceChannelId ?? null;
        if (this.running || !this.bot || !channelId) return;
        this.running = true;
        try {
            const jobs = db.getAllJobsWithChallengePath();
            const liveIds = new Set(jobs.map((j) => j.id));

            // Remove panels for jobs that no longer exist.
            for (const [jobId, messageId] of this.registry.entries()) {
                if (!liveIds.has(jobId)) {
                    try {
                        await this.bot.updatePanel(
                            channelId,
                            messageId,
                            "(removed)",
                            null,
                        );
                    } catch {
                        /* message may be gone */
                    }
                    this.registry.delete(jobId);
                    this.lastRender.delete(jobId);
                }
            }

            let created = 0;
            for (const job of jobs) {
                // Challenge-level skip wins (whole challenge marked solved).
                const ch = db.getChallengeById(job.challenge_id);
                if (ch?.status === "SKIPPED" && job.status !== "SKIPPED") {
                    db.updateJob(job.id, { status: "SKIPPED", pid: null });
                    job.status = "SKIPPED";
                }
                if (ch?.status === "REMOVED") {
                    db.updateJob(job.id, { status: "SKIPPED", pid: null });
                    job.status = "SKIPPED";
                }

                const data = this.panelData(job, job.challenge_path);
                const fp = this.fingerprintOf(data);
                if (this.lastRender.get(job.id) === fp) continue; // unchanged
                this.lastRender.set(job.id, fp);

                const messages = renderPanelMessages(data);
                const existing = this.registry.get(job.id);
                if (existing) {
                    // Discord PATCH limit: ~5/5s. Space updates out; the rest()
                    // 429 handler adds per-request Retry-After as a fallback.
                    if (this.updateCount % 4 === 3) {
                        await new Promise((r) => setTimeout(r, 6_000));
                    }
                    this.updateCount++;
                    await this.bot.updatePanel(
                        channelId,
                        existing,
                        messages.content,
                        messages.file,
                    );
                } else {
                    const messageId = await this.bot.postPanel(
                        channelId,
                        messages.content,
                        messages.file,
                    );
                    if (messageId) this.registry.set(job.id, messageId);
                    // Pace creation: ~5 msgs per 5s per channel (Discord guidance).
                    created++;
                    if (created % 5 === 0)
                        await new Promise((r) => setTimeout(r, 6_000));
                }
            }
        } catch (e) {
            log.warn("panels", `refresh failed: ${(e as Error).message}`);
        } finally {
            this.running = false;
        }
    }
}
