# Atrium for macOS

A small native app around the Atrium page.

- **Notifications** when a run finishes while you are elsewhere, or needs your confirmation. Clicking one opens that session.
- **Dock badge** with the number of runs waiting for you.
- **Sign-in without the terminal.** Put the command that prints a sign-in link into Settings (⌘,); the app runs it when you are signed out and opens the link.
- Its own window, remembered size, ⌘R to reload, ⌘+ / ⌘- to zoom.
- Menu-bar commands for the page: New Session (⌘N), Search (⌘K), Fork from Here (⇧⌘F), Toggle Sidebar (⌘B), Side Chat (⌘.), Terminal (⌘J), Files (⌘E).
- The page's header is the title bar: drag it to move the window, double-click it to zoom.

## Build

```bash
make app          # or: ./app/build.sh
open app/dist/Atrium.app
```

To try a build next to the installed app without touching its settings, give it another name and identifier: `APP_NAME="Atrium Dev" BUNDLE_ID=dev.atrium.app.dev ./app/build.sh`.

Needs the Xcode command line tools. The result is signed ad hoc for your own machine; it is not notarised, so on another Mac the first launch needs right-click → Open.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Server address | `http://127.0.0.1:13005` | where the page is (the tunnel address, or your HTTPS domain) |
| Sign-in command | empty | a shell command that prints a one-time link, e.g. `ssh root@my.server runuser -u atrium -- atrium login-link --base http://127.0.0.1:13005` |

They can also be set from the terminal:

```bash
defaults write dev.atrium.app serverURL "https://atrium.example.com"
defaults write dev.atrium.app signInCommand "ssh root@my.server runuser -u atrium -- atrium login-link --base https://atrium.example.com"
```
