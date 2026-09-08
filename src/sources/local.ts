/**
 * Local directory source: for testing and self-hosted "drive" style sources.
 * The revision is a content manifest hash, so content changes create new jobs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { ChallengeSource } from './source.js';
import type { RawFile } from '../types.js';

export class LocalSource implements ChallengeSource {
    private dir: string;
    private prefix: string;

    constructor(dir: string, prefix: string) {
        this.dir = path.resolve(dir);
        this.prefix = prefix.replace(/^\/+|\/+$/g, '');
    }

    get id(): string {
        return `local:${this.dir}`;
    }

    private walk(rel: string, out: RawFile[]): void {
        const abs = path.join(this.dir, rel);
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(abs, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            const childRel = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
                this.walk(childRel, out);
            } else if (e.isFile()) {
                let size = 0;
                let mode = '100644';
                let sha = '';
                try {
                    const st = fs.statSync(path.join(this.dir, childRel));
                    size = st.size;
                    mode = (st.mode & 0o111) !== 0 ? '100755' : '100644';
                    sha = 'sha256:' + crypto
                        .createHash('sha256')
                        .update(fs.readFileSync(path.join(this.dir, childRel)))
                        .digest('hex')
                        .slice(0, 20);
                } catch {
                    /* ignore */
                }
                out.push({ path: childRel, size, mode, sha });
            }
        }
    }

    async listFiles(): Promise<RawFile[]> {
        const out: RawFile[] = [];
        this.walk('', out);
        out.sort((a, b) => a.path.localeCompare(b.path));
        return out;
    }

    async currentRevision(): Promise<string> {
        // Content-addressed revision: any content change (even same size) creates
        // a new revision and thus a new job identity.
        const files = await this.listFiles();
        const h = crypto.createHash('sha256');
        for (const f of files) {
            let contentHash = '';
            try {
                contentHash = crypto
                    .createHash('sha256')
                    .update(fs.readFileSync(path.join(this.dir, f.path)))
                    .digest('hex')
                    .slice(0, 16);
            } catch {
                contentHash = 'unreadable';
            }
            h.update(`${f.mode} ${f.path} ${f.size} ${contentHash}\n`);
        }
        return `sha256:${h.digest('hex').slice(0, 16)}`;
    }

    async downloadFile(rel: string): Promise<Buffer> {
        const abs = path.join(this.dir, rel);
        if (!abs.startsWith(this.dir)) throw new Error(`path escapes source dir: ${rel}`);
        return fs.promises.readFile(abs);
    }
}
