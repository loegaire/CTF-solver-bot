/**
 * Challenge source abstraction.
 *
 * A source lists files at a fixed revision and can download an individual file.
 * Discovery is pull-based; the webhook server (dispatcher/webhook.ts) merely triggers
 * an early poll, so the webhook is an optimization, never a dependency.
 */

import type { ChallengeFile, ChallengeRef, RawFile } from "../types.js";

/** Prefix sentinel meaning "discover everywhere in the repo" (default). */
export const PREFIX_AUTO = "auto";

export interface ChallengeSource {
    readonly id: string;
    /** Current revision (commit SHA for git sources, manifest hash for others). */
    currentRevision(): Promise<string>;
    /** List ALL files at the current revision (the discovery tree). */
    listFiles(): Promise<RawFile[]>;
    /** Download one file's bytes at the current revision. */
    downloadFile(path: string): Promise<Buffer>;
}

/**
 * Recursive challenge grouping.
 *
 * A "challenge" is a directory that DIRECTLY contains at least one file, anchored
 * on README.md: a dir that directly contains README.md is a challenge; a dir with
 * direct files but no README anywhere beneath it is the deepest file-bearing dir.
 * Directories with only subdirectories (categories: challenges/web/…) are
 * traversed, never treated as challenges. When both a dir and a descendant
 * qualify, the OUTERMOST wins (a README inside challenge files/ belongs to the
 * challenge, not a sub-challenge).
 *
 * This handles every layout:
 *   neon/README.md                        → challenge "neon"
 *   challenges/web/blind/README.md        → challenge "challenges/web/blind"
 *   challenges/<category>/<name>/files/…  → challenge ".../<name>"
 *
 * root: '' for whole-repo discovery (auto mode), or a pinned path.
 * exclude: names that disqualify a candidate when they appear as ANY path
 * segment (so writeups/ anywhere is skipped).
 */
export function groupChallenges(
    root: string,
    files: RawFile[],
    revision: string,
    exclude: string[] = [],
): ChallengeRef[] {
    const rootPrefix = root ? `${root.replace(/^\/+|\/+$/g, "")}/` : "";
    const excl = new Set(exclude.map((e) => e.trim()).filter((e) => e !== ""));

    // ---- index the tree -------------------------------------------------------
    const directFiles = new Map<string, string[]>(); // dir -> direct file paths
    const parentOf = new Map<string, string>(); // dir -> parent dir ('' for root-level)
    const allDirs = new Set<string>();

    const dirOf = (p: string): string => {
        const i = p.lastIndexOf("/");
        return i === -1 ? "" : p.slice(0, i);
    };

    for (const f of files) {
        if (rootPrefix && !f.path.startsWith(rootPrefix)) continue;
        const rel = rootPrefix ? f.path.slice(rootPrefix.length) : f.path;
        if (!rel) continue;
        const segs = rel.split("/");
        // record every ancestor dir
        for (let i = 1; i < segs.length; i++) {
            const d = segs.slice(0, i).join("/");
            allDirs.add(d);
            if (i === 1) parentOf.set(d, "");
            else parentOf.set(d, segs.slice(0, i - 1).join("/"));
        }
        const d = dirOf(rel);
        const list = directFiles.get(d) ?? [];
        list.push(rel);
        directFiles.set(d, list);
    }

    const hasDirectReadme = (d: string): boolean =>
        (directFiles.get(d) ?? []).some((p) => p.toLowerCase() === "readme.md");

    // Does any dir strictly beneath d directly contain a README.md?
    const hasDescendantReadme = (d: string): boolean => {
        const prefix = d === "" ? "" : `${d}/`;
        for (const other of allDirs) {
            if (other === d) continue;
            if (d !== "" && !other.startsWith(prefix)) continue;
            if (hasDirectReadme(other)) return true;
        }
        return false;
    };

    // ---- candidates ----------------------------------------------------------
    const candidates: string[] = [];
    for (const d of allDirs) {
        if (!directFiles.has(d)) continue; // categories: no direct files
        if (hasDirectReadme(d) || !hasDescendantReadme(d)) candidates.push(d);
    }
    // outermost wins: drop candidates that are descendants of other candidates
    const isDescendantOfCandidate = (d: string): boolean => {
        let p = parentOf.get(d);
        while (p !== undefined) {
            if (candidates.includes(p)) return true;
            p = parentOf.get(p ?? "");
        }
        return false;
    };
    const kept = candidates.filter((d) => !isDescendantOfCandidate(d));

    // ---- filter + build refs -------------------------------------------------
    const refs: ChallengeRef[] = [];
    for (const d of kept) {
        const segs = d === "" ? [] : d.split("/");
        if (segs.some((s) => s.startsWith("."))) continue;
        if (segs.some((s) => excl.has(s))) continue;
        const prefix = `${d}/`;
        const cfiles: ChallengeFile[] = [];
        for (const f of files) {
            if (rootPrefix && !f.path.startsWith(rootPrefix)) continue;
            const rel = rootPrefix ? f.path.slice(rootPrefix.length) : f.path;
            if (!rel.startsWith(prefix)) continue;
            cfiles.push({
                path: f.path,
                name: rel.slice(prefix.length),
                size: f.size,
                mode: f.mode,
                sha: f.sha,
            });
        }
        if (cfiles.length === 0) continue;
        cfiles.sort((a, b) => a.name.localeCompare(b.name));
        refs.push({
            name: d, // path relative to root, e.g. "web/blind" — display uses basename
            path: rootPrefix + d,
            commitSha: revision,
            files: cfiles,
        });
    }
    refs.sort((a, b) => a.path.localeCompare(b.path));
    return refs;
}

/** Normalize a SOLVED.txt line for matching (case/space insensitive). */
function normSolvedLine(s: string): string {
    return s.trim().toLowerCase().replace(/^\.\//, "").replace(/\/+$/, "");
}

/** The candidate identifiers a challenge can be marked solved by. */
function solvedKeys(ref: { path: string; name: string }): string[] {
    const keys = new Set<string>();
    const push = (v: string) => {
        const n = normSolvedLine(v);
        if (n) keys.add(n);
    };
    push(ref.path); // challenges/web/blind
    push(ref.name); // web/blind (auto) or full rel path (pinned)
    push(ref.path.replace(/^challenges\//, "")); // web/blind from full path
    const base = ref.path.split("/").pop() ?? "";
    push(base); // blind
    return [...keys];
}

/** Does a challenge match any SOLVED.txt line? Lines may be a full path, a
 * category-qualified name, or just the challenge basename. */
export function isMarkedSolved(
    ref: { path: string; name: string },
    solvedLines: string[],
): boolean {
    if (solvedLines.length === 0) return false;
    const keys = solvedKeys(ref);
    for (const raw of solvedLines) {
        const line = normSolvedLine(raw);
        if (!line || line.startsWith("#")) continue;
        if (keys.includes(line)) return true;
        // also allow "web/blind" style to match a pinned-root challenge name
        if (
            keys.some(
                (k) =>
                    k === line ||
                    k.endsWith(`/${line}`) ||
                    line.endsWith(`/${k}`),
            )
        )
            return true;
    }
    return false;
}

/** Parse SOLVED.txt content: one entry per line, '#' starts a comment. */
export function parseSolvedFile(content: string): string[] {
    return content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("#"));
}
