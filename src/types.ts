/**
 * Shared domain types.
 */

/** A file inside a challenge, as listed by a source at a specific revision. */
export interface ChallengeFile {
    /** Path relative to the source root (e.g. "challenges/neon/files/data.bin"), POSIX separators. */
    path: string;
    /** Path relative to the challenge root (e.g. "files/data.bin"). */
    name: string;
    size: number;
    /** Git-style file mode: "100644" | "100755" | "" when unknown. */
    mode: string;
    /** Content hash (git blob SHA for GitHub, content sha256 for local). Used to detect real changes. */
    sha?: string;
}

/** A challenge at a specific revision of a source. Identity = source + path + commitSha. */
export interface ChallengeRef {
    /** Top-level challenge directory name (e.g. "neon"). */
    name: string;
    /** Full path of the challenge directory in the source (e.g. "challenges/neon"). */
    path: string;
    /** Commit SHA (or content-manifest hash for non-git sources). */
    commitSha: string;
    files: ChallengeFile[];
}

/** Raw file listing entry as produced by a source before challenge grouping. */
export interface RawFile {
    /** Path relative to the source root, POSIX separators. */
    path: string;
    size: number;
    /** Git-style mode, "" when unknown. */
    mode: string;
    /** Content hash (git blob SHA for GitHub, content sha256 for local). */
    sha?: string;
}
