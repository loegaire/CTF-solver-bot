/**
 * Discord bot: one command, /status — raw dump of the dispatcher SQLite database.
 *
 * Plain REST + gateway websocket client (no discord.js dependency).
 * - Global /status slash command.
 * - Small dumps reply inline in code fences; big dumps attach a .txt file.
 * - The bot only reads the DB (read-only handle); it never writes state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import WebSocket from "ws";
import Database from "better-sqlite3";
import { renderDbDump, planReply } from "./status-dump.js";
import { log } from "../log.js";

const API = "https://discord.com/api/v10";

/** Intents: GUILDS only — slash commands don't require message intent. */
// GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS — reactions power the
// job-control panels (✅ done).
const INTENTS = (1 << 0) | (1 << 9) | (1 << 10);

export interface DiscordBotOptions {
    token: string;
    applicationId: string;
    /** Dispatcher database to dump. */
    dbPath: string;
    /** Explicit announce channel id; empty = auto-detect after READY. */
    announceChannelId?: string;
    logTag?: string;
}

interface Interaction {
    id: string;
    token: string;
    /** Channel the interaction was invoked in. */
    channel_id?: string;
    /** Guild the interaction was invoked in (absent in DMs). */
    guild_id?: string;
    data?: { name?: string };
}

export class DiscordBot {
    private opts: DiscordBotOptions;
    private ws: WebSocket | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private sequence: number | null = null;
    private sessionId: string | null = null;
    private resumeUrl: string | null = null;
    private stopped = false;
    private tag: string;
    /** Resolved channel id for SOLVED announcements. Never rely on a
     * server having a "#solved" channel: preference order is explicit
     * config → the channel where /status was last invoked → our own
     * #ctf-solves channel (created on demand) → fallback text channel. */
    announceChannelId: string | null = null;
    /** Channel where /status was last invoked (persisted across restarts). */
    private lastStatusChannelId: string | null = null;
    /** Sidecar file persisting announce state next to the DB. */
    private stateFile: string;
    private pendingAnnouncements: string[] = [];
    private announceReady: Promise<void> | null = null;

    constructor(opts: DiscordBotOptions) {
        this.opts = opts;
        this.tag = opts.logTag ?? "discord-bot";
        this.stateFile = path.join(
            path.dirname(path.resolve(opts.dbPath)),
            "announce-state.json",
        );
        this.loadAnnounceState();
        if (opts.announceChannelId) {
            this.announceChannelId = opts.announceChannelId; // explicit config wins
        } else if (this.lastStatusChannelId) {
            // Announce where /status was last called (persisted from a previous run).
            this.announceChannelId = this.lastStatusChannelId;
        }
    }

    private loadAnnounceState(): void {
        try {
            const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as {
                lastStatusChannelId?: string;
            };
            if (raw.lastStatusChannelId)
                this.lastStatusChannelId = raw.lastStatusChannelId;
        } catch {
            /* no state yet */
        }
    }

    private saveAnnounceState(): void {
        try {
            fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
            fs.writeFileSync(
                this.stateFile,
                JSON.stringify(
                    { lastStatusChannelId: this.lastStatusChannelId },
                    null,
                    2,
                ),
            );
        } catch {
            /* best effort */
        }
    }

    /** Remember the channel where /status was invoked; announcements follow it. */
    private rememberStatusChannel(channelId: string): void {
        this.lastStatusChannelId = channelId;
        if (!this.opts.announceChannelId) {
            this.announceChannelId = channelId;
        }
        this.saveAnnounceState();
    }

    // ---------------------------------------------------------------- REST

    /**
     * Global pacer for message-mutating requests (panel PATCHes dominate):
     * Discord allows ~5 per 5s per channel. Instead of relying only on
     * reactive Retry-After (which races when many panels sync at once),
     * serialize mutations through a queue with minimum spacing.
     */
    private mutationQueue: Array<() => Promise<void>> = [];
    private mutationDraining = false;
    private lastMutationAt = 0;
    private readonly MUTATION_SPACING_MS = 1_200;

    private runMutating<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.mutationQueue.push(async () => {
                try {
                    resolve(await fn());
                } catch (e) {
                    reject(e);
                }
            });
            void this.drainMutations();
        });
    }

    private async drainMutations(): Promise<void> {
        if (this.mutationDraining) return;
        this.mutationDraining = true;
        try {
            while (this.mutationQueue.length > 0) {
                const wait =
                    this.lastMutationAt + this.MUTATION_SPACING_MS - Date.now();
                if (wait > 0) await new Promise((r) => setTimeout(r, wait));
                const job = this.mutationQueue.shift();
                if (!job) break;
                this.lastMutationAt = Date.now();
                await job();
            }
        } finally {
            this.mutationDraining = false;
        }
    }

    private rest(
        method: string,
        urlPath: string,
        body?: unknown,
        retry429 = true,
    ): Promise<{ status: number; json: any }> {
        return new Promise((resolve, reject) => {
            const payload =
                body === undefined ? undefined : JSON.stringify(body);
            const req = https.request(
                `${API}${urlPath}`,
                {
                    method,
                    headers: {
                        Authorization: `Bot ${this.opts.token}`,
                        ...(payload
                            ? {
                                  "Content-Type": "application/json",
                                  "Content-Length":
                                      Buffer.byteLength(payload).toString(),
                              }
                            : {}),
                    },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (c: Buffer) => chunks.push(c));
                    res.on("end", () => {
                        const text = Buffer.concat(chunks).toString("utf8");
                        let json: any = null;
                        try {
                            json = text ? JSON.parse(text) : null;
                        } catch {
                            json = { raw: text };
                        }
                        if (res.statusCode === 429 && retry429) {
                            // Discord rate limit: wait per Retry-After (ms or s), then retry once.
                            const ra = res.headers["retry-after"];
                            const delayMs = ra
                                ? String(ra).includes(".")
                                    ? parseFloat(String(ra)) * 1000
                                    : Number(ra) *
                                      (String(ra).length > 4 ? 1 : 1000)
                                : 2000;
                            setTimeout(
                                () => {
                                    this.rest(
                                        method,
                                        urlPath,
                                        body,
                                        false,
                                    ).then(resolve, reject);
                                },
                                Math.min(delayMs, 15_000),
                            );
                            return;
                        }
                        resolve({ status: res.statusCode ?? 0, json });
                    });
                },
            );
            req.on("error", reject);
            if (payload) req.write(payload);
            req.end();
        });
    }

    private restBuffer(
        method: string,
        urlPath: string,
        body: Buffer,
        contentType: string,
    ): Promise<{ status: number }> {
        return new Promise((resolve, reject) => {
            const req = https.request(
                `${API}${urlPath}`,
                {
                    method,
                    headers: {
                        Authorization: `Bot ${this.opts.token}`,
                        "Content-Type": contentType,
                        "Content-Length": body.length.toString(),
                    },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (c: Buffer) => chunks.push(c));
                    res.on("end", () =>
                        resolve({ status: res.statusCode ?? 0 }),
                    );
                },
            );
            req.on("error", reject);
            req.write(body);
            req.end();
        });
    }

    /** Multipart request with a JSON payload + one text file attachment.
     * Used by the job panels to attach the whole WRITEUP.md to a message. */
    private restMultipart(
        method: string,
        urlPath: string,
        payload: Record<string, unknown>,
        fileName: string,
        fileData: string,
        retry429 = true,
    ): Promise<{ status: number; json: any }> {
        return new Promise((resolve, reject) => {
            const boundary = `----ctfworker${Date.now()}`;
            const jsonPart = JSON.stringify(payload);
            const parts: Buffer[] = [];
            parts.push(
                Buffer.from(
                    `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${jsonPart}\r\n`,
                ),
            );
            parts.push(
                Buffer.from(
                    `--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${fileName}"\r\nContent-Type: text/markdown\r\n\r\n`,
                ),
            );
            parts.push(Buffer.from(fileData, "utf8"));
            parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
            const body = Buffer.concat(parts);
            const req = https.request(
                `${API}${urlPath}`,
                {
                    method,
                    headers: {
                        Authorization: `Bot ${this.opts.token}`,
                        "Content-Type": `multipart/form-data; boundary=${boundary}`,
                        "Content-Length": body.length.toString(),
                    },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (c: Buffer) => chunks.push(c));
                    res.on("end", () => {
                        // Rate limit: wait per Retry-After, then retry once.
                        if (res.statusCode === 429 && retry429) {
                            const ra = res.headers["retry-after"];
                            const delayMs = ra
                                ? String(ra).includes(".")
                                    ? parseFloat(String(ra)) * 1000
                                    : Number(ra) *
                                      (String(ra).length > 4 ? 1 : 1000)
                                : 2000;
                            setTimeout(
                                () => {
                                    this.restMultipart(
                                        method,
                                        urlPath,
                                        payload,
                                        fileName,
                                        fileData,
                                        false,
                                    ).then(resolve, reject);
                                },
                                Math.min(delayMs, 15_000),
                            );
                            return;
                        }
                        const text = Buffer.concat(chunks).toString("utf8");
                        let json: any = null;
                        try {
                            json = text ? JSON.parse(text) : null;
                        } catch {
                            json = { raw: text };
                        }
                        resolve({ status: res.statusCode ?? 0, json });
                    });
                },
            );
            req.on("error", reject);
            req.write(body);
            req.end();
        });
    }

    // ------------------------------------------------ command registration

    async registerCommands(): Promise<void> {
        const commands = [
            {
                name: "status",
                description:
                    "Dump the CTF dispatcher database (challenges, jobs, messages)",
            },
        ];
        const res = await this.rest(
            "PUT",
            `/applications/${this.opts.applicationId}/commands`,
            commands,
        );
        if (res.status !== 200) {
            throw new Error(
                `command registration failed (${res.status}): ${JSON.stringify(res.json)}`,
            );
        }
        log.info(
            this.tag,
            `registered global commands: ${(res.json as any[]).map((c) => "/" + c.name).join(", ")}`,
        );
    }

    // ---------------------------------------------------------------- gateway

    async start(): Promise<void> {
        this.stopped = false;
        await this.registerCommands();

        while (!this.stopped) {
            try {
                await this.gatewaySession();
            } catch (e) {
                log.warn(this.tag, `gateway error: ${(e as Error).message}`);
            }
            if (this.stopped) break;
            await new Promise((r) =>
                setTimeout(r, 3000 + Math.floor(Math.random() * 2000)),
            );
        }
        log.info(this.tag, "stopped");
    }

    /** Called with the jobId when a user reacts DONE on a panel message. */
    onDoneReaction: ((jobId: number) => void) | null = null;

    stop(): void {
        this.stopped = true;
        try {
            this.ws?.close(1000);
        } catch {
            /* ignore */
        }
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    }

    private async gatewaySession(): Promise<void> {
        const gw = await this.rest("GET", "/gateway/bot");
        if (gw.status !== 200)
            throw new Error(`gateway/bot failed: ${gw.status}`);
        const url: string =
            (this.resumeUrl ?? gw.json.url) + "?v=10&encoding=json";
        log.info(
            this.tag,
            this.sessionId
                ? `resuming gateway session`
                : `connecting to gateway`,
        );

        return new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(url);
            this.ws = ws;

            ws.on("error", (err) => {
                log.warn(this.tag, `websocket error: ${err.message}`);
                reject(err);
            });
            ws.on("close", (code) => {
                if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = null;
                log.info(this.tag, `gateway closed (${code})`);
                resolve(); // outer loop reconnects/resumes
            });
            ws.on("message", (data: WebSocket.RawData) => {
                let msg: any;
                try {
                    msg = JSON.parse(data.toString("utf8"));
                } catch {
                    return;
                }
                this.handleGateway(msg, ws).catch((e) =>
                    log.warn(
                        this.tag,
                        `handler error: ${(e as Error).message}`,
                    ),
                );
            });
        });
    }

    private send(ws: WebSocket, op: number, d: unknown): void {
        ws.send(JSON.stringify({ op, d }));
    }

    private identify(ws: WebSocket): void {
        this.send(ws, 2, {
            token: this.opts.token,
            intents: INTENTS,
            properties: {
                os: "linux",
                browser: "ctf-worker",
                device: "ctf-worker",
            },
        });
    }

    private async handleGateway(msg: any, ws: WebSocket): Promise<void> {
        if (typeof msg.s === "number") this.sequence = msg.s;

        switch (msg.op) {
            case 10: {
                const interval: number = msg.d.heartbeat_interval;
                this.heartbeatTimer = setInterval(() => {
                    this.send(ws, 1, this.sequence);
                }, interval);
                if (this.sessionId && this.sequence !== null) {
                    this.send(ws, 6, {
                        token: this.opts.token,
                        session_id: this.sessionId,
                        seq: this.sequence,
                    });
                } else {
                    this.identify(ws);
                }
                break;
            }
            case 7:
                log.info(this.tag, "gateway requested reconnect");
                ws.close(4000);
                break;
            case 9:
                log.warn(this.tag, "invalid session — re-identifying");
                this.sessionId = null;
                this.resumeUrl = null;
                this.sequence = null;
                setTimeout(() => this.identify(ws), 5000);
                break;
            case 11:
                break;
            case 0:
                switch (msg.t) {
                    case "READY": {
                        this.sessionId = msg.d.session_id;
                        this.resumeUrl = msg.d.resume_url;
                        const user = msg.d.user;
                        log.info(
                            this.tag,
                            `logged in as ${user.username}#${user.discriminator ?? ""} — /status live`,
                        );
                        // Resolve the announce channel once (after login, not per message).
                        this.announceReady ??= this.resolveAnnounceChannel()
                            .then(async () => {
                                // Panels channel depends on guild context resolved
                                // above; chain it here, not at READY time.
                                await this.resolvePanelsChannel().catch(
                                    () => {},
                                );
                                this.channelsReady = true;
                                // Flush anything queued before we were ready.
                                const queued =
                                    this.pendingAnnouncements.splice(0);
                                for (const text of queued)
                                    await this.postAnnouncement(text);
                            })
                            .catch((e) =>
                                log.warn(
                                    this.tag,
                                    `announce channel resolve failed: ${(e as Error).message}`,
                                ),
                            );
                        break;
                    }
                    case "RESUMED":
                        log.info(this.tag, "session resumed");
                        break;
                    case "MESSAGE_REACTION_ADD": {
                        const d = msg.d as {
                            message_id: string;
                            emoji?: { name?: string };
                            user_id: string;
                        };
                        if (
                            d?.emoji?.name === "✅" &&
                            d.user_id !== this.opts.applicationId &&
                            this.panelJobForMessage
                        ) {
                            const jobId = this.panelJobForMessage(d.message_id);
                            if (jobId !== null) {
                                log.info(
                                    this.tag,
                                    `done reaction on panel message -> job #${jobId}`,
                                );
                                this.onDoneReaction?.(jobId);
                            }
                        }
                        break;
                    }
                    case "INTERACTION_CREATE":
                        void this.onInteraction(msg.d).catch((e) =>
                            log.error(
                                this.tag,
                                `interaction error: ${(e as Error).stack}`,
                            ),
                        );
                        break;
                }
                break;
        }
    }

    // ------------------------------------------------------------ announcements

    /**
     * Resolve the announce channel. No "#solved" channel is assumed to exist.
     * Preference order:
     *   1. explicit DISCORD_ANNOUNCE_CHANNEL_ID (constructor — skips this)
     *   2. the channel where /status was last invoked (this session or a
     *      previous one, persisted in announce-state.json)
     *   3. our own #ctf-solves channel, created if missing
     *   4. any visible text channel (last resort)
     */
    /** Registry lookup hook: resolves a panel message id -> job id. */
    panelJobForMessage: ((messageId: string) => number | null) | null = null;

    /** Channel for job panels: prefers #ctf-panels (auto-created), else the
     * announce channel. Panels are high-volume; separating them keeps the
     * solved-announcement channel readable. */
    panelsChannelId: string | null = null;

    /** True once announce+panels channels are resolved (post-READY chain).
     * The dispatcher waits on this before attaching the PanelManager, so
     * panels never post to a wrong/fallback channel on a fresh start. */
    channelsReady = false;

    /** Resolve (and create if missing) the #ctf-panels channel. */
    async resolvePanelsChannel(): Promise<void> {
        if (this.panelsChannelId) return;
        if (!this.announceChannelId) return;
        const res = await this.rest("GET", "/users/@me/guilds");
        if (
            res.status !== 200 ||
            !Array.isArray(res.json) ||
            res.json.length === 0
        )
            return;
        const guildId: string = res.json[0].id;
        const chRes = await this.rest("GET", `/guilds/${guildId}/channels`);
        if (chRes.status !== 200 || !Array.isArray(chRes.json)) return;
        const textChannels = chRes.json.filter((c: any) => c.type === 0);
        let ch = textChannels.find((c: any) => c.name === "ctf-panels");
        if (!ch) {
            const created = await this.rest(
                "POST",
                `/guilds/${guildId}/channels`,
                {
                    name: "ctf-panels",
                    type: 0,
                    topic: "CTF worker job panels — one message per challenge; react ✅ to stop a job",
                },
            );
            if (created.status === 200 || created.status === 201)
                ch = created.json;
        }
        if (ch) {
            this.panelsChannelId = ch.id;
            log.info(this.tag, `panels channel: #${ch.name} (${ch.id})`);
        }
    }

    private async resolveAnnounceChannel(): Promise<void> {
        if (this.announceChannelId) {
            log.info(
                this.tag,
                `announce channel: ${this.announceChannelId} (from /status or config)`,
            );
            return;
        }
        const res = await this.rest("GET", "/users/@me/guilds");
        if (
            res.status !== 200 ||
            !Array.isArray(res.json) ||
            res.json.length === 0
        ) {
            log.warn(
                this.tag,
                "no guilds visible; announcements disabled until a channel is found",
            );
            return;
        }
        const guildId: string = res.json[0].id;
        const chRes = await this.rest("GET", `/guilds/${guildId}/channels`);
        if (chRes.status !== 200 || !Array.isArray(chRes.json)) {
            log.warn(
                this.tag,
                `channel list failed (${chRes.status}); announcements disabled`,
            );
            return;
        }
        const textChannels = chRes.json.filter((c: any) => c.type === 0); // GUILD_TEXT
        if (textChannels.length === 0) {
            log.warn(
                this.tag,
                "no text channels visible; announcements disabled",
            );
            return;
        }

        // 3. Our own channel: reuse #ctf-solves if it exists, else create it.
        let own = textChannels.find((c: any) => c.name === "ctf-solves");
        if (!own) {
            const created = await this.rest(
                "POST",
                `/guilds/${guildId}/channels`,
                {
                    name: "ctf-solves",
                    type: 0,
                    topic: "CTF dispatcher announcements — every solved challenge is posted here",
                },
            );
            if (created.status === 200 || created.status === 201) {
                own = created.json;
                log.info(
                    this.tag,
                    `created announce channel #ctf-solves (${own.id})`,
                );
            }
        }
        this.announceChannelId = own?.id ?? textChannels[0].id;
        log.info(
            this.tag,
            `announce channel: ${own ? `#${own.name}` : "first text channel"} (${this.announceChannelId})`,
        );
    }

    /**
     * Post a SOLVED announcement tagging @everyone. Public API for the
     * dispatcher. Queues until the gateway session is READY.
     */
    // ------------------------------------------------------------ job panels

    /** Post a new job control message (text + optional whole-writeup file);
     * returns the Discord message id. Carries the ✅ reaction. */
    async postPanel(
        channelId: string,
        content: string,
        file: { name: string; data: string } | null = null,
    ): Promise<string | null> {
        const res = await this.runMutating(() =>
            file === null
                ? this.rest("POST", `/channels/${channelId}/messages`, {
                      content,
                  })
                : this.restMultipart(
                      "POST",
                      `/channels/${channelId}/messages`,
                      { content },
                      file.name,
                      file.data,
                  ),
        );
        if (res.status >= 300) {
            log.warn(
                this.tag,
                `postPanel failed (${res.status}): ${JSON.stringify(res.json).slice(0, 200)}`,
            );
            return null;
        }
        const messageId: string | undefined = res.json?.id;
        if (!messageId) return null;
        // add the ✅ reaction so users can one-click
        await this.rest(
            "PUT",
            `/channels/${channelId}/messages/${messageId}/reactions/%E2%9C%85/@me`,
        );
        return messageId;
    }

    /** Update an existing control message (text + optional file swap).
     * Keeps the reaction. */
    async updatePanel(
        channelId: string,
        messageId: string,
        content: string,
        file: { name: string; data: string } | null = null,
    ): Promise<void> {
        const res = await this.runMutating(() =>
            file === null
                ? this.rest(
                      "PATCH",
                      `/channels/${channelId}/messages/${messageId}`,
                      { content },
                  )
                : this.restMultipart(
                      "PATCH",
                      `/channels/${channelId}/messages/${messageId}`,
                      { content },
                      file.name,
                      file.data,
                  ),
        );
        if (res.status >= 300) {
            log.warn(this.tag, `updatePanel failed (${res.status})`);
        }
    }

    async announce(text: string): Promise<void> {
        if (this.stopped) return;
        if (!this.announceReady) {
            // Bot not logged in yet: queue so early solves are not lost.
            this.pendingAnnouncements.push(text);
            return;
        }
        await this.announceReady;
        if (!this.announceChannelId) {
            log.warn(this.tag, "no announce channel; dropping announcement");
            return;
        }
        await this.postAnnouncement(text);
    }

    private async postAnnouncement(text: string): Promise<void> {
        if (!this.announceChannelId) return;
        // allowed_mentions makes the @everyone tag actually ping.
        const res = await this.rest(
            "POST",
            `/channels/${this.announceChannelId}/messages`,
            {
                content: text,
                allowed_mentions: { parse: ["everyone"] },
            },
        );
        if (res.status >= 300) {
            log.warn(
                this.tag,
                `announcement failed (${res.status}): ${JSON.stringify(res.json).slice(0, 300)}`,
            );
        } else {
            log.info(
                this.tag,
                `announced: ${text.split("\n")[0].slice(0, 80)}`,
            );
        }
    }

    // ---------------------------------------------------------- interactions

    private async onInteraction(interaction: Interaction): Promise<void> {
        if (interaction.data?.name !== "status") return;

        // Announcements follow the channel where /status is used.
        if (interaction.channel_id) {
            this.rememberStatusChannel(interaction.channel_id);
        }

        let dumpText: string;
        try {
            dumpText = this.readDump();
        } catch (e) {
            await this.reply(
                interaction,
                `error reading database: ${(e as Error).message}`,
            );
            return;
        }

        const plan = planReply(dumpText);
        if (plan.mode === "inline") {
            await this.reply(interaction, plan.chunks[0]);
            for (const chunk of plan.chunks.slice(1)) {
                await this.followup(interaction, chunk);
            }
        } else {
            await this.replyWithFile(
                interaction,
                plan.text,
                `ctf-status-${Date.now()}.txt`,
            );
        }
    }

    private readDump(): string {
        const dbPath = path.resolve(this.opts.dbPath);
        if (!fs.existsSync(dbPath)) {
            throw new Error(`database not found: ${dbPath}`);
        }
        const db = new Database(dbPath, {
            readonly: true,
            fileMustExist: true,
        });
        try {
            return renderDbDump(db);
        } finally {
            db.close();
        }
    }

    // ---------------------------------------------------------------- replies

    private async reply(
        interaction: Interaction,
        content: string,
    ): Promise<void> {
        const res = await this.rest(
            "POST",
            `/interactions/${interaction.id}/${interaction.token}/callback`,
            {
                type: 4,
                data: { content },
            },
        );
        if (res.status >= 300) {
            log.warn(
                this.tag,
                `reply failed (${res.status}): ${JSON.stringify(res.json).slice(0, 300)}`,
            );
        }
    }

    private async followup(
        interaction: Interaction,
        content: string,
    ): Promise<void> {
        // Followups go through the application webhook using the interaction token.
        const res = await this.rest(
            "POST",
            `/webhooks/${this.opts.applicationId}/${interaction.token}`,
            { content },
        );
        if (res.status >= 300) {
            log.warn(
                this.tag,
                `followup failed (${res.status}): ${JSON.stringify(res.json).slice(0, 300)}`,
            );
        }
    }

    private async replyWithFile(
        interaction: Interaction,
        text: string,
        fileName: string,
    ): Promise<void> {
        // Multipart callback with a file attachment.
        const boundary = "----ctfworker" + Date.now();
        const jsonPayload = JSON.stringify({
            type: 4,
            data: { content: "Database dump attached." },
        });
        const parts: Buffer[] = [];
        const pushPart = (
            name: string,
            value: string | Buffer,
            filename?: string,
        ): void => {
            parts.push(
                Buffer.from(
                    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ""}\r\n` +
                        (typeof value === "string"
                            ? `Content-Type: application/json\r\n\r\n${value}\r\n`
                            : `Content-Type: text/plain\r\n\r\n`),
                ),
            );
            if (typeof value !== "string")
                parts.push(value, Buffer.from("\r\n"));
        };
        pushPart("payload_json", jsonPayload);
        pushPart("files[0]", Buffer.from(text, "utf8"), fileName);
        parts.push(Buffer.from(`--${boundary}--\r\n`));

        const res = await this.restBuffer(
            "POST",
            `/interactions/${interaction.id}/${interaction.token}/callback`,
            Buffer.concat(parts),
            `multipart/form-data; boundary=${boundary}`,
        );
        if (res.status >= 300) {
            log.warn(this.tag, `file reply failed (${res.status})`);
        }
    }
}
