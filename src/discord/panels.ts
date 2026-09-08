/**
 * Discord job control panels.
 *
 * ONE control message per challenge (the ✅ reaction lives on it):
 *   - Meta at the TOP of the message text: challenge name, status, flag,
 *     "pending", instruction line — never wrapped into the file.
 *   - The WHOLE WRITEUP.md: inline when it fits in one message; when it
 *     exceeds the limit, attached as a WRITEUP.md file on the SAME single
 *     message (the message text keeps the meta).
 */

import * as fs from "node:fs";
import * as path from "node:path";

const DONE_EMOJI = "✅";

/** Discord message content limit (small safety margin). */
const MESSAGE_MAX = 1990;

/** Persisted panel registry: jobId -> control message id. Migrates the
 * legacy chain format ({header, writeups}) by keeping the header id. */
export class PanelRegistry {
    private file: string;
    private data = new Map<number, string>();

    constructor(stateDir: string) {
        this.file = path.join(stateDir, "panels.json");
        try {
            const raw = JSON.parse(
                fs.readFileSync(this.file, "utf8"),
            ) as Record<
                string,
                string | { header: string; writeups?: string[] }
            >;
            for (const [k, v] of Object.entries(raw)) {
                this.data.set(Number(k), typeof v === "string" ? v : v.header);
            }
        } catch {
            /* fresh */
        }
    }

    get(jobId: number): string | null {
        return this.data.get(jobId) ?? null;
    }

    set(jobId: number, messageId: string): void {
        this.data.set(jobId, messageId);
        this.save();
    }

    delete(jobId: number): void {
        this.data.delete(jobId);
        this.save();
    }

    /** Reverse lookup: message id -> job id. */
    jobForMessage(messageId: string): number | null {
        for (const [jobId, mid] of this.data) {
            if (mid === messageId) return jobId;
        }
        return null;
    }

    entries(): Array<[number, string]> {
        return [...this.data.entries()];
    }

    private save(): void {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const obj: Record<string, string> = {};
            for (const [k, v] of this.data) obj[String(k)] = v;
            fs.writeFileSync(this.file, JSON.stringify(obj, null, 2));
        } catch {
            /* best effort */
        }
    }
}

export type PanelStatus =
    | "PENDING"
    | "RUNNING"
    | "SOLVED"
    | "BLOCKED"
    | "FATAL_ERROR"
    | "SKIPPED"
    | "REMOVED";

export interface PanelData {
    jobId: number;
    challengePath: string;
    status: PanelStatus;
    /** WRITEUP.md content (running) or final summary/conclusion. */
    writeup: string | null;
    /** Flag when solved. */
    flag: string | null;
}

/** A file attachment for the control message (whole writeup). */
export interface PanelFile {
    name: string;
    data: string;
}

/** Rendered control message: text content + optional file. */
export interface PanelMessages {
    content: string;
    file: PanelFile | null;
}

/** Instruction line shown on the control message. */
function instructionLine(status: PanelStatus): string {
    if (status === "RUNNING") {
        return `React ${DONE_EMOJI} to stop this challenge (skip further attempts)`;
    }
    if (status === "PENDING") {
        return `React ${DONE_EMOJI} if this is already solved — it will be skipped`;
    }
    return "";
}

/**
 * Render the control message. Meta always at the top of the text; the whole
 * WRITEUP.md inline when it fits, otherwise attached as WRITEUP.md on the
 * same message.
 */
export function renderPanelMessages(data: PanelData): PanelMessages {
    const name =
        data.challengePath.replace(/^challenges\//, "") || data.challengePath;

    // ---- meta block (always the message text head) ----
    const meta: string[] = [];
    meta.push(`**${name}** — ${data.status}`);
    if (data.status === "SOLVED" && data.flag) {
        meta.push(`Flag: \`${data.flag}\``);
    }
    if (data.status === "PENDING" && !data.writeup) {
        meta.push("", "pending");
    }
    const instr = instructionLine(data.status);
    if (instr) meta.push("", instr);
    const metaText = meta.join("\n");

    // ---- whole writeup ----
    if (!data.writeup) return { content: metaText, file: null };

    const inline = `${metaText}\n\n\`\`\`md\n${data.writeup}\n\`\`\``;
    if (inline.length <= MESSAGE_MAX) {
        return { content: inline, file: null };
    }
    // Too long for one message: the writeup becomes a file attachment on the
    // same control message; the meta stays as the visible text.
    return {
        content: metaText,
        file: { name: "WRITEUP.md", data: data.writeup },
    };
}

export { DONE_EMOJI, MESSAGE_MAX };
