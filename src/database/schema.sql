-- CTF dispatcher state schema.
-- Records dispatcher lifecycle state only — never agent reasoning.

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS challenges (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    path          TEXT NOT NULL,            -- e.g. "challenges/neon"
    source        TEXT NOT NULL,            -- e.g. "github:owner/name@main"
    commit_sha    TEXT NOT NULL,            -- revision of the source when discovered
    files_json    TEXT NOT NULL DEFAULT '[]',  -- file list snapshot at discovery
    discovered_at TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'NEW',
    UNIQUE (path, source, commit_sha)
);

CREATE TABLE IF NOT EXISTS jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    challenge_id    INTEGER NOT NULL REFERENCES challenges(id),
    workspace       TEXT NOT NULL,            -- absolute path of staged challenge dir
    pi_session_id   TEXT NOT NULL UNIQUE,     -- deterministic pi session id for this job
    status          TEXT NOT NULL DEFAULT 'NEW',
    attempts        INTEGER NOT NULL DEFAULT 0,
    solved          INTEGER NOT NULL DEFAULT 0,
    last_flag       TEXT,
    last_summary    TEXT,
    last_output     TEXT,                     -- tail of most recent agent stdout
    last_error      TEXT,                     -- fatal error description, if any
    pid             INTEGER,
    started_at      TEXT,                     -- current run start (ISO)
    last_rotated_at TEXT,                     -- when this job last got a turn (rotation ordering)
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_challenge ON jobs(challenge_id);

CREATE TABLE IF NOT EXISTS progress (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id        INTEGER NOT NULL REFERENCES jobs(id),
    attempt       INTEGER NOT NULL,
    status        TEXT NOT NULL,             -- outcome of the attempt: CONTINUE/SOLVED/FATAL/BLOCKED
    conclusion    TEXT,                      -- agent's final message for this attempt (pi session log)
    writeup       TEXT,                      -- content of WRITEUP.md (facts/hypotheses/plan scratch pad)
    tool_calls    INTEGER NOT NULL DEFAULT 0,-- number of tool calls this attempt
    tools_used    TEXT NOT NULL DEFAULT '',  -- distinct tool names, comma-separated
    activity_at   TEXT,                      -- last session activity timestamp
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (job_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_progress_job ON progress(job_id);

CREATE TABLE IF NOT EXISTS messages (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id                INTEGER NOT NULL REFERENCES jobs(id),
    destination           TEXT NOT NULL,      -- e.g. "discord"
    content_hash          TEXT NOT NULL,      -- sha256 of the sent content
    external_message_id   TEXT,
    created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_dedupe ON messages(destination, content_hash);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
