/**
 * SQLite state store (better-sqlite3, synchronous).
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const JOB_STATES = [
    "NEW",
    "STAGED",
    "HANDED_OFF",
    "RUNNING",
    "AGENT_STOPPED",
    "SOLVED",
    "FATAL_ERROR",
    "BLOCKED",
    "SKIPPED",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const CHALLENGE_STATES = [
    "NEW",
    "STAGED",
    "HANDED_OFF",
    "RUNNING",
    "AGENT_STOPPED",
    "SOLVED",
    "FATAL_ERROR",
    "BLOCKED",
    "SKIPPED",
    "REMOVED",
] as const;
export type ChallengeState = (typeof CHALLENGE_STATES)[number];

export interface ChallengeRow {
    id: number;
    path: string;
    source: string;
    commit_sha: string;
    files_json: string;
    discovered_at: string;
    status: ChallengeState;
}

export interface JobRow {
    id: number;
    challenge_id: number;
    workspace: string;
    pi_session_id: string;
    status: JobState;
    attempts: number;
    solved: number;
    last_flag: string | null;
    last_summary: string | null;
    last_output: string | null;
    last_error: string | null;
    pid: number | null;
    started_at: string | null;
    last_rotated_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface MessageRow {
    id: number;
    job_id: number;
    destination: "discord" | string;
    content_hash: string;
    external_message_id: string | null;
    created_at: string;
}

let db: Database.Database | null = null;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Locate schema.sql whether running from dist/ or src/ (tsx). */
function findSchema(): string {
    const candidates = [
        path.join(MODULE_DIR, "schema.sql"), // dist/database/schema.sql (copied by build)
        path.join(MODULE_DIR, "..", "src", "database", "schema.sql"), // repo root run
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    throw new Error("schema.sql not found next to db.js — run `npm run build`");
}

/** Open (and initialize) the database. Safe to call multiple times (tests). */
export function openDb(dbPath: string): Database.Database {
    if (db) return db;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    const schema = fs.readFileSync(findSchema(), "utf8");
    db.exec(schema);
    // Migrations for DBs created before the rotation system.
    migrateLegacy(db);
    return db;
}

/** Add columns introduced after the first release (no-ops when present). */
function migrateLegacy(d: Database.Database): void {
    const cols = d.prepare("PRAGMA table_info(jobs)").all() as Array<{
        name: string;
    }>;
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("last_rotated_at")) {
        d.exec("ALTER TABLE jobs ADD COLUMN last_rotated_at TEXT");
    }
    // One-time: the pre-purge build marked removed challenges as REMOVED
    // tombstones instead of deleting them. The git repo is the source of
    // truth — drop those tombstones so the DB only tracks what's in the repo.
    try {
        const tombstones = d
            .prepare(`SELECT id FROM challenges WHERE status = 'REMOVED'`)
            .all() as Array<{ id: number }>;
        if (tombstones.length > 0) {
            const tx = d.transaction((ids: number[]) => {
                for (const cid of ids) {
                    const jobIds = d
                        .prepare(`SELECT id FROM jobs WHERE challenge_id = ?`)
                        .all(cid) as Array<{ id: number }>;
                    for (const j of jobIds) {
                        d.prepare(`DELETE FROM progress WHERE job_id = ?`).run(
                            j.id,
                        );
                        d.prepare(`DELETE FROM messages WHERE job_id = ?`).run(
                            j.id,
                        );
                        d.prepare(`DELETE FROM jobs WHERE id = ?`).run(j.id);
                    }
                    d.prepare(`DELETE FROM challenges WHERE id = ?`).run(cid);
                }
            });
            tx(tombstones.map((t) => t.id));
            console.log(
                `[db] migration: purged ${tombstones.length} REMOVED tombstone challenge(s) — repo is the source of truth`,
            );
        }
    } catch {
        /* best effort */
    }
}

/** Close the DB (used by tests and graceful shutdown). */
export function closeDb(): void {
    db?.close();
    db = null;
}

function get(): Database.Database {
    if (!db) throw new Error("database not opened — call openDb() first");
    return db;
}

export function now(): string {
    return new Date().toISOString();
}

// ---------------------------------------------------------------- challenges

export function insertChallenge(params: {
    path: string;
    source: string;
    commitSha: string;
    filesJson: string;
    status?: ChallengeState;
}): ChallengeRow | null {
    const d = get();
    const status = params.status ?? "NEW";
    const stmt = d.prepare(
        `INSERT OR IGNORE INTO challenges (path, source, commit_sha, files_json, discovered_at, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const info = stmt.run(
        params.path,
        params.source,
        params.commitSha,
        params.filesJson,
        now(),
        status,
    );
    if (info.changes === 0) return null;
    return getChallengeById(Number(info.lastInsertRowid)) ?? null;
}

export function getChallengeById(id: number): ChallengeRow | undefined {
    return get().prepare(`SELECT * FROM challenges WHERE id = ?`).get(id) as
        | ChallengeRow
        | undefined;
}

export function setChallengeStatus(id: number, status: ChallengeState): void {
    get()
        .prepare(`UPDATE challenges SET status = ? WHERE id = ?`)
        .run(status, id);
}

export function getChallengesByStatus(status: ChallengeState): ChallengeRow[] {
    return get()
        .prepare(`SELECT * FROM challenges WHERE status = ? ORDER BY id`)
        .all(status) as ChallengeRow[];
}

export function getActiveChallenges(): ChallengeRow[] {
    return get()
        .prepare(
            `SELECT * FROM challenges
             WHERE status IN ('NEW','STAGED','HANDED_OFF','RUNNING','AGENT_STOPPED')
             ORDER BY id`,
        )
        .all() as ChallengeRow[];
}

export function challengeExists(
    path: string,
    source: string,
    commitSha: string,
): boolean {
    const row = get()
        .prepare(
            `SELECT 1 FROM challenges WHERE path = ? AND source = ? AND commit_sha = ?`,
        )
        .get(path, source, commitSha);
    return row !== undefined;
}

export function getChallengeIdByJob(jobId: number): number | undefined {
    const row = get()
        .prepare(`SELECT challenge_id FROM jobs WHERE id = ?`)
        .get(jobId) as { challenge_id: number } | undefined;
    return row?.challenge_id;
}

// --------------------------------------------------------------------- jobs

export function insertJob(params: {
    challengeId: number;
    workspace: string;
    piSessionId: string;
    status?: JobState;
}): JobRow {
    const d = get();
    const ts = now();
    const status = params.status ?? "NEW";
    const stmt = d.prepare(
        `INSERT INTO jobs (challenge_id, workspace, pi_session_id, status, attempts, solved, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
    );
    const info = stmt.run(
        params.challengeId,
        params.workspace,
        params.piSessionId,
        status,
        ts,
        ts,
    );
    return getJobById(Number(info.lastInsertRowid))!;
}

export function getJobById(id: number): JobRow | undefined {
    return get().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as
        | JobRow
        | undefined;
}

export function getJobByChallenge(challengeId: number): JobRow | undefined {
    return get()
        .prepare(
            `SELECT * FROM jobs WHERE challenge_id = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(challengeId) as JobRow | undefined;
}

export function updateJob(
    id: number,
    fields: Partial<Omit<JobRow, "id" | "challenge_id" | "created_at">>,
): void {
    const d = get();
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
        cols.push(`${k} = ?`);
        vals.push(v);
    }
    if (cols.length === 0) return;
    cols.push(`updated_at = ?`);
    vals.push(now());
    vals.push(id);
    d.prepare(`UPDATE jobs SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
}

export function getJobsByStatus(status: JobState): JobRow[] {
    return get()
        .prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY id`)
        .all(status) as JobRow[];
}

export function getJobsByStatuses(statuses: JobState[]): JobRow[] {
    const qs = statuses.map(() => "?").join(",");
    return get()
        .prepare(`SELECT * FROM jobs WHERE status IN (${qs}) ORDER BY id`)
        .all(...statuses) as JobRow[];
}

export function countJobsByStatus(): Record<string, number> {
    const rows = get()
        .prepare(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`)
        .all() as Array<{
        status: string;
        n: number;
    }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
}

export interface JobWithChallenge {
    job_id: number;
    path: string;
    status: JobState;
    attempts: number;
    updated_at: string;
}

/** Active jobs joined with their challenge path (for status dashboards). */
export function getJobsWithChallengeByStatuses(
    statuses: JobState[],
): JobWithChallenge[] {
    const qs = statuses.map(() => "?").join(",");
    return get()
        .prepare(
            `SELECT j.id AS job_id, c.path AS path, j.status AS status, j.attempts AS attempts, j.updated_at AS updated_at
             FROM jobs j JOIN challenges c ON c.id = j.challenge_id
             WHERE j.status IN (${qs})
             ORDER BY j.id`,
        )
        .all(...statuses) as JobWithChallenge[];
}

/** Most recently updated jobs joined with challenge path. */
export function getRecentJobsWithChallenge(limit: number): JobWithChallenge[] {
    return get()
        .prepare(
            `SELECT j.id AS job_id, c.path AS path, j.status AS status, j.attempts AS attempts, j.updated_at AS updated_at
             FROM jobs j JOIN challenges c ON c.id = j.challenge_id
             ORDER BY j.updated_at DESC LIMIT ?`,
        )
        .all(limit) as JobWithChallenge[];
}

/** Rotation-ordered pending jobs: least-recently-rotated first.
 * Jobs that never had a turn (last_rotated_at IS NULL) sort first by id,
 * so NEW challenges get their first turn before resuming rotated ones —
 * clearing the low-hanging fruit before revisiting hard ones. */
export function getRotationOrderedPending(): Array<
    JobRow & { challenge_path: string }
> {
    return get()
        .prepare(
            `SELECT j.*, c.path AS challenge_path FROM jobs j
             JOIN challenges c ON c.id = j.challenge_id
             WHERE j.status IN ('AGENT_STOPPED', 'STAGED', 'NEW')
               AND c.status != 'REMOVED'
             ORDER BY (j.last_rotated_at IS NULL) DESC, j.last_rotated_at ASC, j.id ASC`,
        )
        .all() as Array<JobRow & { challenge_path: string }>;
}

/** All jobs joined with their challenge path, oldest first — used by the
 * Discord panel manager to sync one message per challenge. */
export function getAllJobsWithChallengePath(): Array<
    JobRow & { challenge_path: string }
> {
    return get()
        .prepare(
            `SELECT j.*, c.path AS challenge_path FROM jobs j
             JOIN challenges c ON c.id = j.challenge_id ORDER BY j.id`,
        )
        .all() as Array<JobRow & { challenge_path: string }>;
}

/** Challenges still tracked for a given source, by path — used to detect
 * deletions: a challenge in the DB whose path is absent from the current
 * repo listing has been removed from the source. */
export function getTrackedChallengePaths(source: string): string[] {
    const rows = get()
        .prepare(
            `SELECT path FROM challenges WHERE source = ? AND status != 'REMOVED'`,
        )
        .all(source) as Array<{ path: string }>;
    return rows.map((r) => r.path);
}

/** PURGE a challenge completely from the DB: progress, messages, jobs, and
 * the challenge row itself. The git repo is the source of truth — when a
 * challenge is deleted from the repo, its entire tracking history goes too.
 * Returns the number of job rows deleted. */
export function purgeChallenge(challengeId: number): number {
    const d = get();
    const tx = d.transaction((cid: number) => {
        const jobIds = d
            .prepare(`SELECT id FROM jobs WHERE challenge_id = ?`)
            .all(cid) as Array<{ id: number }>;
        for (const j of jobIds) {
            d.prepare(`DELETE FROM progress WHERE job_id = ?`).run(j.id);
            d.prepare(`DELETE FROM messages WHERE job_id = ?`).run(j.id);
            d.prepare(`DELETE FROM jobs WHERE id = ?`).run(j.id);
        }
        d.prepare(`DELETE FROM challenges WHERE id = ?`).run(cid);
        return jobIds.length;
    });
    return tx(challengeId) as number;
}

/** Challenge rows for a given source + path (any fingerprint) — used by the
 * repo-sync prune to kill all versions of a deleted challenge. */
export function getChallengesBySourcePath(
    source: string,
    path: string,
): Array<{ id: number }> {
    return get()
        .prepare(`SELECT id FROM challenges WHERE source = ? AND path = ?`)
        .all(source, path) as Array<{ id: number }>;
}

/** Jobs that are supposed to be running but whose process died or vanished.
 * Kept for CLI/manual diagnostics. */
export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException).code;
        return code === "EPERM";
    }
}

export interface ProgressRow {
    id: number;
    job_id: number;
    attempt: number;
    status: string;
    conclusion: string | null;
    writeup: string | null;
    tool_calls: number;
    tools_used: string;
    activity_at: string | null;
    created_at: string;
    updated_at: string;
}

/** Insert or update the per-attempt progress record for a job. */
export function upsertProgress(params: {
    jobId: number;
    attempt: number;
    status: string;
    conclusion?: string | null;
    writeup?: string | null;
    toolCalls?: number;
    toolsUsed?: string;
    activityAt?: string | null;
}): void {
    const d = get();
    d.prepare(
        `INSERT INTO progress (job_id, attempt, status, conclusion, writeup, tool_calls, tools_used, activity_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id, attempt) DO UPDATE SET
           status = excluded.status,
           conclusion = COALESCE(excluded.conclusion, progress.conclusion),
           writeup = COALESCE(excluded.writeup, progress.writeup),
           tool_calls = MAX(excluded.tool_calls, progress.tool_calls),
           tools_used = excluded.tools_used,
           activity_at = COALESCE(excluded.activity_at, progress.activity_at),
           updated_at = excluded.updated_at`,
    ).run(
        params.jobId,
        params.attempt,
        params.status,
        params.conclusion ?? null,
        params.writeup ?? null,
        params.toolCalls ?? 0,
        params.toolsUsed ?? "",
        params.activityAt ?? null,
        now(),
        now(),
    );
}

export function getProgress(jobId: number): ProgressRow[] {
    return get()
        .prepare(`SELECT * FROM progress WHERE job_id = ? ORDER BY attempt`)
        .all(jobId) as ProgressRow[];
}

// ----------------------------------------------------------------- messages

export function insertMessage(params: {
    jobId: number;
    destination: string;
    contentHash: string;
    externalMessageId?: string | null;
}): boolean {
    const d = get();
    try {
        d.prepare(
            `INSERT INTO messages (job_id, destination, content_hash, external_message_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
        ).run(
            params.jobId,
            params.destination,
            params.contentHash,
            params.externalMessageId ?? null,
            now(),
        );
        return true;
    } catch (e: unknown) {
        if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE")
            return false;
        throw e;
    }
}

export function messageAlreadySent(
    destination: string,
    contentHash: string,
): boolean {
    const row = get()
        .prepare(
            `SELECT 1 FROM messages WHERE destination = ? AND content_hash = ?`,
        )
        .get(destination, contentHash);
    return row !== undefined;
}

// --------------------------------------------------------------------- meta

export function getMeta(key: string): string | undefined {
    const row = get()
        .prepare(`SELECT value FROM meta WHERE key = ?`)
        .get(key) as { value: string } | undefined;
    return row?.value;
}

export function setMeta(key: string, value: string): void {
    get()
        .prepare(
            `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(key, value);
}
