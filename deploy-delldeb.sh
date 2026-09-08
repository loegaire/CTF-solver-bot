#!/usr/bin/env bash
# deploy-delldeb.sh — deploy ctf-worker to thinh@delldeb (test target).
#
# Keeps the remote pi 0.84.4 as-is (no new pi). Steps:
#   1. user-local Node 22 (pi needs globSync; system node is 20) — no sudo
#   2. pi config copied EXACTLY from this host (settings.json, mcp.json,
#      models.json) — remote backups kept as *.bak.<date>
#   3. pi npm packages installed to match settings.json (pi-mcp-extension,
#      pi-web-access, pi-subagents, context-mode, pi-lens)
#   4. ctf-worker code + node_modules rsynced to ~/ctf-worker
#   5. (start is manual: ssh thinh@delldeb 'cd ~/ctf-worker && ./run.sh')
#
# For teardown: ./deploy-delldeb.sh clean
set -euo pipefail

HOST="${1:-thinh@delldeb}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REMOTE_DIR="ctf-worker"
SSHOPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=20)

echo "==> [1/6] user-local Node 22 on $HOST (no sudo, no new pi)"
ssh "${SSHOPTS[@]}" "$HOST" bash -s <<'EOS'
set -e
if [ -x "$HOME/.local/node22/bin/node" ] && [ "$("$HOME/.local/node22/bin/node" -v | cut -c2-3)" -ge 22 ]; then
  echo "  node22 already present: $(~/.local/node22/bin/node -v)"
else
  cd /tmp
  if [ ! -f node.tar.xz ]; then
    curl -fsSL -o node.tar.xz "https://nodejs.org/dist/v22.22.2/node-v22.22.2-linux-x64.tar.xz"
  fi
  mkdir -p ~/.local/node22
  tar -xJf node.tar.xz --strip-components=1 -C ~/.local/node22
  ~/.local/node22/bin/node -v
fi
# pi must run under node 22; wrap it by ensuring PATH order when we use it.
# (pi stays exactly where it is: ~/.local/npm/bin/pi)
EOS

echo "==> [2/6] pi config: exact copy from this host"
ssh "${SSHOPTS[@]}" "$HOST" "mkdir -p ~/.pi/agent"
for f in settings.json mcp.json models.json; do
  # backup remote originals once
  ssh "${SSHOPTS[@]}" "$HOST" "[ -f ~/.pi/agent/$f ] && [ ! -f ~/.pi/agent/$f.bak ] && cp ~/.pi/agent/$f ~/.pi/agent/$f.bak || true"
  scp -q "${SSHOPTS[@]}" "$HOME/.pi/agent/$f" "$HOST:.pi/agent/$f"
done
ssh "${SSHOPTS[@]}" "$HOST" "ls -la ~/.pi/agent/*.json | head -8"

echo "==> [3/6] pi npm packages (match settings.json)"
ssh "${SSHOPTS[@]}" "$HOST" bash -s <<'EOS'
set -e
export PATH="$HOME/.local/node22/bin:$HOME/.local/npm/bin:$HOME/.local/bin:$PATH"
# pi installs its npm packages into ~/.pi/agent/npm — reinstall missing ones.
# Use node-22 pi directly so package install works.
have() { ls ~/.pi/agent/npm/node_modules 2>/dev/null | grep -q "^$1$"; }
for pkg in pi-mcp-extension pi-web-access pi-subagents context-mode pi-lens; do
  if have "$pkg"; then
    echo "  $pkg ok"
  else
    ~/.local/npm/bin/pi install "npm:$pkg" 2>&1 | tail -1 || echo "  (install $pkg failed — continuing)"
  fi
done
ls ~/.pi/agent/npm/node_modules | head -8
EOS

echo "==> [4/6] code + node_modules"
RSYNC_SSH="ssh -o StrictHostKeyChecking=no -o ConnectTimeout=20"
# NOTE: both .env and .env.deploy are EXCLUDED from the --delete rsync — the
# remote owns its config (SOURCE/GITHUB_*) and secrets. Step 5 re-uploads
# .env.deploy explicitly afterwards.
rsync -az --delete -e "$RSYNC_SSH" \
  --exclude node_modules --exclude .git --exclude jobs --exclude data \
  --exclude '.env' --exclude '.env.deploy' --exclude 'ssh-key*' \
  --exclude 'ctf-worker.log' --exclude 'ctf-worker.pid' \
  --exclude 'challenges' \
  "$HERE/" "$HOST:$REMOTE_DIR/"
rsync -az -e "$RSYNC_SSH" "$HERE/node_modules/" "$HOST:$REMOTE_DIR/node_modules/"
echo "  synced"

echo "==> [5/6] secrets + env"
scp -q "${SSHOPTS[@]}" "$HERE/.env.deploy" "$HOST:$REMOTE_DIR/.env.deploy"
ssh "${SSHOPTS[@]}" "$HOST" "chmod 600 $REMOTE_DIR/.env.deploy"

echo "==> [6/6] verify node22 runs the dispatcher + pi"
ssh "${SSHOPTS[@]}" "$HOST" bash -s <<'EOS'
set -e
cd ~/ctf-worker
# run.sh auto-detects ~/.local/node22/bin/node; verify that resolution works:
export PATH="$HOME/.local/node22/bin:$HOME/.local/npm/bin:$HOME/.local/bin:$PATH"
node -v
node -e "require('better-sqlite3'); console.log('better-sqlite3 OK under', process.version)"
pi --version 2>&1 | head -1
EOS

echo
echo "DEPLOYED to $HOST:~/$REMOTE_DIR"
echo "Start:    ssh $HOST 'cd $REMOTE_DIR && ./run.sh'"
echo "Stop:     ssh $HOST 'cd $REMOTE_DIR && ./run.sh stop'"
echo "Clean:    ./deploy-delldeb.sh clean"
