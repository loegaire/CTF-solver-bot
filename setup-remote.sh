#!/usr/bin/env bash
# setup-remote.sh — ONE-TIME provisioning of the remote VPS for ctf-worker.
#
# Designed for an UNRELIABLE box: the work runs DETACHED on the remote
# (nohup + log file), so SSH disconnects/network wedges do not interrupt it.
# This script kicks it off, then polls the log until completion.
#
# Idempotent: every step checks and skips what already exists. Safe to re-run.
#
#   1. swap file (if missing)
#   2. system packages (gdb, python3, sqlite, rsync, git, wget)
#   3. Node 22 (NodeSource rpm)
#   4. radare2 as a PREBUILT static tarball (never compiled on the box)
#   5. pi agent (global npm install)
#   6. directories (/opt/ctf-worker, /var/lib/ctf-worker/{jobs,challenges})
set -euo pipefail

HOST="${1:?usage: ./setup-remote.sh <user@host> (or set REMOTE_HOST)}"
HOST="${REMOTE_HOST:-$HOST}"
HERE="$(cd "$(dirname "$0")" && pwd)"
KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSHOPTS=(-i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=30 -o ServerAliveInterval=10)

echo "==> kicking off detached provisioning on $HOST"
ssh "${SSHOPTS[@]}" "$HOST" bash -s <<'KICK'
# Write the worker script, then detach it. Survives SSH death.
cat > ~/provision.sh <<'WORKER'
#!/usr/bin/env bash
set -e
exec > ~/provision.log 2>&1
echo "[start] $(date)"
echo "[1] swap"
if ! swapon --show 2>/dev/null | grep -q .; then
  sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
else
  echo "  ok (present)"
fi

echo "[2] system packages"
need=""
for p in gdb python3 rsync git wget tar; do
  command -v $p >/dev/null 2>&1 || need="$need $p"
done
if [ -n "$need" ]; then
  sudo dnf install -y $need sqlite sqlite-devel
else
  echo "  ok (present)"
fi

echo "[3] Node 22"
if command -v node >/dev/null 2>&1 && [ "$(node -v 2>/dev/null | cut -c2- | cut -d. -f1)" -ge 20 ]; then
  echo "  ok ($(node -v))"
else
  curl -fsSL https://rpm.nodesource.com/setup_22.x -o /tmp/nsetup.sh
  sudo -E bash /tmp/nsetup.sh >/dev/null
  sudo dnf install -y nodejs
  echo "  installed $(node -v)"
fi

echo "[4] radare2 (prebuilt static — no compile)"
if command -v r2 >/dev/null 2>&1; then
  echo "  ok ($(r2 -v | head -1))"
else
  mkdir -p ~/r2 && cd ~/r2
  for v in 5.9.8 5.9.4 5.8.8; do
    wget -q "https://github.com/radareorg/radare2/releases/download/$v/radare2-$v-static.tar.xz" -O r2.tar.xz && break
  done
  tar xf r2.tar.xz
  D=$(find . -maxdepth 1 -type d -name 'radare2-*' | head -1)
  sudo mkdir -p /usr/local/bin /usr/local/share/radare2 /usr/local/lib
  sudo cp -f "$D"/bin/r* /usr/local/bin/
  sudo cp -rf "$D"/share/radare2/* /usr/local/share/radare2/ 2>/dev/null || true
  sudo cp -rf "$D"/lib/* /usr/local/lib/ 2>/dev/null || true
  rm -f r2.tar.xz
  echo "  installed $(r2 -v | head -1)"
fi

echo "[5] pi agent"
if command -v pi >/dev/null 2>&1; then
  echo "  ok ($(pi --version 2>/dev/null | head -1))"
else
  npm install -g @earendil-works/pi-coding-agent || sudo npm install -g @earendil-works/pi-coding-agent
  echo "  installed $(pi --version 2>/dev/null | head -1)"
fi

echo "[6] directories"
sudo mkdir -p /opt/ctf-worker /var/lib/ctf-worker/jobs /var/lib/ctf-worker/challenges
sudo chown -R "$(whoami)" /opt/ctf-worker /var/lib/ctf-worker
echo "  ok"

echo "PROVISIONING COMPLETE"
echo "[end] $(date)"
WORKER
chmod +x ~/provision.sh
# Detach: nohup so it survives this SSH session dying
rm -f ~/provision.log ~/provision.done
nohup bash -c 'bash ~/provision.sh && touch ~/provision.done' >/dev/null 2>&1 &
echo "provisioning detached (log: ~/provision.log)"
KICK

echo "==> polling for completion (box may wedge; script survives)"
for i in $(seq 1 90); do
  sleep 30
  OUT=$(ssh "${SSHOPTS[@]}" "$HOST" 'if [ -f ~/provision.done ]; then echo DONE; tail -20 ~/provision.log; elif [ -f ~/provision.log ]; then echo RUNNING; tail -3 ~/provision.log; else echo WAITING; fi' 2>/dev/null || echo "UNREACHABLE")
  FIRST=$(echo "$OUT" | head -1)
  case "$FIRST" in
  DONE)
    echo "==> provisioning complete after ~$((i * 30 / 60)) min"
    echo "$OUT" | tail -20
    exit 0
    ;;
  RUNNING)
    echo "  [$i] still running: $(echo "$OUT" | tail -1)"
    ;;
  UNREACHABLE | WAITING | *)
    echo "  [$i] ssh unreachable (work continues on the box)"
    ;;
  esac
done
echo "==> timed out polling; provisioning is still running detached."
echo "    check later with: ssh $HOST 'tail -20 ~/provision.log'"
exit 1
