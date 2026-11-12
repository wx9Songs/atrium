# Atrium 中庭

One page for all your coding-agent sessions, on every machine you use.

[中文说明](README.zh-CN.md)

Claude Code and Codex keep their sessions on the machine where they ran. With a laptop, a second laptop and a couple of servers, your conversations end up scattered, and each client only shows its own. Atrium puts them in one place that works like a normal chat app:

- every session from every machine in one sidebar: a tree of machine, working folder, then sessions newest first (or a flat list by day)
- click one to read its full history, tool calls folded into tidy steps
- type at the bottom to keep working: the message runs on the machine that owns the session, output streams back live, permission requests show up as buttons
- full-text search across everything
- start a new session on any connected machine
- branch off: edit an earlier message, try an answer again, or fork from any reply. Each becomes a new session and the original is left as it was
- a side chat next to the conversation: it knows everything said so far, and nothing asked there is written back
- type `/` for commands: Atrium's own (fork, side chat, rename…) and the slash commands, skills and models your Claude Code install reports
- optionally, a terminal on the session's machine and its files, in a panel next to the conversation: a real shell as if you had SSHed in, a file tree, and a small editor

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

`make app` builds `app/dist/Atrium.app`, a small native window around the page with notifications when a run finishes or needs your confirmation, a dock badge, menu-bar shortcuts and one-click sign-in. See [app/README.md](app/README.md).

## Working in a session

Hover a message to see what you can do with it.

| Do this | What happens |
|---|---|
| **Edit** one of your messages (pencil) | A new session is forked that ends just before that message, and your new text is sent there. |
| **Try again** (under the last reply) | The same, with the message unchanged. |
| **Fork** (under any reply, or the button in the header) | The view is cut back to that point; your next message starts the new session. |
| **Side chat** (`⌘.`) | A panel on the right with a fork of the session as it is now. Ask what you like; the main session never sees it. Side chats are kept with their parent and stay out of the list. |
| Type **`/`** | A menu of commands. Atrium's own run right away. The rest come from the Claude Code CLI on that machine (its built-ins, your skills and project commands) and are sent to it as a message. |
| Pick a **model** and **reasoning effort** (under the message box, or `/model`, `/effort`) | The list is the one the agent's own CLI reports on that machine (Claude Code's model list, Codex's catalog), with the effort levels each model accepts. It is read when the runner connects; "Reload" in the menu reads it again. |
| Send while a run is in flight | The message is queued and goes out when the run ends. |

Forks never touch the original transcript: for Claude Code the runner uses `--resume <id> --fork-session` (plus `--resume-session-at` when the copy should stop early), for Codex `codex exec fork`. Codex can only fork from the end of a session, so editing and trying again are offered for Claude Code sessions only.

A fork is a session like any other, on the same machine and in the same folder. It does not copy or roll back files: both branches work in the same working directory.

### Terminal and files (off unless you turn them on)

The panel on the right has two more tabs for the machine the session lives on:

- **Terminal** (`⌘J`): a login shell on that machine, in the session's folder, attached to a real pseudo-terminal. It is what you would get by SSHing in: your own shell and prompt, colours, `vim`, `htop`, `git add -p`. A message starting with `!` is typed into it. It keeps running when you close the panel or reload the page, and the last screenfuls are kept so you can pick it up again.
- **Files** (`⌘E`): the session's folder as a tree, and a small editor for text files with syntax colours, line numbers and `⌘S`. If the file changed on the machine after you opened it, saving asks before overwriting. Files over 2 MB and binary files are not opened.

Everything travels over the runner's existing connection to the hub, so no extra port or SSH access is needed. That connection is a long poll rather than a socket, so each keystroke makes a round trip through your server: fine for commands and quick edits, noticeably slower than a local terminal.

A runner can normally start `claude` and `codex` and nothing else. To allow these two tabs on a machine, say so in that machine's own `runner.json` and restart the runner:

```json
{ "hub": "…", "token": "…", "allow_shell": true }
```

Without that line the runner refuses, whatever the hub asks for. With it, anyone who can sign in to your Atrium page can run commands and change files on that machine as the runner's user, so turn it on only where you are comfortable with that.

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
| `devstack/` | a local stand-in for everything (made-up sessions, fake `claude` and `codex`) to work on the page without a server |

To try the page on your own computer with nothing installed: `devstack/up.sh seed`, then `cd web && npm install && npx vite`, and open http://127.0.0.1:5199.

## License

MIT
