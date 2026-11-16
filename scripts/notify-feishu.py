#!/usr/bin/env python3
"""Feishu/Lark for Atrium's notifications: cards with buttons, sent with lark-cli.

For a hub that is kept off the network (as the systemd unit in the setup guide
keeps it): the hub leaves each notification as a file, this script sends it as
a card from your bot, and a button you press, or what you write back to the
bot, is appended to a file the hub follows.

Run it as its own service, with network access and lark-cli configured for the
bot (lark-cli config init), and with
  ATRIUM_NOTIFY_DIR   a folder both this script and the hub can write to
  FEISHU_USER_ID      your open_id (ou_...): who gets the messages, and the
                      only one whose buttons and replies count

The hub's side, in its config.json (with the same folder):
  "notify": {
    "command": ["sh", "-c", "f=\"$0/out/$(date +%s)-$$\"; printf %s \"$ATRIUM_JSON\" > \"$f.tmp\" && mv \"$f.tmp\" \"$f.msg\"", "/srv/atrium/notify"],
    "replies": ["tail", "-n0", "-F", "/srv/atrium/notify/replies"],
    "url": "https://atrium.example.com"
  }

Buttons need the bot's app to subscribe to the card callback (developer console:
Events & Callbacks > Callback configuration > card.action.trigger, over the long
connection). Until then the cards say how to answer in writing instead.
"""
import glob
import json
import os
import subprocess
import sys
import threading
import time

DIR = os.environ["ATRIUM_NOTIFY_DIR"]
WHO = os.environ["FEISHU_USER_ID"]
LARK = os.environ.get("LARK_CLI", "lark-cli")
OUT, REPLIES = os.path.join(DIR, "out"), os.path.join(DIR, "replies")

lock = threading.Lock()
cards = {}    # request id -> the card as sent, to redraw once it is answered
pressed = {}  # request id -> the label of the button pressed
buttons = threading.Event()  # set once the app receives card callbacks


def log(*a):
    print("notify-feishu:", *a, file=sys.stderr, flush=True)


def lark(*args):
    try:
        r = subprocess.run([LARK, *args], capture_output=True, text=True, timeout=40)
        return r.returncode == 0, (r.stdout + r.stderr)[-400:]
    except Exception as e:  # a timeout, or lark-cli missing
        return False, str(e)


def write_reply(obj):
    with lock, open(REPLIES, "a") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def zh(n):
    return any(ord(c) > 0x2E80 for c in n.get("head", ""))


def card(n, answered=""):
    """The card for a notification; with `answered`, the same card once a button was pressed."""
    body = []
    if n.get("detail"):
        body.append({"tag": "div", "text": {"tag": "plain_text", "content": n["detail"]}})
    row = []
    if answered:
        body.append({"tag": "markdown", "content": ("已选择：" if zh(n) else "Chosen: ") + "**" + answered + "**"})
    elif n.get("choices") and buttons.is_set():
        for c in n["choices"]:
            row.append({
                "tag": "button", "text": {"tag": "plain_text", "content": c["label"]},
                "type": {"primary": "primary_filled", "danger": "danger"}.get(c.get("style"), "default"),
                "behaviors": [{"type": "callback", "value": {"atrium": n["request"], "reply": c["reply"], "label": c["label"]}}],
            })
    elif n.get("hint"):
        body.append({"tag": "markdown", "content": "<font color='grey'>" + n["hint"] + "</font>"})
    if n.get("url"):
        row.append({
            "tag": "button", "text": {"tag": "plain_text", "content": "打开会话" if zh(n) else "Open the session"},
            "type": "default", "behaviors": [{"type": "open_url", "default_url": n["url"]}],
        })
    if row:
        body.append({
            "tag": "column_set", "flex_mode": "flow", "horizontal_spacing": "8px",
            "columns": [{"tag": "column", "width": "auto", "elements": [b]} for b in row],
        })
    title = n.get("title", "")
    if n.get("machine"):
        title += " · " + n["machine"]
    return {
        "schema": "2.0",
        "config": {"summary": {"content": n.get("head", "") + " · " + n.get("title", "")}},
        "header": {
            "title": {"tag": "plain_text", "content": n.get("head", "Atrium")},
            "subtitle": {"tag": "plain_text", "content": title},
            "template": {"permission": "orange", "done": "green", "error": "red"}.get(n.get("kind"), "blue"),
        },
        "body": {"elements": body},
    }


def send(raw):
    try:
        n = json.loads(raw)
        assert isinstance(n, dict)
    except Exception:
        n = {"text": raw}  # a hub that leaves the plain message
    req = n.get("request", "")
    if n.get("kind") == "reply":
        # What became of an answer. The card of a pressed button already shows it.
        if n.get("ok") and req in pressed:
            return
        ok, out = lark("im", "+messages-send", "--as", "bot", "--user-id", WHO, "--text", n.get("text", ""))
    elif "head" not in n:
        ok, out = lark("im", "+messages-send", "--as", "bot", "--user-id", WHO, "--text", n.get("text", ""))
    else:
        c = card(n)
        ok, out = lark("im", "+messages-send", "--as", "bot", "--user-id", WHO, "--msg-type", "interactive",
                       "--content", json.dumps(c, ensure_ascii=False))
        if ok and req:
            with lock:
                cards[req] = n
                for old in list(cards)[:-100]:
                    cards.pop(old, None)
                    pressed.pop(old, None)
        if not ok:
            log("the card was refused, sending text:", out)
            ok, out = lark("im", "+messages-send", "--as", "bot", "--user-id", WHO, "--text", n.get("text", ""))
    if not ok:
        log("could not send a message:", out)


def consume(key, jq, handle):
    """Keeps a lark-cli event consumer running and hands each event to handle."""
    while True:
        # The consumer stops when its input ends, so it is given one that never does.
        p = subprocess.Popen([LARK, "event", "consume", key, "--as", "bot", "--jq", jq],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        for line in p.stdout:
            try:
                handle(json.loads(line))
            except Exception as e:
                log("an event was not understood:", e)
        p.wait()
        log("the", key, "listener stopped; starting it again")
        time.sleep(5)


def on_message(m):
    if m.get("text"):
        write_reply({"id": m.get("id", ""), "text": m["text"]})


def on_button(m):
    v = m.get("value") or {}
    req = v.get("atrium")
    if not req or "reply" not in v:
        return
    with lock:
        again = req in pressed
        pressed.setdefault(req, v.get("label", ""))
        n = cards.get(req)
    write_reply({"id": m.get("id", ""), "text": v["reply"], "request": req})
    if n and not again and m.get("token"):
        ok, out = lark("api", "POST", "/open-apis/interactive/v1/card/update", "--as", "bot",
                       "--data", json.dumps({"token": m["token"], "card": card(n, pressed[req])}, ensure_ascii=False))
        if not ok:
            log("could not redraw the card:", out)


def watch_callbacks():
    """Buttons work once the app is subscribed to the card callback; look until it is."""
    told = False
    while True:
        try:
            r = subprocess.run([LARK, "event", "consume", "card.action.trigger", "--as", "bot", "--dry-run"],
                               capture_output=True, text=True, timeout=40)
            if json.loads(r.stdout)["data"]["decision"]["status"] == "ready":
                break
        except Exception:
            pass
        if not told:
            log("the app is not subscribed to card.action.trigger yet: cards go out without answer buttons")
            told = True
        time.sleep(60)
    buttons.set()
    log("card buttons are on")
    consume("card.action.trigger",
            'select(.operator_id == "%s" and .action_tag == "button") | {id: .event_id, token: .token, value: (.action_value | fromjson?)}' % WHO,
            on_button)


def main():
    os.makedirs(OUT, exist_ok=True)
    open(REPLIES, "a").close()
    for f in glob.glob(os.path.join(OUT, "*")):  # nothing from before this start is still news
        os.remove(f)
    threading.Thread(target=consume, daemon=True, args=(
        "im.message.receive_v1",
        'select(.chat_type == "p2p" and .sender_id == "%s" and .message_type == "text") | {id: .message_id, text: .content}' % WHO,
        on_message)).start()
    threading.Thread(target=watch_callbacks, daemon=True).start()
    while True:
        for f in sorted(glob.glob(os.path.join(OUT, "*.msg"))):
            try:
                with open(f) as fh:
                    raw = fh.read()
                os.remove(f)
            except OSError:
                continue
            send(raw)
        time.sleep(0.5)


if __name__ == "__main__":
    main()
