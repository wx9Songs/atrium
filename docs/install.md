# Installing Atrium

Pick the layout that fits:

| You have | Use |
|---|---|
| one computer | [One computer, no server](#one-computer-no-server) |
| several machines and a cloud server | [Several machines](#several-machines): the rest of this page |
| several machines and no cloud server | the same, with [a computer of your own as the server](#without-a-cloud-server) |

Whichever you pick, the page opens on a setup guide the first time. It shows the commands for each machine and checks live that every machine is connected. It stays in the ⋯ menu at the bottom of the sidebar.

## One computer, no server

Everything runs on your own Mac or Linux desktop and listens on loopback only: the archive (agentsview, reading this computer's own transcripts where they already are), the hub (the page) and the runner. There is no push, no tunnel and no SSH.

```bash
make                                   # builds bin/atrium and bin/atrium-runner
./scripts/local-install.sh install     # installs and starts the three parts
./scripts/local-install.sh link        # opens the page, signed in
```

What `install` does:

- copies `atrium`, `atrium-runner` and `agentsview` to `~/.local/bin`. agentsview is downloaded from its GitHub releases (about 70 MB) and checked against the checksum list published with that release; a download that does not match is refused. To use a copy you fetched and verified yourself, pass `--agentsview PATH`.
- writes its config under `~/.local/share/atrium/local` and the runner's under `~/.config/atrium/runner.json`.
- registers three background jobs: launchd agents on macOS, `systemd --user` units on Linux. Where neither exists, or with `--no-service`, nothing is registered and `./scripts/local-install.sh run` runs the three parts in a terminal.

The page is at `http://127.0.0.1:13005` (`--port` changes it; the archive takes that port plus 75). Sign-in is the same one-time link as on a server: `./scripts/local-install.sh link` prints one and opens it.

| Command | What it does |
|---|---|
| `local-install.sh status` | what is running |
| `local-install.sh install` again | updates the binaries after a `make`; config, secrets and sign-in stay |
| `local-install.sh uninstall` | removes the jobs, binaries and config. Your transcripts are not touched |

This layout is for the one computer. A computer already connected to a server with `machine-install.sh` cannot also run it. To bring in more machines, move to the layout below.

## Without a cloud server

"Server" here means one computer that every machine can reach by SSH and that stays on. Nothing in the scripts needs a public address or a cloud provider:

- **A computer at home**: a mini PC, a NAS that runs Linux, a Raspberry Pi (`make server-linux ARCH=arm64`). Machines on the same network use its LAN address as `--server`.
- **Machines on different networks**: put them and the server on a private network such as Tailscale or WireGuard and use the server's address on that network as `--server`. The tunnel and the push then travel inside it.

The server still needs Linux with systemd and root access, because the install script creates locked-down system accounts and services. Follow [Several machines](#several-machines) exactly as written; only the address changes.

## Several machines

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

## Checking that it works

Open the setup guide (it opens by itself the first time; later it is under ⋯ at the bottom of the sidebar). For each registered machine it shows, live:

| Check | If it is not green |
|---|---|
| Runner connected | The runner job is not running on that machine, or its tunnel is down. Look at `~/.local/share/atrium/log/runner.log` and `tunnel.log` there. |
| Found Claude Code / Codex | The runner starts from your login shell. Make sure `claude` or `codex` runs when you open a new terminal, then restart the runner. |
| History arrived | Nothing has been pushed yet. New sessions appear within about a minute; `~/.local/share/atrium/log/push.log` shows the last push. |

## Updating

Rebuild, replace `/usr/local/bin/atrium` and `systemctl restart atrium`. Open pages reconnect by themselves. For a runner, replace `~/.local/bin/atrium-runner` and restart the runner job.

## Removing

- Machine: `./scripts/machine-install.sh uninstall`
- Server: `atrium-machine remove NAME` revokes one machine. To remove everything, disable the `atrium`, `agentsview` and `atrium-tidy.timer` units and delete `/srv/atrium`, `/srv/agentsview-data`, `/srv/agent-sessions` and `/etc/ssh/sshd_config.d/50-atrium-agentsync.conf`.
