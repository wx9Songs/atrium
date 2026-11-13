#!/usr/bin/env bash
# Atrium on one computer, with no server (macOS or Linux). Run as yourself; no root needed.
#
# Everything runs on this computer and listens on loopback only:
#   archive  agentsview, reading this computer's own Claude Code and Codex transcripts
#   hub      the page and the control endpoint                http://127.0.0.1:13005
#   runner   starts claude / codex for the turns you send from the page
#
#   local-install.sh install [--name NAME] [--label "My Mac"] [--port 13005]
#                            [--atrium ./bin/atrium] [--runner ./bin/atrium-runner]
#                            [--agentsview PATH] [--no-service]
#       Run it from an unpacked release archive, or after `make` in a checkout: it looks for
#       the binaries in ../bin. agentsview is downloaded from its GitHub releases unless
#       it is already installed or you pass --agentsview. With --no-service nothing is
#       registered with launchd / systemd; start it yourself with `local-install.sh run`.
#   local-install.sh link        print a one-time sign-in link and open it
#   local-install.sh status      what is running
#   local-install.sh run         run the three parts in this terminal (Ctrl-C stops them)
#   local-install.sh uninstall   remove the jobs, binaries and config (transcripts are untouched)
#
# Safe to run `install` again: the existing config, secrets and sign-in stay as they are.
# To add more machines later you need a computer they can all reach: see docs/install.md.
set -euo pipefail

BASE="$HOME/.local/share/atrium"
LOCAL="$BASE/local"
BIN="$HOME/.local/bin"
RUNNER_CFG="$HOME/.config/atrium/runner.json"
AGENTSVIEW_VERSION="${AGENTSVIEW_VERSION:-0.47.0}"
JOBS="archive hub runner"

hub_port() { sed -n 's/.*"listen": *"[^"]*:\([0-9]*\)".*/\1/p' "$LOCAL/config.json" 2>/dev/null | head -1; }
base_url() { echo "http://127.0.0.1:$(hub_port)"; }
service_kind() {
  if [ "$(uname)" = Darwin ]; then echo launchd
  elif systemctl --user show-environment >/dev/null 2>&1; then echo systemd
  else echo none; fi
}
stop_jobs() {
  case "$(service_kind)" in
    launchd) for j in $JOBS; do launchctl bootout "gui/$(id -u)/dev.atrium.$j" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/dev.atrium.$j.plist"; done ;;
    systemd) for j in $JOBS; do systemctl --user disable --now "atrium-$j" 2>/dev/null || true; rm -f "$HOME/.config/systemd/user/atrium-$j.service"; done
             systemctl --user daemon-reload 2>/dev/null || true ;;
  esac
}

cmd="${1:-}"; shift || true
case "$cmd" in
install)
  NAME=""; LABEL=""; PORT=13005; ATRIUM=""; RUNNER=""; AGENTSVIEW=""; SERVICE=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) NAME="$2"; shift 2 ;;
      --label) LABEL="$2"; shift 2 ;;
      --port) PORT="$2"; shift 2 ;;
      --atrium) ATRIUM="$2"; shift 2 ;;
      --runner) RUNNER="$2"; shift 2 ;;
      --agentsview) AGENTSVIEW="$2"; shift 2 ;;
      --no-service) SERVICE=0; shift ;;
      *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
  done
  REPO="$(cd "$(dirname "$0")/.." && pwd)"
  [ -n "$ATRIUM" ] || ATRIUM="$REPO/bin/atrium"
  [ -n "$RUNNER" ] || RUNNER="$REPO/bin/atrium-runner"
  [ -f "$ATRIUM" ] || { echo "hub binary not found at $ATRIUM (use a release archive, build with 'make', or pass --atrium)" >&2; exit 1; }
  [ -f "$RUNNER" ] || { echo "runner binary not found at $RUNNER (use a release archive, build with 'make', or pass --runner)" >&2; exit 1; }
  if [ -f "$BASE/push.sh" ]; then
    echo "This computer is already connected to an Atrium server (machine-install.sh)." >&2
    echo "Run 'scripts/machine-install.sh uninstall' first if you want the one-computer setup instead." >&2
    exit 1
  fi
  echo "$PORT" | grep -Eq '^[0-9]+$' || { echo "--port must be a number" >&2; exit 2; }
  ARCHIVE_PORT=$((PORT + 75))
  [ -n "$NAME" ] || NAME="$(hostname -s 2>/dev/null | tr 'A-Z' 'a-z' | tr -c 'a-z0-9\n' '-' | sed 's/^-*//; s/-*$//' | cut -c1-30)"
  [ -n "$NAME" ] || NAME=local
  echo "$NAME" | grep -Eq '^[a-z0-9][a-z0-9-]{0,30}$' || { echo "--name: lowercase letters, digits and dashes" >&2; exit 2; }
  if [ -z "$LABEL" ]; then
    LABEL="$(scutil --get ComputerName 2>/dev/null || hostname -s 2>/dev/null || echo "$NAME")"
  fi

  echo "==> binaries"
  mkdir -p "$BIN" "$LOCAL/archive" "$LOCAL/log" "$HOME/.config/atrium"
  chmod 700 "$BASE" "$LOCAL"
  [ -f "$LOCAL/config.json" ] && [ "$SERVICE" = 1 ] && stop_jobs   # replacing a running binary
  install -m 755 "$ATRIUM" "$BIN/atrium"
  install -m 755 "$RUNNER" "$BIN/atrium-runner"
  if [ -n "$AGENTSVIEW" ]; then
    install -m 755 "$AGENTSVIEW" "$BIN/agentsview"
  elif [ ! -x "$BIN/agentsview" ]; then
    if command -v agentsview >/dev/null 2>&1; then
      install -m 755 "$(command -v agentsview)" "$BIN/agentsview"
    else
      case "$(uname -s)" in Darwin) O=darwin ;; Linux) O=linux ;; *) echo "unsupported system: $(uname -s)" >&2; exit 1 ;; esac
      case "$(uname -m)" in x86_64|amd64) A=amd64 ;; aarch64|arm64) A=arm64 ;; *) echo "unsupported CPU: $(uname -m)" >&2; exit 1 ;; esac
      URL="https://github.com/kenn-io/agentsview/releases/download/v${AGENTSVIEW_VERSION}/agentsview_${AGENTSVIEW_VERSION}_${O}_${A}.tar.gz"
      T="$(mktemp -d)"
      echo "    downloading $URL (about 70 MB)"
      curl -fL --retry 3 --progress-bar -o "$T/a.tgz" "$URL"
      SUM="$( (sha256sum "$T/a.tgz" 2>/dev/null || shasum -a 256 "$T/a.tgz") | cut -d' ' -f1)"
      # The release publishes a list of checksums next to the files; refuse a download that does not match it.
      WANT="$(curl -fsSL --retry 2 "${URL%/*}/SHA256SUMS" 2>/dev/null | awk -v f="${URL##*/}" '$2 == f { print $1 }' || true)"
      if [ -n "$WANT" ] && [ "$SUM" != "$WANT" ]; then
        echo "    checksum mismatch: got $SUM, the release lists $WANT. Nothing was installed." >&2
        rm -rf "$T"; exit 1
      elif [ -n "$WANT" ]; then
        echo "    sha256 $SUM matches the release's SHA256SUMS"
      else
        echo "    sha256: $SUM"
        echo "    the release's checksum list could not be read; compare this with the agentsview release page."
      fi
      tar -xzf "$T/a.tgz" -C "$T"
      install -m 755 "$(find "$T" -type f -name agentsview | head -1)" "$BIN/agentsview"
      rm -rf "$T"
    fi
  fi

  echo "==> archive: this computer's own transcripts"
  CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
  ARC="$LOCAL/archive/config.toml"
  if [ -f "$ARC" ]; then
    ARC_TOKEN="$(sed -n 's/^auth_token *= *"\(.*\)" *$/\1/p' "$ARC" | head -1)"
  else
    ARC_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '=+/\n' | cut -c1-43)"
  fi
  # Written again on every install, so an agent installed later is picked up.
  umask 077
  {
    echo "auth_token = \"$ARC_TOKEN\""
    echo "disable_update_check = true"
    echo "local_machine_name = \"archive\""
    echo "require_auth = true"
    echo
    echo "[agents]"
    echo "  [agents.claude]"
    echo "    dirs = []"
    echo "  [agents.codex]"
    echo "    dirs = []"
    if [ -d "$CODEX_DIR" ]; then echo "    homes = [\"$CODEX_DIR\"]"; else echo "    homes = []"; fi
    if [ -d "$CLAUDE_DIR/projects" ]; then
      printf '\n[[session_sources]]\n  agent = "claude"\n  dir = "%s"\n  machine = "%s"\n' "$CLAUDE_DIR/projects" "$NAME"
      echo "    Claude Code: $CLAUDE_DIR/projects" >&2
    fi
    for sub in sessions archived_sessions; do
      if [ -d "$CODEX_DIR/$sub" ]; then
        printf '\n[[session_sources]]\n  agent = "codex"\n  dir = "%s"\n  machine = "%s"\n' "$CODEX_DIR/$sub" "$NAME"
        echo "    Codex: $CODEX_DIR/$sub" >&2
      fi
    done
  } > "$ARC"
  grep -q session_sources "$ARC" || echo "    no transcripts found yet: run claude or codex once, then run install again"

  echo "==> hub and runner"
  if [ ! -f "$LOCAL/config.json" ]; then
    "$BIN/atrium" init --config "$LOCAL/config.json" --listen "127.0.0.1:$PORT" \
      --archive-url "http://127.0.0.1:$ARCHIVE_PORT" --archive-token "$ARC_TOKEN" --mode local \
      --login-hint "~/.local/bin/atrium login-link --base http://127.0.0.1:$PORT" >/dev/null
    rm -f "$RUNNER_CFG"
  fi
  PORT="$(hub_port)"; ARCHIVE_PORT=$((PORT + 75))
  if [ ! -f "$RUNNER_CFG" ]; then
    TOKEN="$("$BIN/atrium" add-machine --config "$LOCAL/config.json" --label "$LABEL" "$NAME")"
    printf '{ "hub": "http://127.0.0.1:%s", "token": "%s" }\n' "$PORT" "$TOKEN" > "$RUNNER_CFG"
  fi
  umask 022

  cat > "$LOCAL/archive.sh" <<EOF
#!/bin/sh
# The archive keeps its own files in $LOCAL/archive and reads only the folders listed in config.toml.
export AGENTSVIEW_DATA_DIR="$LOCAL/archive" HOME="$LOCAL/archive" AGENTSVIEW_TELEMETRY_ENABLED=0 DO_NOT_TRACK=1
exec "$BIN/agentsview" serve --no-browser --host 127.0.0.1 --port $ARCHIVE_PORT --require-auth --no-update-check
EOF
  cat > "$LOCAL/hub.sh" <<EOF
#!/bin/sh
exec "$BIN/atrium" serve --config "$LOCAL/config.json"
EOF
  # The runner starts from a login shell so it sees the same PATH and settings as your terminal.
  cat > "$LOCAL/runner.sh" <<EOF
#!/bin/sh
exec "\${SHELL:-/bin/sh}" -lc 'exec "$BIN/atrium-runner" --config "$RUNNER_CFG"'
EOF
  chmod 755 "$LOCAL"/*.sh

  KIND="$(service_kind)"; [ "$SERVICE" = 1 ] || KIND=none
  case "$KIND" in
  launchd)
    LA="$HOME/Library/LaunchAgents"; mkdir -p "$LA"
    for j in $JOBS; do
      label="dev.atrium.$j"
      cat > "$LA/$label.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$LOCAL/$j.sh</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOCAL/log/$j.log</string>
  <key>StandardErrorPath</key><string>$LOCAL/log/$j.log</string>
</dict></plist>
EOF
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$LA/$label.plist"
    done ;;
  systemd)
    UD="$HOME/.config/systemd/user"; mkdir -p "$UD"
    for j in $JOBS; do
      cat > "$UD/atrium-$j.service" <<EOF
[Unit]
Description=Atrium $j (one-computer setup)
[Service]
ExecStart=$LOCAL/$j.sh
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
EOF
    done
    systemctl --user daemon-reload
    systemctl --user enable --now atrium-archive atrium-hub atrium-runner >/dev/null
    echo "    tip: 'loginctl enable-linger $USER' keeps these running while you are logged out" ;;
  none)
    echo
    echo "Installed, nothing started. Start it with:  $0 run"
    echo "Then sign in with:                          $0 link"
    exit 0 ;;
  esac

  # Claude Code deletes transcripts after 30 days by default; keep them.
  S="$CLAUDE_DIR/settings.json"
  if command -v python3 >/dev/null 2>&1 && [ -d "$CLAUDE_DIR" ]; then
    python3 - "$S" <<'PY' || true
import json, os, sys
p = sys.argv[1]
s = json.load(open(p)) if os.path.exists(p) else {}
if "cleanupPeriodDays" not in s:
    s["cleanupPeriodDays"] = 36500
    json.dump(s, open(p, "w"), indent=2, ensure_ascii=False)
PY
  fi

  printf '==> waiting for the hub'
  ok=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if [ "$(curl -s -m 2 "http://127.0.0.1:$PORT/health" 2>/dev/null)" = ok ]; then ok=1; break; fi
    printf '.'; sleep 1
  done
  echo
  if [ -z "$ok" ]; then
    echo "The hub did not answer on http://127.0.0.1:$PORT. Look at $LOCAL/log/hub.log" >&2
    exit 1
  fi
  echo "Atrium is running on this computer: http://127.0.0.1:$PORT"
  echo "Sign in (one-time link, valid 15 minutes; the cookie lasts 180 days):"
  echo "  $("$BIN/atrium" login-link --config "$LOCAL/config.json" --base "http://127.0.0.1:$PORT")"
  echo "The page opens with a short guide that checks this computer is connected."
  ;;

link)
  [ -f "$LOCAL/config.json" ] || { echo "not installed: run '$0 install' first" >&2; exit 1; }
  URL="$("$BIN/atrium" login-link --config "$LOCAL/config.json" --base "$(base_url)")"
  echo "$URL"
  if [ "${1:-}" != --print ]; then
    if command -v open >/dev/null 2>&1; then open "$URL"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true; fi
  fi
  ;;

status)
  [ -f "$LOCAL/config.json" ] || { echo "not installed"; exit 1; }
  echo "page:    $(base_url)   hub: $(curl -s -m 3 "$(base_url)/health" 2>/dev/null || echo 'not answering')"
  for j in $JOBS; do
    case "$j" in archive) pat="[a]gentsview serve" ;; hub) pat="[a]trium serve" ;; *) pat="[a]trium-runner" ;; esac
    if pgrep -f "$pat" >/dev/null 2>&1; then echo "$j:  running"; else echo "$j:  not running   (log: $LOCAL/log/$j.log)"; fi
  done
  ;;

run)
  [ -f "$LOCAL/config.json" ] || { echo "not installed: run '$0 install --no-service' first" >&2; exit 1; }
  trap 'kill 0' INT TERM EXIT
  for j in $JOBS; do "$LOCAL/$j.sh" >>"$LOCAL/log/$j.log" 2>&1 & done
  echo "Atrium is running: $(base_url)   (logs in $LOCAL/log, Ctrl-C to stop)"
  wait
  ;;

uninstall)
  stop_jobs
  rm -rf "$LOCAL"
  rm -f "$RUNNER_CFG" "$BIN/atrium" "$BIN/atrium-runner" "$BIN/agentsview"
  rmdir "$HOME/.config/atrium" "$BASE" 2>/dev/null || true
  echo "Removed. Your Claude Code and Codex transcripts were not touched."
  ;;

*) sed -n '2,21p' "$0"; exit 2 ;;
esac
