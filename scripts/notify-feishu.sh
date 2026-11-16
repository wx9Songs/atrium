#!/bin/sh
# Feishu/Lark for Atrium's notifications, for a hub that is kept off the network
# (as the systemd unit in the setup guide keeps it): the hub leaves each message
# as a file, this script sends it with lark-cli as your bot, and what you write
# back to the bot is appended to a file the hub follows.
#
# Run it as its own service, with network access and lark-cli configured for
# the bot (lark-cli config init), and with
#   ATRIUM_NOTIFY_DIR   a folder both this script and the hub can write to
#   FEISHU_USER_ID      your open_id (ou_...): who gets the messages, and the
#                       only one whose replies count
#
# The hub's side, in its config.json (with the same folder):
#   "notify": {
#     "command": ["sh", "-c", "f=\"$0/out/$(date +%s)-$$\"; cat > \"$f.tmp\" && mv \"$f.tmp\" \"$f.msg\"", "/srv/atrium/notify"],
#     "replies": ["tail", "-n0", "-F", "/srv/atrium/notify/replies"],
#     "url": "https://atrium.example.com"
#   }
set -u
DIR=${ATRIUM_NOTIFY_DIR:?set ATRIUM_NOTIFY_DIR}
WHO=${FEISHU_USER_ID:?set FEISHU_USER_ID}
mkdir -p "$DIR/out"
touch "$DIR/replies"
rm -f "$DIR"/out/*.msg "$DIR"/out/*.tmp # nothing from before this start is still news

# The consumer stops when its input ends, so it is given one that never does.
tail -f /dev/null | lark-cli event consume im.message.receive_v1 --as bot \
	--jq "select(.chat_type == \"p2p\" and .sender_id == \"$WHO\" and .message_type == \"text\") | {id: .message_id, text: .content}" \
	>>"$DIR/replies" &
listener=$!
trap 'kill $listener 2>/dev/null; exit 0' INT TERM

while kill -0 $listener 2>/dev/null; do
	for f in "$DIR"/out/*.msg; do
		[ -f "$f" ] || continue
		lark-cli im +messages-send --as bot --user-id "$WHO" --text - <"$f" >/dev/null || echo "notify-feishu: could not send a message" >&2
		rm -f "$f"
	done
	sleep 1
done
echo "notify-feishu: the event listener stopped" >&2
exit 1
