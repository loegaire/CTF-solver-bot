/**
 * GitHub source: lists the challenge tree via the git trees API and downloads files
 * from raw.githubusercontent.com. Unauthenticated access is subject to strict rate
 * limits, so a token is strongly recommended.
 */

import type { ChallengeSource } from "./source.js";
import type { RawFile } from "../types.js";
import { log } from "../log.js";

interface GitHubConfig {
    repo: string;
    branch: string;
    token: string;
    prefix: string;
    apiBase: string;
    rawBase: string;
}

interface TreeEntry {
    path: string;
    mode: string;
    type: "blob" | "tree" | "commit";
    size?: number;
    sha: string;
}

const logTag = "github";

export class GitHubSource implements ChallengeSource {
    private cfg: GitHubConfig;
    private cachedRevision: string | null = null;

    constructor(cfg: GitHubConfig) {
        this.cfg = cfg;
    }

    get id(): string {
        return `github:${this.cfg.repo}@${this.cfg.branch}`;
    }

    private async api(path: string, init?: RequestInit): Promise<Response> {
        const url = `${this.cfg.apiBase}${path}`;
        const headers: Record<string, string> = {
            Accept: "application/vnd.github+json",
            "User-Agent": "ctf-worker",
            ...(init?.headers as Record<string, string> | undefined),
        };
        if (this.cfg.token)
            headers["Authorization"] = `Bearer ${this.cfg.token}`;
        return fetch(url, { ...init, headers });
    }

    private async apiJson<T>(path: string): Promise<T> {
        const res = await this.api(path);
        if (!res.ok) {
            throw new Error(
                `GitHub API ${res.status} for ${path}: ${(await res.text()).slice(0, 300)}`,
            );
        }
        return (await res.json()) as T;
    }

    async currentRevision(): Promise<string> {
        // GET /repos/<repo>/branches/<branch> returns the head SHA nested under
        // .commit.sha (NOT .sha — that's undefined; the trees call then 404s).
        const info = await this.apiJson<{ commit: { sha: string } }>(
            `/repos/${this.cfg.repo}/branches/${encodeURIComponent(this.cfg.branch)}`,
        );
        this.cachedRevision = info.commit.sha;
        return info.commit.sha;
    }

    async listFiles(): Promise<RawFile[]> {
        const rev = this.cachedRevision ?? (await this.currentRevision());
        const out: RawFile[] = [];
        let url: string | null =
            `/repos/${this.cfg.repo}/git/trees/${rev}?recursive=1`;
        let pages = 0;
        while (url && pages < 50) {
            const data = await this.apiJson<{
                tree: TreeEntry[];
                truncated?: boolean;
                url?: string;
            }>(url);
            for (const e of data.tree) {
                if (e.type !== "blob") continue;
                if (e.path.includes(".git/")) continue;
                out.push({
                    path: e.path,
                    size: e.size ?? 0,
                    mode: e.mode,
                    sha: e.sha,
                });
            }
            if (data.truncated) {
                // fall back: truncated trees are rare for challenge repos; surface loudly
                throw new Error(
                    `GitHub tree listing truncated for ${this.cfg.repo}@${rev} — repo too large`,
                );
            }
            url = null;
            pages++;
        }
        log.debug(logTag, `listed ${out.length} files at ${rev}`);
        return out;
    }

    async downloadFile(path: string): Promise<Buffer> {
        const rev = this.cachedRevision ?? (await this.currentRevision());
        const url = `${this.cfg.rawBase}/${this.cfg.repo}/${this.cfg.branch}/${path}`;
        const headers: Record<string, string> = { "User-Agent": "ctf-worker" };
        if (this.cfg.token)
            headers["Authorization"] = `Bearer ${this.cfg.token}`;
        const res = await fetch(url, { headers });
        if (!res.ok) {
            throw new Error(`raw download failed ${res.status} for ${path}`);
        }
        return Buffer.from(await res.arrayBuffer());
    }
}
