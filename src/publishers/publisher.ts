/**
 * Publisher abstraction: output channels are independent of the core dispatcher.
 * A publisher failure must never interrupt challenge processing.
 */

import * as crypto from 'node:crypto';

export interface Publisher {
    readonly name: string;
    /** Send one message. Returns true if actually delivered (false = deduped/skipped). */
    publish(text: string): Promise<boolean>;
    ready(): Promise<boolean>;
}

/** Dedupe helper shared by publishers. */
export function contentHash(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
}

/** Truncate to Discord's message limit with a visible ellipsis. */
export function clampDiscord(text: string, max = 1900): string {
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + '…';
}
