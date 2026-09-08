/**
 * Webhook server: receives GitHub push webhooks and immediately triggers a poll.
 * It holds no state; the poller is authoritative, so a missed/failed webhook
 * merely delays discovery until the next scheduled poll.
 *
 * HMAC signature verification (X-Hub-Signature-256) when WEBHOOK_SECRET is set.
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { log } from '../log.js';

export interface WebhookServerOptions {
    host: string;
    port: number;
    secret: string;
    /** Only accept pushes for this repo ("owner/name"); empty = accept all. */
    repoFilter: string;
    /** Only accept pushes for this branch; empty = accept all. */
    branchFilter: string;
    onPush: (repo: string, branch: string) => void;
}

export class WebhookServer {
    private server: http.Server | null = null;
    private opts: WebhookServerOptions;

    constructor(opts: WebhookServerOptions) {
        this.opts = opts;
    }

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => {
                if (req.method !== 'POST' || !(req.url ?? '').startsWith('/webhook')) {
                    res.writeHead(404).end();
                    return;
                }
                const chunks: Buffer[] = [];
                req.on('data', (c: Buffer) => chunks.push(c));
                req.on('end', () => {
                    const body = Buffer.concat(chunks);
                    try {
                        if (this.opts.secret) {
                            const sig = req.headers['x-hub-signature-256'] as string | undefined;
                            if (!sig || !verifySignature(body, sig, this.opts.secret)) {
                                log.warn('webhook', 'rejected: invalid signature');
                                res.writeHead(403).end();
                                return;
                            }
                        }
                        const event = JSON.parse(body.toString('utf8')) as {
                            repository?: { full_name?: string };
                            ref?: string;
                        };
                        const repo = event.repository?.full_name ?? '';
                        const branch = (event.ref ?? '').replace(/^refs\/heads\//, '');
                        const repoOk = !this.opts.repoFilter || repo === this.opts.repoFilter;
                        const branchOk = !this.opts.branchFilter || branch === this.opts.branchFilter;
                        if (!repoOk || !branchOk) {
                            log.info(
                                'webhook',
                                `ignoring push for ${repo}@${branch} (watching ${this.opts.repoFilter || '*'}@${this.opts.branchFilter || '*'})`,
                            );
                            res.writeHead(200).end('ok');
                            return;
                        }
                        log.info('webhook', `push event repo=${repo} branch=${branch}`);
                        this.opts.onPush(repo, branch);
                        res.writeHead(200).end('ok');
                    } catch (e) {
                        log.warn('webhook', `bad payload: ${(e as Error).message}`);
                        res.writeHead(400).end();
                    }
                });
            });
            server.on('error', reject);
            server.listen(this.opts.port, this.opts.host, () => {
                this.server = server;
                log.info('webhook', `listening on ${this.opts.host}:${this.opts.port}`);
                resolve();
            });
        });
    }

    stop(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.server) return resolve();
            this.server.close(() => resolve());
        });
    }
}

function verifySignature(body: Buffer, signature: string, secret: string): boolean {
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
