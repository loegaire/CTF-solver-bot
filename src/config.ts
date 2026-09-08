/**
 * Configuration: process env > env file (CTF_ENV_FILE or ./.env) > defaults.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type SourceKind = "github" | "local";
export type AgentKind = "pi" | "echo";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
    source: SourceKind;
    github: {
        repo: string; // "owner/name"
        branch: string;
        token: string;
        /** "auto" (default): use <prefix>/challenges if it exists, else repo root.
         *  A specific path: use exactly that. "" explicitly means repo root. */
        prefix: string;
        /** Comma-separated top-level dir names to never treat as challenges
         *  (e.g. writeups, scripts, docs). Only used in root-discovery mode. */
        exclude: string[];
        apiBase: string;
        rawBase: string;
    };
    local: {
        dir: string;
        prefix: string;
        exclude: string[];
    };
    pollIntervalSec: number;
    /** Turn duration for the rotation system: after this many minutes on a
     * challenge, the agent's WRITEUP is captured and the queue rotates to the
     * next pending challenge. First full round resumes earlier challenges. */
    turnMinutes: number;
    webhook: {
        enabled: boolean;
        port: number;
        host: string;
        secret: string;
    };
    dbPath: string;
    jobsDir: string;
    maxConcurrent: number;
    maxAttempts: number;
    idleTimeoutMin: number;
    runTimeoutMin: number;
    killGraceSec: number;
    agent: AgentKind;
    piBin: string;
    piExtraArgs: string[];
    echoScript: "solved" | "unsolved" | "fatal";
    statusIntervalSec: number;
    discordWebhookUrl: string;
    discordBot: {
        enabled: boolean;
        token: string;
        applicationId: string;
        /** Channel for SOLVED announcements (empty = auto-detect: prefer a
         * channel literally named "solved", then "announcements", "general",
         * then the first text channel). */
        announceChannelId: string;
    };
    logLevel: LogLevel;
    once: boolean;
    scanOnly: boolean;
}

function parseEnvFile(file: string): Record<string, string> {
    const out: Record<string, string> = {};
    try {
        const text = fs.readFileSync(file, "utf8");
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith("#")) continue;
            const eq = line.indexOf("=");
            if (eq <= 0) continue;
            const key = line.slice(0, eq).trim();
            let value = line.slice(eq + 1).trim();
            if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
            ) {
                value = value.slice(1, -1);
            }
            out[key] = value;
        }
    } catch {
        // missing env file is fine
    }
    return out;
}

export function loadConfig(): Config {
    const argv = process.argv.slice(2);
    const once = argv.includes("--once");
    const scanOnly = argv.includes("--scan");

    const envFile = process.env.CTF_ENV_FILE ?? path.resolve(".env");
    const fileEnv = parseEnvFile(envFile);

    /** Get a config value: process env > env file > default.
     * Returns `string` when a default is provided (default always wins over
     * an empty value except for the two keys where "" is a meaningful setting),
     * and `string | undefined` when not. */
    const get = <T extends string | undefined>(
        k: string,
        d?: T,
    ):
        | string
        | (T extends string ? never : undefined)
        | (T extends string ? string : undefined) => {
        const v = process.env[k] ?? fileEnv[k];
        if (v === undefined) return d as never;
        if (v === "") {
            if (k === "GITHUB_CHALLENGES_PREFIX" || k === "DISCORD_WEBHOOK_URL")
                return "" as never;
            return d as never;
        }
        return v as never;
    };
    const num = (k: string, d: number): number => {
        const v = get(k);
        if (v === undefined) return d;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : d;
    };
    const bool = (k: string, d: boolean): boolean => {
        const v = get(k)?.toLowerCase();
        if (v === undefined) return d;
        return v === "true" || v === "1" || v === "yes" || v === "on";
    };

    const source = (get("SOURCE") ?? "github") as SourceKind;
    if (source !== "github" && source !== "local") {
        throw new Error(`SOURCE must be "github" or "local", got: ${source}`);
    }

    const localDir = path.resolve(get("LOCAL_SOURCE_DIR", "")!);
    if (source === "local" && !fs.existsSync(localDir)) {
        throw new Error(`LOCAL_SOURCE_DIR does not exist: ${localDir}`);
    }

    let githubRepo = get("GITHUB_REPO", "")!;
    const token = get("GITHUB_TOKEN", "")!;
    if (source === "github") {
        if (!/^[^/\s]+\/[^/\s]+$/.test(githubRepo)) {
            throw new Error(
                'GITHUB_REPO must be set to "owner/name" (or set SOURCE=local for a local directory source).',
            );
        }
    }
    githubRepo = githubRepo.replace(/\.git$/, "");

    const echoScript = (get("ECHO_SCRIPT") ??
        "unsolved") as Config["echoScript"];

    /** Parse the prefix setting: "auto" (default) → marker literal; "" → root;
     *  anything else → that path. Marked with a sentinel for auto resolution. */
    const PREFIX_AUTO = "auto";
    const rawPrefix = (get("GITHUB_CHALLENGES_PREFIX", "auto") ??
        "auto")!.trim();
    const prefix =
        rawPrefix === ""
            ? ""
            : rawPrefix === PREFIX_AUTO
              ? PREFIX_AUTO
              : rawPrefix.replace(/^\/+|\/+$/g, "");
    const exclude = get(
        "GITHUB_EXCLUDE",
        "writeups,scripts,docs,tools,templates,utils,notes,infrastructure,.github",
    )!
        .split(",")
        .map((s) => s.trim().replace(/^\/+|\/+$/g, ""))
        .filter((s) => s !== "");

    const cfg: Config = {
        source,
        github: {
            repo: githubRepo,
            branch: get("GITHUB_BRANCH", "main")!,
            token,
            prefix,
            exclude,
            apiBase: get("GITHUB_API_BASE", "https://api.github.com")!.replace(
                /\/+$/,
                "",
            ),
            rawBase: get(
                "GITHUB_RAW_BASE",
                "https://raw.githubusercontent.com",
            )!.replace(/\/+$/, ""),
        },
        local: {
            dir: localDir,
            prefix,
            exclude,
        },
        pollIntervalSec: num("POLL_INTERVAL_SEC", 120),
        turnMinutes: num("TURN_MINUTES", 10),
        webhook: {
            enabled: bool("WEBHOOK_ENABLED", true),
            port: num("WEBHOOK_PORT", 4567),
            host: get("WEBHOOK_HOST", "127.0.0.1")!,
            secret: get("WEBHOOK_SECRET", "")!,
        },
        dbPath: path.resolve(get("DB_PATH", "data/ctf-worker.db")!),
        jobsDir: path.resolve(get("JOBS_DIR", "jobs")!),
        maxConcurrent: Math.max(1, num("MAX_CONCURRENT", 1)),
        maxAttempts: Math.max(1, num("MAX_ATTEMPTS", 20)),
        idleTimeoutMin: num("IDLE_TIMEOUT_MIN", 10),
        runTimeoutMin: num("RUN_TIMEOUT_MIN", 120),
        killGraceSec: Math.max(1, num("KILL_GRACE_SEC", 15)),
        agent: (get("AGENT_BACKEND", "pi") as AgentKind) ?? "pi",
        piBin: get("PI_BIN", "pi")!,
        piExtraArgs: get("PI_EXTRA_ARGS", "")!.split(/\s+/).filter(Boolean),
        echoScript: ["solved", "unsolved", "fatal"].includes(echoScript)
            ? echoScript
            : "unsolved",
        statusIntervalSec: num("STATUS_INTERVAL_SEC", 60),
        discordWebhookUrl: get("DISCORD_WEBHOOK_URL", "")!,
        discordBot: {
            enabled: bool("DISCORD_BOT_ENABLED", false),
            token: get("DISCORD_BOT_TOKEN", "")!,
            applicationId: get("DISCORD_APPLICATION_ID", "")!,
            announceChannelId: get("DISCORD_ANNOUNCE_CHANNEL_ID", "")!,
        },
        logLevel: (get("LOG_LEVEL", "info") as LogLevel) ?? "info",
        once,
        scanOnly,
    };

    if (cfg.agent !== "pi" && cfg.agent !== "echo") {
        throw new Error(
            `AGENT_BACKEND must be "pi" or "echo", got: ${cfg.agent}`,
        );
    }
    return cfg;
}
