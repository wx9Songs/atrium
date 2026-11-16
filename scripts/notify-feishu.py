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
STATE = os.path.join(DIR, "cards.json")  # the cards still open, kept across a restart

lock = threading.Lock()
cards = {}    # request id -> the card as sent, to redraw once it is answered
sent = {}     # message id -> request id, for a form (its button cannot say which)
pressed = {}  # request id -> the label of the button pressed
buttons = threading.Event()  # set once the app receives card callbacks


def log(*a):
    print("notify-feishu:", *a, file=sys.stderr, flush=True)


def lark(*args, full=False):
    try:
        r = subprocess.run([LARK, *args], capture_output=True, text=True, timeout=40)
        return r.returncode == 0, r.stdout if full and r.returncode == 0 else (r.stdout + r.stderr)[-400:]
    except Exception as e:  # a timeout, or lark-cli missing
        return False, str(e)


def save_state():
    """Call with the lock held."""
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"cards": cards, "sent": sent, "pressed": pressed}, f, ensure_ascii=False)
    os.replace(tmp, STATE)


def load_state():
    try:
        with open(STATE) as f:
            d = json.load(f)
        cards.update(d.get("cards") or {})
        sent.update(d.get("sent") or {})
        pressed.update(d.get("pressed") or {})
    except (OSError, ValueError):
        pass


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
    elif n.get("request") and buttons.is_set() and n.get("questions") and not n.get("choices"):
        # Several questions, or several options at once: a form, one part per
        # question, each with its options and room for an answer in one's own words.
        many = len(n["questions"]) > 1
        els = []
        for i, q in enumerate(n["questions"]):
            if many:
                els.append({"tag": "markdown", "content": "**%d. %s**" % (i + 1, q["question"])})
            if q.get("options"):
                els.append({
                    "tag": "multi_select_static" if q.get("multi") else "select_static", "name": "q%d" % i, "width": "fill",
                    "placeholder": {"tag": "plain_text", "content": ("请选择（可多选）" if q.get("multi") else "请选择") if zh(n) else ("Choose (several allowed)" if q.get("multi") else "Choose")},
                    "options": [{"text": {"tag": "plain_text", "content": o}, "value": o} for o in q["options"]],
                })
            els.append({
                "tag": "input", "name": "o%d" % i, "width": "fill",
                "placeholder": {"tag": "plain_text", "content": "其他：自己填写（填了以这里为准）" if zh(n) else "Other: your own answer (wins if filled in)"},
            })
        els.append({
            "tag": "button", "name": "submit", "type": "primary_filled", "form_action_type": "submit",
            "text": {"tag": "plain_text", "content": "提交" if zh(n) else "Submit"},
        })
        body.append({"tag": "form", "name": "answers", "elements": els})
    elif n.get("request") and buttons.is_set():
        for c in n.get("choices") or []:
            row.append({
                "tag": "button", "text": {"tag": "plain_text", "content": c["label"]},
                "type": {"primary": "primary_filled", "danger": "danger"}.get(c.get("style"), "default"),
                "behaviors": [{"type": "callback", "value": {"atrium": n["request"], "reply": c["reply"], "label": c["label"]}}],
            })
        if n.get("free"):
            # An answer in one's own words; where there are no buttons (several
            # questions, several options at once), also the numbers.
            hint = ("其他：写下你的回答" if zh(n) else "Other: write your answer") if row else n.get("hint", "")
            body.append({
                "tag": "input", "name": "answer", "width": "fill",
                "placeholder": {"tag": "plain_text", "content": hint[:100]},
                "behaviors": [{"type": "callback", "value": {"atrium": n["request"]}}],
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
                       "--content", json.dumps(c, ensure_ascii=False), full=True)
        if ok and req:
            with lock:
                try:
                    sent[json.loads(out[out.index("{"):])["data"]["message_id"]] = req
                except Exception:
                    pass
                for old in list(sent)[:-100]:
                    sent.pop(old, None)
                cards[req] = n
                for old in list(cards)[:-100]:
                    cards.pop(old, None)
                    pressed.pop(old, None)
                save_state()
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
    v = m.get("value") or {}  # a button's value arrives as a JSON string; a form's submit has none
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            v = {}
    if not isinstance(v, dict):
        v = {}
    log("a card came back:", m.get("tag"), "form" if m.get("form") else "")
    req = v.get("atrium")
    text = v.get("reply") if m.get("tag") == "button" else (m.get("input") or "").strip()
    if m.get("form"):
        # A form: one line per question, what was written winning over what was chosen.
        with lock:
            req = sent.get(m.get("message"))
            n = cards.get(req) or {}
        form, lines = m["form"], []
        if isinstance(form, str):
            form = json.loads(form)
        for i, q in enumerate(n.get("questions") or []):
            picked = form.get("q%d" % i) or ""
            if isinstance(picked, list):
                picked = ", ".join(picked)
            own = " ".join((form.get("o%d" % i) or "").split()).replace(";", ",").replace("；", "，")
            lines.append(own or picked)
        if not req or not lines:
            log("a form came back for a card this script does not know")
            return
        if not all(lines):
            lark("im", "+messages-send", "--as", "bot", "--user-id", WHO, "--text",
                 "还有问题没有回答，请填完再提交。" if zh(n) else "Some questions have no answer yet; fill them in and submit again.")
            return
        text, v = "\n".join(lines), {"label": " / ".join(lines)}
    if not req or not text:
        return
    with lock:
        again = req in pressed
        pressed.setdefault(req, v.get("label") or text)
        n = cards.get(req)
        save_state()
    write_reply({"id": m.get("id", ""), "text": text, "request": req})
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
            'select(.operator_id == "%s" and (.action_tag == "button" or .action_tag == "input")) | {id: .event_id, token: .token, tag: .action_tag, input: .input_value, form: .form_value, message: .message_id, value: .action_value}' % WHO,
            on_button)


def main():
    os.makedirs(OUT, exist_ok=True)
    open(REPLIES, "a").close()
    load_state()
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
