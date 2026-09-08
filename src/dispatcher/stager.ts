/**
 * Stager: downloads a challenge's files into an immutable per-job workspace.
 *
 * Layout:  <jobsDir>/<challenge>-<shortSha>/            <- agent workspace (persistent)
 *          ├─ task.txt            solving instructions
 *          ├─ AGENTS.md           workspace rules (loaded by pi automatically)
 *          ├─ SOLUTION.md         written by the agent on success
 *          └─ files/              the challenge files (untouched)
 *
 * Re-staging is idempotent; the canonical repo is never used as the workspace.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChallengeSource } from '../sources/source.js';
import type { ChallengeRef } from '../types.js';
import { log } from '../log.js';

export const STAGE_MANIFEST = 'staged-manifest.json';

export interface StagedChallenge {
    workspace: string;
    /** Files staged (relative to workspace). */
    files: string[];
}

export function workspaceFor(jobsDir: string, ref: ChallengeRef): string {
    const shortSha = ref.commitSha.replace(/^sha256:/, '').slice(0, 8);
    return path.join(jobsDir, `${sanitize(ref.name)}-${shortSha}`);
}

function sanitize(name: string): string {
    return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'challenge';
}

/** Safe join that refuses path traversal outside dest. */
function safeJoin(dest: string, rel: string): string {
    const abs = path.resolve(dest, rel);
    if (!abs.startsWith(path.resolve(dest) + path.sep) && abs !== path.resolve(dest)) {
        throw new Error(`path traversal refused: ${rel}`);
    }
    return abs;
}

export async function stageChallenge(
    src: ChallengeSource,
    ref: ChallengeRef,
    jobsDir: string,
): Promise<StagedChallenge> {
    const workspace = workspaceFor(jobsDir, ref);
    fs.mkdirSync(workspace, { recursive: true });

    const staged: string[] = [];
    for (const f of ref.files) {
        const dest = safeJoin(workspace, f.name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const bytes = await src.downloadFile(f.path);
        fs.writeFileSync(dest, bytes);
        if (f.mode === '100755') {
            fs.chmodSync(dest, 0o755);
        }
        staged.push(f.name);
    }

    fs.writeFileSync(path.join(workspace, STAGE_MANIFEST), JSON.stringify({
        challenge: ref.name,
        path: ref.path,
        source: src.id,
        commitSha: ref.commitSha,
        stagedAt: new Date().toISOString(),
        files: staged,
    }, null, 2));

    log.info('stager', `staged ${ref.name}@${ref.commitSha.slice(0, 8)} -> ${workspace} (${staged.length} files)`);
    return { workspace, files: staged };
}
