#!/usr/bin/env bash
# deploy-remote.sh — deploy ctf-worker to the remote VPS via SSH.
#
# Runs ONCE when the VPS is reachable. It:
#   1. runs setup-remote.sh (one-time provisioning: swap, node, r2, pi, config)
#   2. rsyncs this repo (code + node_modules + run.sh) to /opt/ctf-worker
#   3. runs ./run.sh ON THE REMOTE (the same script used locally — it starts
#      the worker there: dispatcher + discord bot, background, logged)
#
# The remote then runs exactly like the local machine does: same run.sh,
# same layout, no systemd required (run.sh is the supervisor). A systemd unit
# is NOT installed by this path; use ctf-worker.service manually if you later
# want boot persistence on the remote.
#
# Usage: DEPLOY_SSH_KEY=~/.ssh/id_ed25519 ./deploy-remote.sh <user@host>
#   (host required; key defaults to $DEPLOY_SSH_KEY or ~/.ssh/id_ed25519)
set -euo pipefail

HOST="${1:?usage: ./deploy-remote.sh <user@host> (or set REMOTE_HOST)}"
HOST="${REMOTE_HOST:-$HOST}"
HERE="$(cd "$(dirname "$0")" && pwd)"
KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSHOPTS=(-i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=15)

echo "==> [1/4] provisioning (setup-remote.sh — idempotent)"
"$HERE/setup-remote.sh" "$HOST"

echo "==> [2/4] syncing code + node_modules + run.sh"
rsync -az --delete "${SSHOPTS[@]}" \
    --exclude node_modules --exclude .git --exclude jobs --exclude data \
    --exclude '.env.deploy' --exclude 'ssh-key*' --exclude 'ctf-worker.log' --exclude 'ctf-worker.pid' \
    "$HERE/" "$HOST:/opt/ctf-worker/"
rsync -az "${SSHOPTS[@]}" "$HERE/node_modules/" "$HOST:/opt/ctf-worker/node_modules/"

echo "==> [3/4] copying secrets env (.env.deploy + challenge dir)"
scp "${SSHOPTS[@]}" "$HERE/.env.deploy" "$HOST:/opt/ctf-worker/.env.deploy" 2>/dev/null &&
    ssh "${SSHOPTS[@]}" "$HOST" "chmod 600 /opt/ctf-worker/.env.deploy"

echo "==> [4/4] starting on the remote via run.sh"
ssh "${SSHOPTS[@]}" "$HOST" bash -s <<'EOS'
set -e
cd /opt/ctf-worker
export SOURCE=local
export LOCAL_SOURCE_DIR=/var/lib/ctf-worker/challenges
export DB_PATH=/var/lib/ctf-worker/ctf-worker.db
export JOBS_DIR=/var/lib/ctf-worker/jobs
./run.sh
EOS

echo
echo "DEPLOYED. Remote control:"
echo "  ssh $HOST 'cd /opt/ctf-worker && ./run.sh status'"
echo "  ssh $HOST 'cd /opt/ctf-worker && ./run.sh logs'"
echo "  ssh $HOST 'cd /opt/ctf-worker && ./run.sh stop'"
echo "Discord: /status once the bot logs in (check logs above)."
