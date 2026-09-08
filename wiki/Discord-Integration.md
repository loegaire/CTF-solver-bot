# Discord Integration

Discord integration is layered and entirely optional at every level. A Discord
outage, a missing webhook, or a disabled bot never affects challenge
processing.

```
LifecycleEvent ──► DiscordReporter ──► Publisher (webhook | log)   [push channel]
                                     └─ messages-table dedupe
DB state ────────► status loop ─────► Publisher (raw, NOT deduped) [periodic dashboard]
DB + panels ─────► DiscordBot (/status, announcements, panels)      [interactive]
```

## 1. Push channel: Reporter + Publishers (`src/publishers/`)

**`Publisher`** (`publisher.ts`) is the output abstraction: `name`,
`ready()`, `publish(text)` — plus `hashOf(text)` (sha256) used for dedupe.
Implementations:

- **`DiscordPublisher`** (`discord.ts`) — POSTs to a Discord **webhook URL**
  (`DISCORD_WEBHOOK_URL`). Fire-and-forget: failures are logged and swallowed;
  content clamped to Discord's 2000-char limit with a visible ellipsis.
- **`LogPublisher`** — used when no webhook is configured; just logs the
  text (the default "reporting everywhere works out of the box" mode).

**`DiscordReporter`** (`reporter.ts`) subscribes to lifecycle events and turns
them into messages, each deduped via the `messages` table (see
[[Persistence-and-Database]] §2.4 — exactly-once per content hash, even
across restarts):

| Event | Message |
| --- | --- |
| `staged` | `**name** — staged, handing to pi (job #N)` |
| `started` | `**name** — started (job #N)` / `— continuing (attempt N)` |
| `continue` | `↻ name — continuing (attempt N: reason)` |
| `solved` | `✅ **name** — SOLVED` + flag line + summary head |
| `fatal` | `⛔ **name** — fatal error: reason` + context |
| `blocked` | `⏸ **name** — blocked (reason)` |

**Status dashboard:** `statusSnapshot()` renders DB state (counts per status,
recent jobs, flags) and the main loop publishes it every
`STATUS_INTERVAL_SEC` (default 60) — raw publish, deliberately not deduped
(it's a periodic heartbeat).

## 2. Interactive: the bot (`src/discord/bot.ts`)

A plain REST + gateway WebSocket client — **no discord.js dependency**.
When `DISCORD_BOT_ENABLED=true` and `DISCORD_BOT_TOKEN` +
`DISCORD_APPLICATION_ID` are set, the dispatcher runs the bot **in-process**
(also runnable standalone via `src/discord/bot-main.ts`).

- Intents: `GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS` — the
  reaction intent powers the panels' ✅ control.
- **`/status`** — global slash command; registers itself at startup. Replies
  with a **raw dump of the dispatcher SQLite DB** (see §3): small dumps
  inline in a code fence; big ones attach a `.txt` file. Also remembers the
  channel (persisted in `announce-state.json` next to the DB) — announcements
  follow wherever `/status` was last used.
- **SOLVED announcements** — every `solved` event is announced with an
  `@everyone` ping (flag + first lines of the summary). Channel selection:
  `DISCORD_ANNOUNCE_CHANNEL_ID` if set, else auto-detect: prefers a channel
  literally named `solved`, then `announcements`, then `general`, then the
  first text channel.
- **The bot only reads the DB** (read-only handle); it never writes
  dispatcher state. The one exception is *indirect*: the ✅ reaction calls
  back into the queue's `markDone` (which does the state change).

## 3. The dump renderer (`src/discord/status-dump.ts`)

`renderDbDump(db)` renders the whole DB as plain-text tables (kept separate
from the bot client so it's unit-testable): a summary line of job counts per
status, then the `challenges`, `jobs`, `progress`, `messages`, and `meta`
tables (long fields like summaries/errors clamped to `maxWidth`, default 60).
`planReply()` splits/chunks it to fit Discord's message limit
(`DISCORD_CHUNK_LIMIT = 1900`) — deciding inline-code-fence vs `.txt`
attachment. This is the same renderer the CLI uses conceptually; `/status` is
"the whole database, in a code block."

## 4. Live job panels (`src/discord/panel-manager.ts`, `panels.ts`)

One **control message per challenge**, refreshed live:

- `PanelManager` syncs one message per challenge (creating on first sight,
  editing in place afterwards) every `refreshMs` (15s). It joins
  `getAllJobsWithChallengePath()` with the workspace's `WRITEUP.md`.
- Panel content: challenge name, job status, attempts, last flag/error, the
  agent's instruction line per status, and **the whole `WRITEUP.md`** — inline
  when it fits in one message, attached as a `WRITEUP.md` file on the same
  message when it doesn't (the text part keeps the meta).
- `PanelRegistry` (panels.ts) maps challenge/job → message ids, persisted in
  the state dir (next to the DB) so restarts reuse the same messages instead
  of spamming new ones.
- **✅ done reaction** — each panel message carries a ✅ reaction (added by
  the bot on creation). A `MESSAGE_REACTION_ADD` on a panel maps back to the
  job id: `PanelManager.doneHandler` → `queue.markDone(jobId, "done
  reaction")` + challenge → `SKIPPED`. This is the human "stop working on
  this one" control. If a run was in flight, it's killed and the run's
  late-arriving outcome is ignored (see [[Job-Lifecycle]] §5).
- Panels attach only after the bot is READY (channel resolved); the manager
  tolerates a null channel until then (retry every 3s).

## 5. Configuration Summary

| Variable | Meaning |
| --- | --- |
| `DISCORD_WEBHOOK_URL` | webhook for the push channel; empty = LogPublisher |
| `STATUS_INTERVAL_SEC` | dashboard cadence (default 60) |
| `DISCORD_BOT_ENABLED` | run the interactive bot in-process (default false) |
| `DISCORD_BOT_TOKEN` | bot token (required when enabled) |
| `DISCORD_APPLICATION_ID` | application id for command registration |
| `DISCORD_ANNOUNCE_CHANNEL_ID` | announce channel; empty = auto-detect |

All of them are optional: with nothing set, everything still runs and all
reporting goes to the log.
