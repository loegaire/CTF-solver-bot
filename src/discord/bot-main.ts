/**
 * Bot entrypoint: run the Discord /status bot standalone.
 *
 *   DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... DB_PATH=... node dist/discord/bot-main.js
 *
 * Also runs alongside the dispatcher when DISCORD_BOT_ENABLED=true is set in
 * the dispatcher environment (see src/index.ts).
 */

import { DiscordBot } from './bot.js';
import { log } from '../log.js';
import * as path from 'node:path';

function env(name: string, required: boolean): string | undefined {
    const v = process.env[name] ?? '';
    if (!v) {
        if (required) {
            console.error(`missing required env: ${name}`);
            process.exit(1);
        }
        return undefined;
    }
    return v;
}

const token = env('DISCORD_BOT_TOKEN', true)!;
const applicationId = env('DISCORD_APPLICATION_ID', true)!;
const dbPath = env('DB_PATH', false) ?? path.resolve('data/ctf-worker.db');

const bot = new DiscordBot({ token, applicationId, dbPath });

process.on('SIGINT', () => {
    log.info('bot-main', 'SIGINT — stopping');
    bot.stop();
    process.exit(0);
});
process.on('SIGTERM', () => {
    log.info('bot-main', 'SIGTERM — stopping');
    bot.stop();
    process.exit(0);
});

bot.start().catch((e) => {
    log.error('bot-main', `fatal: ${(e as Error).stack}`);
    process.exit(1);
});
