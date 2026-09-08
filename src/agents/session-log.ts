/**
 * Session-log reader: parses pi's own session JSONL (the authoritative record
 * of everything the agent said — pi has no internal todo/goal state, the
 * transcript IS the state).
 *
 * Because the dispatcher pins `--session-id ctf-<challengeId>`, a job's session
 * file is deterministic and can be located by id. This module extracts
 * per-attempt "conclusions" (the final assistant text of each run) without
 * touching the agent's workflow.
 *
 * Session file layout (from pi's session format docs + observed files):
 *   ~/.pi/agent/sessions/<sanitized-cwd>/<timestamp>_<sessionId>.jsonl
 *   one line per entry: {"type":"session"|"session_info"|"model_change"|
 *                        "thinking_level_change"|"message", ...}
 *   message entries: {"type":"message","message":{"role":"user"|"assistant"|
 *                     "toolResult", "content":[{type,...}], ...}}
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SessionAttempt {
    /** 1-based attempt index (user prompts that start a run). */
    attempt: number;
    /** The user prompt that started this run (initial or continuation). */
    promptHead: string;
    /** Final assistant text of this run — its "conclusion dialog". */
    conclusion: string;
    /** Assistant text produced during the run (excluding the conclusion). */
    otherAssistantText: string[];
    /** Tool names invoked during the run. */
    tools: string[];
    /** Timestamp of the last entry in this run. */
    lastActivity: string | null;
}

export interface SessionDigest {
    sessionId: string;
    file: string;
    attempts: SessionAttempt[];
    /** Latest conclusion across all attempts (for "ongoing" display). */
    latestConclusion: string;
    /** All tools ever used across attempts. */
    allTools: string[];
    lastActivity: string | null;
}

interface ContentBlock {
    type: string;
    text?: string;
    thinking?: string;
}

interface MessageEntry {
    type: 'message';
    message: {
        role: string;
        content?: ContentBlock[];
        timestamp?: number;
        toolName?: string;
    };
}

const INITIAL_PROMPT_PREFIX = 'Analyze and solve this CTF challenge';
const CONTINUATION_PROMPT_PREFIX = 'Continue working on the challenge';

/** Sessions root (mirrors pi's layout; override for tests). */
export function sessionsRoot(): string {
    return process.env.PI_SESSIONS_DIR ?? path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

/** Sanitized-cwd directory name pi uses for a workspace path. */
function sanitizeCwd(cwd: string): string {
    return '-' + cwd.replace(/[^A-Za-z0-9]/g, '-') + '-';
}

/**
 * Locate the session JSONL for a session id.
 * The fast path derives the directory from the workspace cwd (pi's layout).
 * The fallback scans session dirs, but ONLY accepts a file whose header
 * (id + cwd) matches — a session id like "ctf-1" alone is not unique across
 * different jobs/databases, so unverified matches would leak another
 * challenge's transcript.
 */
export function findSessionFile(sessionId: string, workspace?: string): string | null {
    const root = sessionsRoot();
    const candidates: string[] = [];

    // Fast path: sanitized-cwd directory for this workspace.
    if (workspace) {
        const dir = path.join(root, sanitizeCwd(workspace));
        try {
            candidates.push(
                ...fs
                    .readdirSync(dir)
                    .filter((f) => f.endsWith(`_${sessionId}.jsonl`))
                    .map((f) => path.join(dir, f)),
            );
        } catch {
            /* dir missing; fall through */
        }
    }

    // Fallback: scan all session dirs for `<timestamp>_<sessionId>.jsonl`.
    if (candidates.length === 0) {
        try {
            for (const d of fs.readdirSync(root)) {
                const dir = path.join(root, d);
                try {
                    if (!fs.statSync(dir).isDirectory()) continue;
                    candidates.push(
                        ...fs
                            .readdirSync(dir)
                            .filter((f) => f.endsWith(`_${sessionId}.jsonl`))
                            .map((f) => path.join(dir, f)),
                    );
                } catch {
                    /* unreadable dir; keep scanning */
                }
            }
        } catch {
            return null;
        }
    }

    if (candidates.length === 0) return null;
    // Newest first (filename starts with a timestamp).
    candidates.sort().reverse();

    // Verify each candidate: header id must match; if a workspace is given,
    // its recorded cwd must match too.
    for (const file of candidates) {
        const header = readSessionHeader(file);
        if (!header || header.id !== sessionId) continue;
        if (workspace && path.resolve(header.cwd ?? '') !== path.resolve(workspace)) continue;
        return file;
    }
    return null;
}

interface SessionHeader {
    id?: string;
    cwd?: string;
}

/** Read the first line (session header) of a session file, tolerating torn writes. */
function readSessionHeader(file: string): SessionHeader | null {
    try {
        const fd = fs.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(1024);
            const n = fs.readSync(fd, buf, 0, 1024, 0);
            const firstLine = buf.toString('utf8', 0, n).split('\n')[0];
            return JSON.parse(firstLine) as SessionHeader;
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return null;
    }
}

function textOf(content?: ContentBlock[]): string {
    if (!content) return '';
    return content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!)
        .join('\n')
        .trim();
}

/**
 * Parse a session file into per-attempt digests.
 * An "attempt" starts at each user prompt matching the dispatcher's initial or
 * continuation prompt; everything until the next such prompt belongs to it.
 */
export function parseSessionFile(file: string): SessionDigest | null {
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }

    const attempts: SessionAttempt[] = [];
    let current: SessionAttempt | null = null;
    const allTools: string[] = [];
    let lastActivity: string | null = null;
    let sessionId = '';

    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let entry: any;
        try {
            entry = JSON.parse(line);
        } catch {
            continue; // tolerate torn tail writes
        }
        if (entry.type === 'session') {
            sessionId = entry.id ?? sessionId;
            continue;
        }
        if (entry.type !== 'message') continue;
        const m = (entry as MessageEntry).message;
        if (!m) continue;
        const role = m.role;

        if (role === 'user') {
            const text = textOf(m.content);
            if (
                text.startsWith(INITIAL_PROMPT_PREFIX) ||
                text.startsWith(CONTINUATION_PROMPT_PREFIX)
            ) {
                if (current) attempts.push(current);
                const attemptNo = attempts.length + 1;
                current = {
                    attempt: attemptNo,
                    promptHead: text.split('\n')[0].slice(0, 120),
                    conclusion: '',
                    otherAssistantText: [],
                    tools: [],
                    lastActivity: null,
                };
            }
            continue;
        }

        if (role === 'assistant' && current) {
            const text = textOf(m.content);
            if (text) {
                // The most recent assistant text becomes the running conclusion;
                // earlier ones move to "other".
                if (current.conclusion) current.otherAssistantText.push(current.conclusion);
                current.conclusion = text;
            }
            if (m.timestamp) current.lastActivity = new Date(m.timestamp).toISOString();
            continue;
        }

        if (role === 'toolResult' && current) {
            if (m.toolName) {
                current.tools.push(m.toolName);
                if (!allTools.includes(m.toolName)) allTools.push(m.toolName);
            }
            if (m.timestamp) current.lastActivity = new Date(m.timestamp).toISOString();
            continue;
        }
    }
    if (current) attempts.push(current);

    if (attempts.length === 0) return null;
    // Latest non-empty conclusion across attempts.
    let latest = '';
    for (const a of attempts) {
        if (a.conclusion) latest = a.conclusion;
    }
    for (const a of attempts) {
        if (a.lastActivity) lastActivity = a.lastActivity;
    }

    return {
        sessionId: sessionId || path.basename(file),
        file,
        attempts,
        latestConclusion: latest,
        allTools,
        lastActivity,
    };
}

/** Convenience: digest for a job's pi session, or null when unavailable. */
export function digestForSession(sessionId: string, workspace?: string): SessionDigest | null {
    const file = findSessionFile(sessionId, workspace);
    if (!file) return null;
    return parseSessionFile(file);
}
