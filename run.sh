#!/usr/bin/env bash
# run.sh — ctf-worker on/off switch for THIS machine (no SSH logic).
# Works anywhere the repo lives: local box, VPS, any host.
#
#   ./run.sh          ON:  full teardown of anything old, then start fresh
#   ./run.sh stop     OFF: full teardown — processes killed, systemd unit
#                          hard-deleted, agent runs killed. Nothing left behind.
#   ./run.sh status   state of the running worker
#   ./run.sh logs     tail the log
#
# "Full teardown" on both start and stop:
#   - ctf-worker systemd service: stopped, disabled, unit file deleted
#   - dispatcher + discord bot processes: killed (TERM then KILL)
#   - in-flight pi agent runs (--session-id ctf-*): killed with their groups
#   - pidfile removed
#
# Configuration (environment variables win, then .env / CTF_ENV_FILE, then
# .env.deploy for Discord secrets, then built-in defaults below).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
LOG="$HERE/ctf-worker.log"
PIDFILE="$HERE/ctf-worker.pid"
# Node selection: pi 0.84 requires node >= 22 (globSync); some hosts only ship
# older system node. Prefer an explicit NODE_BIN, else a user-local node22
# install, else system node. node22 is also prepended to PATH so the spawned
# pi agent (shebang: env node) runs under it too.
if [ -z "${NODE_BIN:-}" ] && [ -x "$HOME/.local/node22/bin/node" ]; then
    export PATH="$HOME/.local/node22/bin:$PATH"
    NODE_BIN="$HOME/.local/node22/bin/node"
fi
NODE_BIN="${NODE_BIN:-node}"

# ------------------------------------------------------------------ teardown
teardown() {
    local quiet="${1:-}"
    local did=0

    # 1. systemd service: stop, disable, HARD-DELETE the unit (tolerate no-sudo)
    if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^ctf-worker'; then
        sudo systemctl stop ctf-worker 2>/dev/null || true
        sudo systemctl disable ctf-worker 2>/dev/null || true
        sudo rm -f /etc/systemd/system/ctf-worker.service
        sudo systemctl daemon-reload 2>/dev/null || true
        [ -z "$quiet" ] && echo "  removed systemd service ctf-worker"
        did=1
    fi

    # 2. kill this project's processes (dispatcher, bot) — full paths only
    local pids
    pids=$(pgrep -f "$HERE/dist/index.js" 2>/dev/null || true)
    pids="$pids $(pgrep -f "$HERE/dist/discord/bot-main.js" 2>/dev/null || true)"
    if [ -n "$(echo $pids | tr -d ' ')" ]; then
        kill $pids 2>/dev/null || true
        sleep 1
        kill -9 $pids 2>/dev/null || true
        [ -z "$quiet" ] && echo "  killed dispatcher/bot processes"
        did=1
    fi

    # 3. kill in-flight agent runs and their process groups
    local agent_pids
    agent_pids=$(pgrep -f 'pi --mode json --session-id ctf-' 2>/dev/null || true)
    if [ -n "$agent_pids" ]; then
        for p in $agent_pids; do
            kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true
        done
        sleep 1
        for p in $agent_pids; do
            kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true
        done
        [ -z "$quiet" ] && echo "  killed agent run(s)"
        did=1
    fi

    # 4. pidfile
    rm -f "$PIDFILE"
    [ -z "$quiet" ] && { [ $did -eq 0 ] && echo "  nothing to clean (already off)" || true; }
    return 0
}

# ------------------------------------------------------------------ env
# Discord secrets from .env.deploy (gitignored) if the env doesn't already have them
if [ -f "$HERE/.env.deploy" ]; then
    # shellcheck disable=SC1091
    set -a
    source "$HERE/.env.deploy"
    set +a
fi
# Operator can also point at a full env file
if [ -f "${CTF_ENV_FILE:-$HERE/.env}" ]; then
    # shellcheck disable=SC1091
    set -a
    source "${CTF_ENV_FILE:-$HERE/.env}"
    set +a
fi

export SOURCE="${SOURCE:-local}"
export LOCAL_SOURCE_DIR="${LOCAL_SOURCE_DIR:-$HERE/challenges}"
# Challenge discovery scope. Default "auto": discovers challenges at the
# source root AND under a challenges/ directory simultaneously — put a
# challenge anywhere in the repo and it is found. Alternatives:
#   ""        → root only (every top-level dir is a challenge)
#   "<path>"  → pin discovery inside that directory only
# Note: unset var → auto. An explicitly-empty var stays empty (config.ts honors
# "" as root-only), so the dispatcher must NOT blanket-default it here.
if [ -z "${GITHUB_CHALLENGES_PREFIX+x}" ]; then
    export GITHUB_CHALLENGES_PREFIX="auto"
fi
# Top-level dirs to never treat as challenges (comma-separated). Applies to
# root-level discovery (auto/root modes). Default excludes common non-challenge
# dirs; override freely.
export GITHUB_EXCLUDE="${GITHUB_EXCLUDE:-writeups,scripts,docs,tools,templates,utils,notes,infrastructure,.github}"
export DB_PATH="${DB_PATH:-$HERE/data/ctf-worker.db}"
export JOBS_DIR="${JOBS_DIR:-$HERE/jobs}"
export AGENT_BACKEND="${AGENT_BACKEND:-pi}"
# pi discovery: PI_BIN if set; else `command -v pi`; else common user-local
# installs (~/.local/npm/bin, ~/.local/bin) — and put pi's dir on PATH so pi can
# spawn MCP servers by name (context-mode, etc.) and node stays resolvable.
if [ -z "${PI_BIN:-}" ]; then
    if command -v pi >/dev/null 2>&1; then
        PI_BIN="$(command -v pi)"
    elif [ -x "$HOME/.local/npm/bin/pi" ]; then
        PI_BIN="$HOME/.local/npm/bin/pi"
    elif [ -x "$HOME/.local/bin/pi" ]; then
        PI_BIN="$HOME/.local/bin/pi"
    fi
    export PI_BIN
fi
if [ -n "${PI_BIN:-}" ] && [ -x "${PI_BIN}" ]; then
    case ":$PATH:" in
    *":$(dirname "$PI_BIN"):"*) ;;
    *) export PATH="$(dirname "$PI_BIN"):$PATH" ;;
    esac
fi
export PI_MODEL="${PI_MODEL:-tokenrouter/z-ai/glm-5.3-free}"
if [ -n "$PI_MODEL" ]; then
    export PI_EXTRA_ARGS="${PI_EXTRA_ARGS:-} --model $PI_MODEL"
fi
export MAX_CONCURRENT="${MAX_CONCURRENT:-2}"
export MAX_ATTEMPTS="${MAX_ATTEMPTS:-20}"
# Rotation: one turn per challenge, then rotate the queue. After a full round
# the initial challenge resumes with its session intact.
export TURN_MINUTES="${TURN_MINUTES:-10}"
export RUN_TIMEOUT_MIN="${RUN_TIMEOUT_MIN:-$TURN_MINUTES}"
export IDLE_TIMEOUT_MIN="${IDLE_TIMEOUT_MIN:-10}"
export STATUS_INTERVAL_SEC="${STATUS_INTERVAL_SEC:-60}"
export WEBHOOK_ENABLED="${WEBHOOK_ENABLED:-false}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
if [ -n "${DISCORD_BOT_TOKEN:-}" ] && [ -n "${DISCORD_APPLICATION_ID:-}" ]; then
    export DISCORD_BOT_ENABLED=true
fi

# ------------------------------------------------------------------ build
build_if_needed() {
    if [ ! -f "$HERE/dist/index.js" ] || [ -n "$(find "$HERE/src" -name '*.ts' -newer "$HERE/dist/index.js" -print -quit 2>/dev/null)" ]; then
        echo "building (sources changed)..."
        npm run build >/dev/null
    else
        echo "dist up to date"
    fi
}

# ------------------------------------------------------------------ start
start() {
    echo "==> teardown (switch OFF first)"
    teardown
    echo "==> build"
    build_if_needed

    mkdir -p "$(dirname "$DB_PATH")" "$JOBS_DIR" "$LOCAL_SOURCE_DIR"
    if [ "$SOURCE" = local ] && [ -z "$(ls -A "$LOCAL_SOURCE_DIR" 2>/dev/null)" ]; then
        echo "NOTE: $LOCAL_SOURCE_DIR is empty — drop challenge directories into it"
    fi

    : >"$LOG"
    nohup "$NODE_BIN" "$HERE/dist/index.js" >>"$LOG" 2>&1 &
    echo $! >"$PIDFILE"
    echo "==> started (pid $(cat "$PIDFILE")) — log: $LOG"

    sleep 4
    if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "FAILED TO START — last log lines:"
        tail -20 "$LOG"
        exit 1
    fi
    echo "==> log ---"
    tail -6 "$LOG"
    echo "-----------"
    echo "ON. commands: ./run.sh status | ./run.sh logs | ./run.sh stop"
    if [ -n "${DISCORD_BOT_TOKEN:-}" ]; then
        echo "discord: /status + solve announcements active"
    fi
}

case "${1:-start}" in
start) start ;;
stop)
    echo "==> teardown (switch OFF)"
    teardown
    echo "OFF. everything cleaned."
    ;;
status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "ON — running (pid $(cat "$PIDFILE"))"
        ps -o pid,etime,rss,cmd -p "$(cat "$PIDFILE")" | tail -1
    else
        echo "OFF — not running"
    fi
    ;;
logs) tail -f "$LOG" ;;
*)
    echo "usage: ./run.sh [start|stop|status|logs]"
    exit 1
    ;;
esac
