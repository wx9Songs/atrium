#!/usr/bin/env bash
# Connect one machine (macOS or Linux) to an Atrium server. Run as the user who uses
# Claude Code / Codex on this machine. No root needed.
#
#   machine-install.sh key
#       Creates a dedicated SSH key and prints its public half. Give that to the server:
#         atrium-machine add NAME '<public key>'      (prints a runner token)
#
#   machine-install.sh install --server HOST --name NAME --token TOKEN \
#                              [--ssh-port 22] [--runner ./atrium-runner]
#       Installs three small background jobs:
#         push    copies new session transcripts to the server (rsync over SSH, every minute)
#         tunnel  keeps 127.0.0.1:13005 on this machine connected to the hub on the server
#         runner  lets the Atrium page start or continue sessions here
#
#   machine-install.sh uninstall
#
# The key can only write into this machine's own folder on the server and open that one
# tunnel. Credentials, settings and anything but transcripts never leave the machine.
set -euo pipefail

BASE="$HOME/.local/share/atrium"
KEY="$HOME/.ssh/atrium_sync_ed25519"
LOCAL_PORT=13005
HUB_PORT=3005

find_rsync() {
  for r in /opt/homebrew/bin/rsync /usr/local/bin/rsync "$(command -v rsync || true)"; do
    [ -x "$r" ] || continue
    # macOS ships "openrsync", which cannot talk to the server's restricted rsync.
    if "$r" --version 2>&1 | head -1 | grep -q '^rsync  *version 3'; then echo "$r"; return 0; fi
  done
  return 1
}

cmd="${1:-}"; shift || true
case "$cmd" in
key)
  mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
  [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "atrium-$(hostname -s)" -f "$KEY"
  echo "Public key for this machine (not a secret):"
  cat "$KEY.pub"
  ;;

install)
  SERVER=""; NAME=""; TOKEN=""; SSH_PORT=22; RUNNER=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --server) SERVER="$2"; shift 2 ;;
      --name) NAME="$2"; shift 2 ;;
      --token) TOKEN="$2"; shift 2 ;;
      --ssh-port) SSH_PORT="$2"; shift 2 ;;
      --runner) RUNNER="$2"; shift 2 ;;
      *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
  done
  [ -n "$SERVER" ] && [ -n "$NAME" ] && [ -n "$TOKEN" ] || { echo "--server, --name and --token are required" >&2; exit 2; }
  [ -f "$KEY" ] || { echo "run '$0 key' first" >&2; exit 1; }
  RSYNC="$(find_rsync)" || { echo "rsync 3.x is required (macOS: brew install rsync; Linux: install the rsync package)" >&2; exit 1; }
  if [ -z "$RUNNER" ]; then RUNNER="$(cd "$(dirname "$0")/.." && pwd)/bin/atrium-runner"; fi
  [ -f "$RUNNER" ] || { echo "runner binary not found at $RUNNER (build it with 'make runner' or pass --runner)" >&2; exit 1; }

  mkdir -p "$BASE/log" "$HOME/.config/atrium" "$HOME/.local/bin"
  chmod 700 "$BASE"
  install -m 755 "$RUNNER" "$HOME/.local/bin/atrium-runner"

  # Remember the server's host key on first contact; refuse if it ever changes.
  SSHO="-i $KEY -p $SSH_PORT -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=$BASE/known_hosts -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=20 -o ServerAliveCountMax=3"

  cat > "$BASE/push.sh" <<EOF
#!/bin/sh
# Pushes Claude Code and Codex transcripts to the Atrium server. Never deletes anything there.
DEST="agentsync@$SERVER"
R="$RSYNC"
E="ssh $SSHO -o ControlMaster=auto -o ControlPath=$BASE/cm-%C -o ControlPersist=5m"
OPTS="-az --timeout=60 --delay-updates --chmod=D750,F640"
CLAUDE_DIR="\${CLAUDE_CONFIG_DIR:-\$HOME/.claude}"
CODEX_DIR="\${CODEX_HOME:-\$HOME/.codex}"
rc=0
if [ -d "\$CLAUDE_DIR/projects" ]; then
  \$R \$OPTS -e "\$E" "\$CLAUDE_DIR/projects/" "\$DEST:claude/projects/" || rc=\$?
fi
# Transcripts and the title index only: auth.json, config and databases are never sent.
if [ -d "\$CODEX_DIR" ]; then
  \$R \$OPTS --include='/sessions/***' --include='/archived_sessions/***' --include='/session_index.jsonl' --exclude='*' \\
    -e "\$E" "\$CODEX_DIR/" "\$DEST:codex/" || rc=\$?
fi
exit \$rc
EOF
  cat > "$BASE/tunnel.sh" <<EOF
#!/bin/sh
# Keeps this machine's 127.0.0.1:$LOCAL_PORT connected to the hub on the server.
while true; do
  ssh -N $SSHO -o ControlMaster=no -o ControlPath=none -o ExitOnForwardFailure=yes \\
    -L 127.0.0.1:$LOCAL_PORT:127.0.0.1:$HUB_PORT "agentsync@$SERVER"
  sleep 10
done
EOF
  cat > "$BASE/pushloop.sh" <<EOF
#!/bin/sh
while true; do "$BASE/push.sh" >>"$BASE/log/push.log" 2>&1; sleep 60; done
EOF
  # The runner starts from a login shell so it sees the same PATH and settings as your terminal.
  cat > "$BASE/runner.sh" <<EOF
#!/bin/sh
exec "\${SHELL:-/bin/sh}" -lc 'exec "\$HOME/.local/bin/atrium-runner"'
EOF
  chmod 755 "$BASE"/*.sh
  umask 077
  cat > "$HOME/.config/atrium/runner.json" <<EOF
{ "hub": "http://127.0.0.1:$LOCAL_PORT", "token": "$TOKEN", "sync_cmd": "$BASE/push.sh" }
EOF
  umask 022

  echo "==> first sync (this checks the key and the connection)"
  "$BASE/push.sh" && echo "    ok" || { echo "    sync failed: check that the server ran 'atrium-machine add $NAME …' with this machine's key" >&2; exit 1; }

  if [ "$(uname)" = Darwin ]; then
    LA="$HOME/Library/LaunchAgents"; mkdir -p "$LA"
    for job in push:pushloop tunnel:tunnel runner:runner; do
      label="dev.atrium.${job%%:*}"; script="$BASE/${job##*:}.sh"
      cat > "$LA/$label.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$script</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$BASE/log/${job%%:*}.log</string>
  <key>StandardErrorPath</key><string>$BASE/log/${job%%:*}.log</string>
</dict></plist>
EOF
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$LA/$label.plist"
    done
  elif systemctl --user show-environment >/dev/null 2>&1; then
    UD="$HOME/.config/systemd/user"; mkdir -p "$UD"
    for job in push:pushloop tunnel:tunnel runner:runner; do
      cat > "$UD/atrium-${job%%:*}.service" <<EOF
[Unit]
Description=Atrium ${job%%:*}
[Service]
ExecStart=$BASE/${job##*:}.sh
Restart=always
RestartSec=10
[Install]
WantedBy=default.target
EOF
    done
    systemctl --user daemon-reload
    systemctl --user enable --now atrium-push atrium-tunnel atrium-runner >/dev/null
    echo "    tip: 'loginctl enable-linger $USER' keeps these running while you are logged out"
  else
    # No service manager (containers): one supervisor keeps the three loops alive.
    cat > "$BASE/supervise.sh" <<EOF
#!/usr/bin/env bash
exec 9>"$BASE/supervise.lock"; flock -n 9 || exit 0
"$BASE/tunnel.sh" >>"$BASE/log/tunnel.log" 2>&1 9>&- &
( while true; do pgrep -f "[a]trium-runner" >/dev/null || "$BASE/runner.sh" >>"$BASE/log/runner.log" 2>&1 </dev/null & sleep 30; done ) 9>&- &
while true; do "$BASE/push.sh" >>"$BASE/log/push.log" 2>&1 9>&-; sleep 60 9>&-; done
EOF
    chmod 755 "$BASE/supervise.sh"
    setsid nohup "$BASE/supervise.sh" >>"$BASE/log/supervise.log" 2>&1 </dev/null &
    echo "    no systemd/launchd here: started $BASE/supervise.sh in the background."
    echo "    run it again after a reboot (for example from your shell profile); it is safe to start twice."
  fi

  # Claude Code deletes transcripts after 30 days by default; keep them.
  S="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
  if command -v python3 >/dev/null && [ -d "$(dirname "$S")" ]; then
    python3 - "$S" <<'PY' || true
import json, os, sys
p = sys.argv[1]
s = json.load(open(p)) if os.path.exists(p) else {}
if "cleanupPeriodDays" not in s:
    s["cleanupPeriodDays"] = 36500
    json.dump(s, open(p, "w"), indent=2, ensure_ascii=False)
PY
  fi
  sleep 3
  echo "hub through the tunnel: $(curl -s -m 6 "http://127.0.0.1:$LOCAL_PORT/health" || echo 'not reachable yet (give it a few seconds)')"
  echo "Done. '$NAME' should show up as online on the Atrium page: http://127.0.0.1:$LOCAL_PORT"
  ;;

uninstall)
  if [ "$(uname)" = Darwin ]; then
    for j in push tunnel runner; do launchctl bootout "gui/$(id -u)/dev.atrium.$j" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/dev.atrium.$j.plist"; done
  elif systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user disable --now atrium-push atrium-tunnel atrium-runner 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user"/atrium-{push,tunnel,runner}.service
  else
    pkill -f "$BASE/supervise.sh" 2>/dev/null || true; pkill -f "[a]trium-runner" 2>/dev/null || true; pkill -f "$BASE/tunnel.sh" 2>/dev/null || true
  fi
  rm -rf "$BASE" "$HOME/.config/atrium" "$HOME/.local/bin/atrium-runner"
  echo "Removed. The SSH key $KEY was kept; delete it yourself if you no longer need it."
  ;;

*) sed -n '2,19p' "$0"; exit 2 ;;
esac
