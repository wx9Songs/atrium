# Installing Atrium

Three parts: the server, each machine, and signing in.

## 1. Build

On any machine with Go 1.22+ and Node 18+:

```bash
make server-linux ARCH=amd64     # → bin/linux-amd64/atrium   (use ARCH=arm64 for an ARM server)
make runners                     # → bin/<os>-<arch>/atrium-runner for Linux and macOS
```

## 2. Server

Copy `bin/linux-amd64/atrium` and the `scripts/` folder to the server, then as root:

```bash
./scripts/server-install.sh --atrium ./atrium
```

This installs, all on loopback:

| Service | Address | Runs as |
|---|---|---|
| `atrium` (hub) | `127.0.0.1:3005` | `atrium` |
| `agentsview` (archive) | `127.0.0.1:8080` | `agentsview` |

and creates the `agentsync` account that machines push to. It adds one file to the SSH daemon's configuration, `/etc/ssh/sshd_config.d/50-atrium-agentsync.conf`, which confines that account to key login and a single port forward.

agentsview is downloaded from its GitHub releases; the script prints the archive's SHA-256 so you can compare it with the release page. To use a binary you fetched and verified yourself, pass `--agentsview PATH`.

Configuration lives in `/srv/atrium/config.json` (secrets inside; mode 600):

| Key | Meaning |
|---|---|
| `listen` | hub address, default `127.0.0.1:3005` |
| `archive_url`, `archive_token` | where agentsview is and its bearer token |
| `machines` | registered machines (hashed runner tokens) |
| `labels` | display names, e.g. `{"laptop": "My MacBook"}` |
| `login_hint` | the command shown on the sign-in page for your setup |

Run the `atrium` admin commands as the `atrium` user (`runuser -u atrium -- atrium …`) so the config keeps its owner.

## 3. Each machine

On the machine, as the user who runs the agents:

```bash
./scripts/machine-install.sh key
```

On the server, with the key it printed:

```bash
atrium-machine add laptop 'ssh-ed25519 AAAA… atrium-laptop' "My MacBook"
```

Back on the machine, with the token that printed:

```bash
./scripts/machine-install.sh install --server my.server --name laptop --token TOKEN \
    --runner bin/darwin-arm64/atrium-runner
```

It installs three background jobs (launchd on macOS, `systemd --user` on Linux, a small supervisor loop where neither exists):

- **push**: transcripts to the server every minute. Only `projects/` for Claude Code and `sessions/`, `archived_sessions/`, `session_index.jsonl` for Codex. Never credentials or settings. Never deletes on the server.
- **tunnel**: `127.0.0.1:13005` on the machine → the hub.
- **runner**: starts `claude` / `codex` for the turns you send from the page. It is launched through your login shell so it has the same `PATH`, proxy settings, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` as your terminal.

The runner can start those two programs in their non-interactive modes and list directories for the folder picker. It has no general "run a command" ability, but an agent with permissive settings can of course do anything you could.

## 4. Sign in

There are no passwords. The server mints a one-time link (valid 15 minutes, usable once); opening it sets a cookie that lasts 180 days.

```bash
ssh root@my.server runuser -u atrium -- atrium login-link --base http://127.0.0.1:13005
```

Open the printed link in the browser on a machine that has the tunnel. A convenient wrapper:

```bash
open "$(ssh root@my.server runuser -u atrium -- atrium login-link --base http://127.0.0.1:13005)"
```

Put that command in `login_hint` and the sign-in page will show it; the desktop app can run it for you.

## Access from anywhere (optional)

Out of the box the page is reachable only from machines that have the tunnel. To use it from a phone or any network, put a TLS reverse proxy (Caddy, nginx) in front of `127.0.0.1:3005` on a domain you own, ideally behind a second login such as an auth proxy, and pass `--base https://your.domain` to `login-link`. Atrium sets the `Secure` cookie flag when it sees `X-Forwarded-Proto: https`.

## Updating

Rebuild, replace `/usr/local/bin/atrium` and `systemctl restart atrium`. Open pages reconnect by themselves. For a runner, replace `~/.local/bin/atrium-runner` and restart the runner job.

## Removing

- Machine: `./scripts/machine-install.sh uninstall`
- Server: `atrium-machine remove NAME` revokes one machine. To remove everything, disable the `atrium`, `agentsview` and `atrium-tidy.timer` units and delete `/srv/atrium`, `/srv/agentsview-data`, `/srv/agent-sessions` and `/etc/ssh/sshd_config.d/50-atrium-agentsync.conf`.
