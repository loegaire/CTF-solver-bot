/**
 * DiscordReporter: turns lifecycle events + DB state into Discord messages.
 * Publishing is deduped via the messages table and entirely non-fatal:
 * a Discord outage never affects challenge processing.
 */

import * as db from '../database/db.js';
import type { LifecycleEvent } from '../dispatcher/lifecycle.js';
import type { Publisher } from './publisher.js';
import { contentHash } from './publisher.js';
import { log } from '../log.js';

function nameOf(path: string): string {
    return path.split('/').filter(Boolean).pop() ?? path;
}

function firstLines(text: string, n: number): string {
    const lines = (text ?? '').split('\n').filter((l) => l.trim() !== '');
    return lines.slice(0, n).join('\n').slice(0, 900);
}

export class DiscordReporter {
    private publisher: Publisher;

    constructor(publisher: Publisher) {
        this.publisher = publisher;
    }

    /** Send a deduped message; returns true when actually delivered. */
    private async send(jobId: number, text: string): Promise<boolean> {
        try {
            const hash = contentHash(text);
            if (db.messageAlreadySent(this.publisher.name, hash)) return false;
            const delivered = await this.publisher.publish(text);
            if (delivered) {
                db.insertMessage({
                    jobId,
                    destination: this.publisher.name,
                    contentHash: hash,
                });
            }
            return delivered;
        } catch (e) {
            log.warn('reporter', `send failed: ${(e as Error).message}`);
            return false;
        }
    }

    /** Translate a lifecycle event into a human-readable Discord message. */
    async onEvent(event: LifecycleEvent): Promise<void> {
        const name = nameOf(event.challenge);
        const jobId = event.jobId;
        switch (event.type) {
            case 'staged':
                await this.send(jobId, `**${name}** — staged, handing to pi (job #${jobId})`);
                break;
            case 'started':
                await this.send(
                    jobId,
                    event.resume
                        ? `**${name}** — continuing (attempt ${event.attempt})`
                        : `**${name}** — started (job #${jobId})`,
                );
                break;
            case 'solved': {
                const flagLine = event.flag ? `\nFlag: \`${event.flag}\`` : '';
                await this.send(
                    jobId,
                    `✅ **${name}** — SOLVED${flagLine}\n\n${firstLines(event.summary, 12)}`,
                );
                break;
            }
            case 'fatal':
                await this.send(
                    jobId,
                    `⛔ **${name}** — fatal error: ${event.reason}\n\n${firstLines(event.summary, 6)}`,
                );
                break;
            case 'blocked':
                await this.send(jobId, `⏸ **${name}** — blocked (${event.reason})`);
                break;
            case 'continue':
                await this.send(jobId, `↻ **${name}** — agent stopped unsolved, forcing continue (attempt ${event.attempt})`);
                break;
        }
    }

    /** Periodic status dashboard built from DB state. */
    async statusSnapshot(): Promise<string> {
        const counts = db.countJobsByStatus();
        const active = db.getJobsWithChallengeByStatuses(['NEW', 'STAGED', 'HANDED_OFF', 'RUNNING', 'AGENT_STOPPED']);
        const recent = db.getRecentJobsWithChallenge(8);

        const lines: string[] = ['**CTF Worker status**', ''];
        lines.push(
            `Queued: ${(counts['NEW'] ?? 0) + (counts['STAGED'] ?? 0)} · Running: ${counts['RUNNING'] ?? 0} · Solved: ${counts['SOLVED'] ?? 0} · Fatal: ${counts['FATAL_ERROR'] ?? 0} · Blocked: ${counts['BLOCKED'] ?? 0}`,
        );
        if (active.length > 0) {
            lines.push('', '**Active**');
            for (const j of active.slice(0, 10)) {
                lines.push(`- ${nameOf(j.path)} [${j.status}]`);
            }
        }
        if (recent.length > 0) {
            lines.push('', '**Recent**');
            for (const r of recent) {
                lines.push(`- ${nameOf(r.path)} → ${r.status}`);
            }
        }
        return lines.join('\n');
    }
}
