/**
 * /status command dump renderer: renders the dispatcher SQLite DB as plain
 * text tables (a raw dump, formatted into readable columns).
 *
 * Kept separate from the bot client so it can be unit-tested.
 */

import Database from 'better-sqlite3';

/** Max characters per Discord message (leave room for the code fence). */
export const DISCORD_CHUNK_LIMIT = 1900;

export interface DumpOptions {
    /** Shorten long text fields (summaries, errors) to this width. */
    maxWidth?: number;
}

interface ChallengeDumpRow {
    id: number;
    path: string;
    source: string;
    commit_sha: string;
    discovered_at: string;
    status: string;
}

interface JobDumpRow {
    id: number;
    challenge_id: number;
    workspace: string;
    pi_session_id: string;
    status: string;
    attempts: number;
    solved: number;
    last_flag: string | null;
    last_summary: string | null;
    last_error: string | null;
    started_at: string | null;
    created_at: string;
    updated_at: string;
}

interface MessageDumpRow {
    id: number;
    job_id: number;
    destination: string;
    content_hash: string;
    created_at: string;
}

interface MetaDumpRow {
    key: string;
    value: string;
}

interface ProgressRow {
    job_id: number;
    attempt: number;
    status: string;
    conclusion: string | null;
    writeup: string | null;
    tool_calls: number;
    tools_used: string;
    activity_at: string | null;
    updated_at: string;
}

function pad(s: string, w: number, left = false): string {
    const t = s.length > w ? s.slice(0, w) : s;
    return left ? t.padStart(w) : t.padEnd(w);
}

/** Render a full database dump. Returns the complete text (unsplit). */
export function renderDbDump(db: Database.Database, opts: DumpOptions = {}): string {
    const max = opts.maxWidth ?? 60;
    const lines: string[] = [];
    lines.push(`CTF WORKER DATABASE DUMP — ${new Date().toISOString()}`);
    lines.push('');

    // ---------------------------------------------------------------- summary
    const counts = db
        .prepare(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status ORDER BY status`)
        .all() as Array<{ status: string; n: number }>;
    if (counts.length > 0) {
        lines.push(
            'job counts: ' + counts.map((c) => `${c.status}=${c.n}`).join('  '),
        );
    } else {
        lines.push('job counts: (none)');
    }
    lines.push('');

    // ------------------------------------------------------------ challenges
    const challenges = db
        .prepare(`SELECT id, path, source, commit_sha, discovered_at, status FROM challenges ORDER BY id`)
        .all() as ChallengeDumpRow[];
    lines.push(`=== challenges (${challenges.length}) ===`);
    if (challenges.length === 0) lines.push('(empty)');
    for (const c of challenges) {
        lines.push(
            `#${c.id} ${pad(c.path, 34)} ${pad(c.status, 14)} ${c.commit_sha.slice(0, 12)} ${c.discovered_at}`,
        );
    }
    lines.push('');

    // ------------------------------------------------------------------ jobs
    const jobs = db
        .prepare(
            `SELECT id, challenge_id, workspace, pi_session_id, status, attempts, solved,
                    last_flag, last_summary, last_error, started_at, created_at, updated_at
             FROM jobs ORDER BY id`,
        )
        .all() as JobDumpRow[];
    lines.push(`=== jobs (${jobs.length}) ===`);
    if (jobs.length === 0) lines.push('(empty)');
    for (const j of jobs) {
        lines.push(
            `#${j.id} ch=${j.challenge_id} ${pad(j.status, 14)} attempts=${j.attempts} solved=${j.solved === 1 ? 'yes' : 'no'}`,
        );
        if (j.last_flag) lines.push(`     flag: ${j.last_flag.slice(0, max)}`);
        if (j.last_error) lines.push(`     error: ${j.last_error.slice(0, max).replace(/\n/g, ' ')}`);
        lines.push(`     ws: ${j.workspace}  session: ${j.pi_session_id}  updated: ${j.updated_at}`);
    }
    lines.push('');

    // -------------------------------------------------------------- progress
    try {
        const progress = db
            .prepare(
                `SELECT p.job_id, p.attempt, p.status, p.conclusion, p.writeup, p.tool_calls,
                        p.tools_used, p.activity_at, p.updated_at, c.path AS path
                 FROM progress p JOIN jobs j ON j.id = p.job_id JOIN challenges c ON c.id = j.challenge_id
                 ORDER BY p.job_id, p.attempt`,
            )
            .all() as (ProgressRow & { path: string })[];
        lines.push(`=== progress (${progress.length} attempts) ===`);
        if (progress.length === 0) lines.push('(no attempts recorded)');
        for (const p of progress) {
            lines.push(`\n[${p.path}] attempt ${p.attempt} — ${p.status} · ${p.tool_calls} tool calls (${p.tools_used || 'none'}) · ${p.updated_at}`);
            if (p.writeup) {
                lines.push('  WRITEUP.md:');
                for (const l of p.writeup.split('\n')) lines.push('  | ' + l);
            } else {
                lines.push('  WRITEUP.md: (none)');
            }
            if (p.conclusion) {
                lines.push('  conclusion:');
                for (const l of p.conclusion.split('\n').slice(0, 15)) lines.push('  > ' + l);
            }
        }
        lines.push('');
    } catch {
        // progress table might not exist in older DBs; skip silently
    }


    // -------------------------------------------------------------- messages
    try {
        const messages = db
            .prepare(
                `SELECT id, job_id, destination, content_hash, created_at FROM messages ORDER BY id LIMIT 200`,
            )
            .all() as MessageDumpRow[];
        lines.push(`=== messages (${messages.length}${messages.length === 200 ? '+' : ''}) ===`);
        if (messages.length === 0) lines.push('(empty)');
        for (const m of messages) {
            lines.push(
                `#${m.id} job=${m.job_id} ${pad(m.destination, 10)} ${m.content_hash.slice(0, 12)} ${m.created_at}`,
            );
        }
        lines.push('');
    } catch {
        // messages table might not exist in older DBs; skip silently
    }

    // ------------------------------------------------------------------ meta
    try {
        const meta = db.prepare(`SELECT key, value FROM meta ORDER BY key`).all() as MetaDumpRow[];
        lines.push(`=== meta (${meta.length}) ===`);
        for (const m of meta) lines.push(`${pad(m.key, 24)} ${m.value.slice(0, max)}`);
    } catch {
        // meta table might not exist; skip
    }

    return lines.join('\n');
}

/** Split a dump into message-sized chunks (each wrapped in a code fence). */
export function chunkForDiscord(text: string): string[] {
    if (text.length <= DISCORD_CHUNK_LIMIT) {
        return ['```\n' + text + '\n```'];
    }
    const chunks: string[] = [];
    let current = '';
    for (const line of text.split('\n')) {
        // A single overlong line becomes its own chunk (hard-split).
        if (line.length > DISCORD_CHUNK_LIMIT - 8) {
            if (current) {
                chunks.push('```\n' + current + '\n```');
                current = '';
            }
            for (let i = 0; i < line.length; i += DISCORD_CHUNK_LIMIT - 8) {
                chunks.push('```\n' + line.slice(i, i + DISCORD_CHUNK_LIMIT - 8) + '\n```');
            }
            continue;
        }
        if (current.length + line.length + 1 > DISCORD_CHUNK_LIMIT - 8) {
            chunks.push('```\n' + current + '\n```');
            current = '';
        }
        current += (current ? '\n' : '') + line;
    }
    if (current) chunks.push('```\n' + current + '\n```');
    return chunks;
}

/** Decide reply strategy: inline chunks (small dumps) vs file attachment (big). */
export function planReply(text: string): { mode: 'inline'; chunks: string[] } | { mode: 'file'; text: string } {
    const chunks = chunkForDiscord(text);
    if (chunks.length <= 2) return { mode: 'inline', chunks };
    // Too many messages: attach the whole dump as a file instead.
    return { mode: 'file', text };
}
