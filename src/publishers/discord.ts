/**
 * Discord webhook publisher. Fire-and-forget: failures are logged and swallowed.
 * Message-level dedupe is handled by the dispatcher (messages table) before it
 * even reaches this class, so publish() here is unconditional.
 */

import { clampDiscord } from './publisher.js';
import type { Publisher } from './publisher.js';
import { log } from '../log.js';

export class DiscordPublisher implements Publisher {
    readonly name = 'discord';
    private url: string;

    constructor(url: string) {
        this.url = url;
    }

    ready(): Promise<boolean> {
        return Promise.resolve(this.url !== '');
    }

    async publish(text: string): Promise<boolean> {
        if (!this.url) return false;
        try {
            const res = await fetch(this.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: clampDiscord(text, 2000 - 4) }),
            });
            if (!res.ok) {
                log.warn('discord', `webhook returned ${res.status}; message dropped`);
                return false;
            }
            return true;
        } catch (e) {
            log.warn('discord', `webhook request failed: ${(e as Error).message}`);
            return false;
        }
    }
}

/** Publisher that only logs — used when no webhook URL is configured. */
export class LogPublisher implements Publisher {
    readonly name = 'log';

    ready(): Promise<boolean> {
        return Promise.resolve(true);
    }

    async publish(text: string): Promise<boolean> {
        log.info('publish', text);
        return true;
    }
}
