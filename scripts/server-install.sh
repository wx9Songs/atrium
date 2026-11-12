#!/usr/bin/env bash
# Atrium server install (Debian / Ubuntu, run as root).
#
# Sets up, all bound to loopback only:
#   - atrium      the hub: web page + runner endpoint            127.0.0.1:3005
#   - agentsview  the session archive Atrium reads history from   127.0.0.1:8080
#   - agentsync   a locked-down account machines push transcripts to (rsync over SSH,
#                 write-only, one folder per machine) and tunnel through to the hub
#
# Usage:
#   sudo ./server-install.sh --atrium ./atrium [--agentsview ./agentsview]
#
# Nothing is exposed to the internet by this script. Reach the page through an SSH
# tunnel (see docs/install.md) or put a reverse proxy with TLS in front of 127.0.0.1:3005.
# Safe to run again: existing configs and secrets are kept.
set -euo pipefail

ATRIUM_BIN=""
AGENTSVIEW_BIN=""
AGENTSVIEW_VERSION="${AGENTSVIEW_VERSION:-0.47.0}"
HUB_PORT=3005
ARCHIVE_PORT=8080

while [ $# -gt 0 ]; do
  case "$1" in
    --atrium) ATRIUM_BIN="$2"; shift 2 ;;
    --agentsview) AGENTSVIEW_BIN="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -n "$ATRIUM_BIN" ] && [ -f "$ATRIUM_BIN" ] || { echo "--atrium PATH is required (build it with: make server)" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required" >&2; exit 1; }

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq rsync python3 curl ca-certificates >/dev/null
RRSYNC="$(command -v rrsync || true)"
[ -n "$RRSYNC" ] || { echo "rrsync not found (it ships with the rsync package on Debian/Ubuntu)" >&2; exit 1; }

echo "==> binaries"
install -m 755 "$ATRIUM_BIN" /usr/local/bin/atrium
if [ -n "$AGENTSVIEW_BIN" ]; then
  install -m 755 "$AGENTSVIEW_BIN" /usr/local/bin/agentsview
elif [ ! -x /usr/local/bin/agentsview ]; then
  case "$(uname -m)" in x86_64) A=amd64 ;; aarch64|arm64) A=arm64 ;; *) echo "unsupported CPU" >&2; exit 1 ;; esac
  URL="https://github.com/kenn-io/agentsview/releases/download/v${AGENTSVIEW_VERSION}/agentsview_${AGENTSVIEW_VERSION}_linux_${A}.tar.gz"
  T="$(mktemp -d)"
  echo "    downloading $URL"
  curl -fsSL --retry 3 -o "$T/a.tgz" "$URL"
  echo "    sha256: $(sha256sum "$T/a.tgz" | cut -d' ' -f1)"
  echo "    compare this with the checksum published on the agentsview release page."
  tar -xzf "$T/a.tgz" -C "$T"
  install -m 755 "$(find "$T" -type f -name agentsview | head -1)" /usr/local/bin/agentsview
  rm -rf "$T"
fi

echo "==> accounts and folders"
id atrium >/dev/null 2>&1     || useradd --system --home-dir /srv/atrium --shell /usr/sbin/nologin atrium
id agentsync >/dev/null 2>&1  || { useradd --system -m -d /var/lib/agentsync -s /bin/sh agentsync; usermod -p '*' agentsync; }
id agentsview >/dev/null 2>&1 || useradd --system --home-dir /srv/agentsview-data --shell /usr/sbin/nologin -G agentsync agentsview
usermod -a -G agentsync agentsview
install -d -o atrium -g atrium -m 700 /srv/atrium
install -d -o agentsview -g agentsview -m 700 /srv/agentsview-data
install -d -o root -g root -m 755 /srv/agent-sessions
install -d -o agentsync -g agentsync -m 700 /var/lib/agentsync/.ssh
touch /var/lib/agentsync/.ssh/authorized_keys
chown agentsync:agentsync /var/lib/agentsync/.ssh/authorized_keys; chmod 600 /var/lib/agentsync/.ssh/authorized_keys

echo "==> sshd: restrict the sync account"
cat > /etc/ssh/sshd_config.d/50-atrium-agentsync.conf <<EOF
# Machines push transcripts with this account and open one tunnel to the hub. Nothing else.
Match User agentsync
    AuthenticationMethods publickey
    PasswordAuthentication no
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:${HUB_PORT}
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    ClientAliveInterval 30
    ClientAliveCountMax 4
EOF
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd

echo "==> archive (agentsview)"
if [ ! -f /srv/agentsview-data/config.toml ]; then
  cat > /srv/agentsview-data/config.toml <<EOF
auth_token = "$(head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-43)"
disable_update_check = true
local_machine_name = "server"
require_auth = true

[agents]
  [agents.claude]
    dirs = []
  [agents.codex]
    dirs = []
    homes = []
EOF
  chown agentsview:agentsview /srv/agentsview-data/config.toml; chmod 600 /srv/agentsview-data/config.toml
fi
cat > /etc/systemd/system/agentsview.service <<EOF
[Unit]
Description=agentsview session archive (loopback only, used by Atrium)
After=network.target

[Service]
User=agentsview
Group=agentsview
SupplementaryGroups=agentsync
Environment=AGENTSVIEW_DATA_DIR=/srv/agentsview-data
Environment=HOME=/srv/agentsview-data
Environment=AGENTSVIEW_TELEMETRY_ENABLED=0
Environment=DO_NOT_TRACK=1
ExecStart=/usr/local/bin/agentsview serve --no-browser --host 127.0.0.1 --port ${ARCHIVE_PORT} --require-auth --no-update-check
Restart=on-failure
RestartSec=5
MemoryHigh=350M
MemoryMax=500M
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/srv/agentsview-data
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

echo "==> tidy job (drops a plain Codex rollout once its compressed twin has arrived)"
cat > /usr/local/bin/atrium-tidy <<'EOF'
#!/bin/sh
find /srv/agent-sessions/*/codex -type f -name 'rollout-*.jsonl' 2>/dev/null | while read -r f; do
  [ -f "$f.zst" ] && rm -f -- "$f"
done
exit 0
EOF
chmod 755 /usr/local/bin/atrium-tidy
cat > /etc/systemd/system/atrium-tidy.service <<'EOF'
[Unit]
Description=Tidy the Atrium session archive
[Service]
Type=oneshot
User=agentsync
ExecStart=/usr/local/bin/atrium-tidy
EOF
cat > /etc/systemd/system/atrium-tidy.timer <<'EOF'
[Unit]
Description=Hourly tidy of the Atrium session archive
[Timer]
OnCalendar=hourly
RandomizedDelaySec=300
Persistent=true
[Install]
WantedBy=timers.target
EOF

echo "==> hub (atrium)"
[ -f /srv/atrium/config.json ] || runuser -u atrium -- /usr/local/bin/atrium init --config /srv/atrium/config.json >/dev/null
python3 - "$HUB_PORT" "$ARCHIVE_PORT" <<'PY'
import json, re, sys
p = "/srv/atrium/config.json"; c = json.load(open(p))
tok = re.search(r'^auth_token\s*=\s*"(.*)"\s*$', open("/srv/agentsview-data/config.toml").read(), re.M).group(1)
c["listen"] = "127.0.0.1:%s" % sys.argv[1]
c["archive_url"] = "http://127.0.0.1:%s" % sys.argv[2]
c["archive_token"] = tok
open(p, "w").write(json.dumps(c, ensure_ascii=False, indent=2))
PY
chown atrium:atrium /srv/atrium/config.json; chmod 600 /srv/atrium/config.json
cat > /etc/systemd/system/atrium.service <<'EOF'
[Unit]
Description=Atrium: one page for all your coding-agent sessions (loopback only)
After=network.target agentsview.service

[Service]
User=atrium
Group=atrium
ExecStart=/usr/local/bin/atrium serve --config /srv/atrium/config.json
Restart=always
RestartSec=3
MemoryHigh=150M
MemoryMax=250M
IPAddressDeny=any
IPAddressAllow=localhost
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadWritePaths=/srv/atrium
LockPersonality=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
EOF

HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/atrium-machine" ] && install -m 755 "$HERE/atrium-machine" /usr/local/bin/atrium-machine

systemctl daemon-reload
systemctl enable --now agentsview atrium atrium-tidy.timer >/dev/null
sleep 2
echo
echo "atrium:     $(systemctl is-active atrium)   health: $(curl -s -m 5 127.0.0.1:${HUB_PORT}/health || echo unreachable)"
echo "agentsview: $(systemctl is-active agentsview)"
echo
echo "Next:"
echo "  1. On each machine:   scripts/machine-install.sh key          (prints a public key)"
echo "  2. Here:              atrium-machine add NAME 'ssh-ed25519 AAAA…'   (prints a runner token)"
echo "  3. On that machine:   scripts/machine-install.sh install --server THIS_HOST --name NAME --token TOKEN"
echo "  4. Sign in:           runuser -u atrium -- atrium login-link --base http://127.0.0.1:13005"
