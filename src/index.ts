/**
 * ctf-worker: autonomous CTF challenge dispatcher.
 *
 *     source (GitHub/local) → detect → stage → SQLite → Pi handoff →
 *     observe → classify (solved / fatal / recoverable) → continue or stop →
 *     Discord status.
 *
 * See README.md for configuration and deployment (systemd unit included).
 */

import * as path from "node:path";
import { loadConfig } from "./config.js";
import { setLogLevel, log } from "./log.js";
import * as db from "./database/db.js";
import { GitHubSource } from "./sources/github.js";
import { LocalSource } from "./sources/local.js";
import { PiBackend } from "./agents/pi.js";
import { EchoBackend } from "./agents/echo.js";
import { Watcher } from "./dispatcher/watcher.js";
import { WebhookServer } from "./dispatcher/webhook.js";
import { Lifecycle, syncRepoReadme } from "./dispatcher/lifecycle.js";
import { Queue } from "./dispatcher/queue.js";
import { DiscordPublisher, LogPublisher } from "./publishers/discord.js";
import { DiscordReporter } from "./publishers/reporter.js";
import { DiscordBot } from "./discord/bot.js";
import { PanelManager } from "./discord/panel-manager.js";
import { sleep } from "./agents/backend.js";

let stopping = false;

async function main(): Promise<void> {
    const cfg = loadConfig();
    setLogLevel(cfg.logLevel);
    log.info(
        "main",
        `ctf-worker starting (source=${cfg.source} agent=${cfg.agent} db=${cfg.dbPath})`,
    );

    // ---------------------------------------------------------------- state
    db.openDb(cfg.dbPath);

    // ---------------------------------------------------------------- source
    const src =
        cfg.source === "github"
            ? new GitHubSource(cfg.github)
            : new LocalSource(cfg.local.dir, cfg.local.prefix);

    // ---------------------------------------------------------------- reporter
    const publisher = cfg.discordWebhookUrl
        ? new DiscordPublisher(cfg.discordWebhookUrl)
        : new LogPublisher();
    const reporter = new DiscordReporter(publisher);

    // ---------------------------------------------------------------- agent
    const backend =
        cfg.agent === "pi"
            ? new PiBackend({
                  piBin: cfg.piBin,
                  extraArgs: cfg.piExtraArgs,
                  // Rotation: one turn == one run-timeout slot. When the turn
                  // expires, the run is killed, WRITEUP is captured, and the
                  // queue rotates to the next challenge (round-robin).
                  runTimeoutMin: cfg.turnMinutes,
                  idleTimeoutMin: cfg.idleTimeoutMin,
                  killGraceSec: cfg.killGraceSec,
              })
            : new EchoBackend({ defaultScript: cfg.echoScript });

    // ---------------------------------------------------------------- lifecycle
    let discordBotRef: DiscordBot | null = null;
    const lifecycle = new Lifecycle(src, cfg.jobsDir, {
        maxAttempts: cfg.maxAttempts,
        turnMinutes: cfg.turnMinutes,
        onEvent: (event) => {
            void reporter
                .onEvent(event)
                .catch((e) => log.warn("main", `report failed: ${e}`));
            // SOLVED → @everyone announcement via the bot (if enabled)
            if (event.type === "solved" && discordBotRef) {
                const name =
                    event.challenge.split("/").filter(Boolean).pop() ??
                    event.challenge;
                const flagLine = event.flag ? `\nFlag: \`${event.flag}\`` : "";
                const summary = (event.summary ?? "")
                    .split("\n")
                    .slice(0, 12)
                    .join("\n")
                    .slice(0, 800);
                void discordBotRef
                    .announce(
                        `@everyone 🎉 **SOLVED: ${name}**${flagLine}\n\n${summary}`,
                    )
                    .catch((e) => log.warn("main", `announce failed: ${e}`));
            }
        },
    });

    // ---------------------------------------------------------------- queue
    const queue = new Queue(backend, lifecycle, {
        maxConcurrent: cfg.maxConcurrent,
    });

    // ---------------------------------------------------------------- startup recovery
    // Jobs marked RUNNING whose process is gone (dispatcher restart, VPS reboot)
    // are re-enqueued as continuations; pi resumes the same session, so no work
    // is lost. STAGED/HANDED_OFF leftovers are simply re-run by the queue.
    const interrupted = lifecycle.recoverInterruptedJobs(backend);
    for (const { jobId } of interrupted) {
        const job = db.getJobById(jobId);
        if (!job) continue;
        if (job.status === "RUNNING") {
            db.updateJob(jobId, { status: "AGENT_STOPPED", pid: null });
            db.setChallengeStatus(job.challenge_id, "AGENT_STOPPED");
            log.warn(
                "main",
                `recovered interrupted job #${jobId} as continuation`,
            );
        }
    }

    // ---------------------------------------------------------------- watcher + webhook
    const watcher = new Watcher(src, {
        pollIntervalSec: cfg.pollIntervalSec,
        prefix: cfg.source === "github" ? cfg.github.prefix : cfg.local.prefix,
        exclude:
            cfg.source === "github" ? cfg.github.exclude : cfg.local.exclude,
    });

    if (cfg.scanOnly) {
        // --scan: single poll pass, discover only, exit.
        const { challenges } = await watcher.pollOnce();
        const created = await lifecycle.discover(challenges);
        log.info(
            "main",
            `scan complete: ${challenges.length} challenge(s), ${created.length} new job(s)`,
        );
        db.closeDb();
        return;
    }

    if (cfg.once) {
        // --once: single poll pass, discover, stage, and run until every job
        // reaches a terminal state (or a fatal error), then exit.
        const { challenges } = await watcher.pollOnce();
        await lifecycle.discover(challenges);
        const q = new Queue(backend, lifecycle, {
            maxConcurrent: cfg.maxConcurrent,
        });
        q.wake();
        await q.runOnce();
        db.closeDb();
        log.info("main", "once-mode complete");
        return;
    }

    void watcher
        .run(async (batch, solvedLines) => {
            // Repo-sync prune: stop and close out anything deleted from the
            // repo (challenge files replaced/removed), before discovering new.
            lifecycle.pruneMissing(batch, (jobId, reason) =>
                queue.markDone(jobId, reason),
            );
            await lifecycle.discover(batch, solvedLines);
            // Every GitHub update: refresh REPO-README.md (credentials/instances)
            // into every workspace so agents see README changes.
            await syncRepoReadme(src, cfg.jobsDir).catch((e) =>
                log.warn(
                    "main",
                    `REPO-README sync failed: ${(e as Error).message}`,
                ),
            );
            queue.wake();
        })
        .catch((e) =>
            log.error("main", `watcher crashed: ${(e as Error).stack}`),
        );

    let webhook: WebhookServer | null = null;
    if (cfg.webhook.enabled) {
        webhook = new WebhookServer({
            host: cfg.webhook.host,
            port: cfg.webhook.port,
            secret: cfg.webhook.secret,
            repoFilter: cfg.source === "github" ? cfg.github.repo : "",
            branchFilter: cfg.source === "github" ? cfg.github.branch : "",
            onPush: () => watcher.trigger(),
        });
        try {
            await webhook.start();
        } catch (e) {
            log.warn(
                "main",
                `webhook server failed to start (continuing without): ${(e as Error).message}`,
            );
            webhook = null;
        }
    }

    // ---------------------------------------------------------------- status loop
    let statusStop = false;
    const statusLoop = (async () => {
        await sleep(cfg.statusIntervalSec * 1000);
        while (!statusStop) {
            try {
                const text = await reporter.statusSnapshot();
                await publisher.publish(text); // raw publish: status is not deduped
            } catch (e) {
                log.warn(
                    "main",
                    `status snapshot failed: ${(e as Error).message}`,
                );
            }
            await sleep(cfg.statusIntervalSec * 1000);
        }
    })();
    void statusLoop;

    // ---------------------------------------------------------------- discord /status bot + job panels
    let discordBot: DiscordBot | null = null;
    let panels: PanelManager | null = null;
    if (cfg.discordBot.enabled) {
        if (!cfg.discordBot.token || !cfg.discordBot.applicationId) {
            log.warn(
                "main",
                "DISCORD_BOT_ENABLED but DISCORD_BOT_TOKEN/DISCORD_APPLICATION_ID missing — bot disabled",
            );
        } else {
            discordBot = new DiscordBot({
                token: cfg.discordBot.token,
                applicationId: cfg.discordBot.applicationId,
                dbPath: cfg.dbPath,
                announceChannelId: cfg.discordBot.announceChannelId,
            });
            discordBotRef = discordBot;
            // Job control panels: one message per challenge, live WRITEUP.md,
            // ✅ reaction stops the job.
            panels = new PanelManager({
                stateDir: path.dirname(path.resolve(cfg.dbPath)),
                refreshMs: 15_000,
                jobsDir: cfg.jobsDir,
            });
            panels.doneHandler = (jobId) => {
                const job = db.getJobById(jobId);
                queue.markDone(jobId, "done reaction");
                if (job) db.setChallengeStatus(job.challenge_id, "SKIPPED");
            };
            // attach after the bot resolves its channel (READY), so panels post
            // to a known channel; PanelManager tolerates a null channel until then.
            const attachPanels = setInterval(() => {
                if (discordBot?.channelsReady && panels) {
                    panels.attach(discordBot); // SAFETY: DiscordBot structurally satisfies BotLike (postPanel/updatePanel/hooks)
                    panels.start();
                    clearInterval(attachPanels);
                }
                if (!discordBot) clearInterval(attachPanels);
            }, 3_000);
            attachPanels.unref?.();
            discordBot
                .start()
                .catch((e) =>
                    log.error(
                        "main",
                        `discord bot crashed: ${(e as Error).stack}`,
                    ),
                );
        }
    }

    // ---------------------------------------------------------------- shutdown wiring
    const shutdown = async (signal: string): Promise<void> => {
        if (stopping) return;
        stopping = true;
        log.info("main", `${signal} received, shutting down`);
        watcher.stop();
        queue.stop(); // waits for in-flight runs to settle
        statusStop = true;
        panels?.stop();
        discordBot?.stop();
        await webhook?.stop();
        db.closeDb();
        log.info("main", "ctf-worker stopped");
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    // ---------------------------------------------------------------- main loop
    await queue.run(); // resolves only after queue.stop() and in-flight runs finish

    // `--once` / graceful exit path when the queue drains (not used in daemon mode).
    watcher.stop();
    statusStop = true;
    await webhook?.stop();
    db.closeDb();
    log.info("main", "ctf-worker stopped");
}

main().catch((e) => {
    log.error("main", `fatal: ${(e as Error).stack}`);
    process.exit(1);
});
