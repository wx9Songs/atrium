# Atrium 中庭

One page for all your coding-agent sessions, on every machine you use.

[中文说明](README.zh-CN.md)

Claude Code and Codex keep their sessions on the machine where they ran. With a laptop, a second laptop and a couple of servers, your conversations end up scattered, and each client only shows its own. Atrium puts them in one place that works like a normal chat app:

- a list of every session from every machine, grouped by day or by project
- click one to read its full history, tool calls folded into tidy steps
- type at the bottom to keep working: the message runs on the machine that owns the session, output streams back live, permission requests show up as buttons
- full-text search across everything
- start a new session on any connected machine

It is self-hosted and for one person: your server, your machines, your transcripts.

The page and the desktop app come in English and Chinese. The page follows the browser's language on first visit; switch any time from the ⋯ menu at the bottom of the sidebar. The desktop app's menus follow the system language.

> **Status: early.** It runs the author's daily setup (two Macs, two Linux containers, one small VPS). The install scripts are derived from that working deployment but have not yet been exercised on a clean server. The interface is available in English and Chinese.

## How it works

```
 each machine                                your server (loopback only)
┌────────────────────────┐   rsync over SSH  ┌──────────────────────────────┐
│ push    transcripts ───┼──────────────────▶│ /srv/agent-sessions/<name>/  │
│                        │                   │        │                     │
│ tunnel  127.0.0.1:13005┼──── SSH -L ──────▶│ agentsview  (parses, indexes)│
│                        │                   │        │                     │
│ runner  starts claude/ │◀── long-poll ────▶│ atrium   (page + control)    │
│         codex per turn │                   └──────────────────────────────┘
└────────────────────────┘                     browser → http://127.0.0.1:13005
```

- **History** comes from the raw transcript files each machine pushes. [agentsview](https://github.com/kenn-io/agentsview) parses and indexes them; Atrium reads its API.
- **Control** is a small runner on each machine. For every message you send it starts `claude -p --resume <id>` or `codex exec resume <id>` in the session's own directory, so the turn is appended to the same native transcript. Open the session later in the terminal or the desktop client and it is there.
- **Nothing listens on the internet.** The hub and the archive bind to loopback. Machines reach the hub through an SSH tunnel made with a key that can do exactly two things: write into its own folder, and open that tunnel.

## Requirements

- A Linux server with systemd you can SSH into as root (1 GB RAM is enough).
- On each machine: `claude` and/or `codex` installed and signed in, `ssh`, and rsync 3.x (macOS ships an incompatible one: `brew install rsync`).
- To build: Go 1.22+ and Node 18+.

## Install

See **[docs/install.md](docs/install.md)** for the full walk-through. In short:

```bash
make server-linux runners          # build
# on the server (as root)
./scripts/server-install.sh --atrium ./atrium
# on each machine
./scripts/machine-install.sh key                      # prints a public key
# on the server
atrium-machine add laptop 'ssh-ed25519 AAAA…'         # prints a runner token
# back on the machine
./scripts/machine-install.sh install --server my.server --name laptop --token …
# sign in (one-time link, cookie lasts 180 days)
ssh root@my.server runuser -u atrium -- atrium login-link --base http://127.0.0.1:13005
```

## Desktop app (macOS)

`make app` builds `app/dist/Atrium.app`, a small native window around the page with notifications when a run finishes or needs your confirmation, a dock badge, and one-click sign-in. See [app/README.md](app/README.md).

## Things to know

- **One writer per session.** If a session is running in a terminal or desktop client, stop it there before sending from Atrium, or the two will interleave in one transcript. Atrium warns when a session was updated elsewhere moments ago.
- **Other clients do not refresh live.** A message sent from Atrium is in the transcript immediately, but an already-open desktop client shows it only after a restart.
- **Sessions created elsewhere appear after about a minute** (the push interval).
- **Permissions** default to whatever the machine's own settings say. Pick "ask me" in the message box to confirm each action from the page.
- **Your transcripts are stored in plain text on your server.** They can contain secrets you pasted or the agent printed. Treat the server accordingly.

## Layout

| Path | What |
|---|---|
| `cmd/atrium` | the hub: API, auth, runner endpoint, embedded web page |
| `cmd/atrium-runner` | the per-machine runner |
| `web/` | the page (React + Vite) |
| `app/` | macOS desktop app (Swift) |
| `scripts/` | server and machine install scripts |

## License

MIT
