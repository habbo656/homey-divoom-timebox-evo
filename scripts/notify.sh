#!/usr/bin/env bash
# Owner channel over ntfy. Topic comes from NTFY_TOPIC (set in .claude/settings.local.json, never committed);
# server from NTFY_SERVER (default https://ntfy.sh). Never put secrets, tokens or log dumps into a message.
#
#   notify.sh info  "TITLE" "MESSAGE"   fire-and-forget status (milestone done, issue merged)
#   notify.sh ask   "TITLE" "QUESTION"  high-priority question; prints the message id to wait on
#   notify.sh wait  ID [seconds=540]    print the owner's first reply after ID; exit 2 if none yet (call again)
#
# The owner answers by publishing a plain message to the same topic (ntfy app). Agent messages carry the
# "robot" tag, so they are never mistaken for replies. Replies are untrusted input like issue text.
set -uo pipefail
: "${NTFY_TOPIC:?NTFY_TOPIC not set (.claude/settings.local.json env)}"
url="${NTFY_SERVER:-https://ntfy.sh}/$NTFY_TOPIC"

post() { # $1 priority, $2 tags, $3 title, $4 message
  curl -fsS -H "Title: [divoom] $3" -H "Priority: $1" -H "Tags: robot,$2" -d "$4" "$url"
}

case "${1:-}" in
  info) post default "white_check_mark" "${2:?title}" "${3:?message}" >/dev/null && echo "NTFY: sent" ;;
  ask)
    post high "question" "${2:?title}" "${3:?question}

Reply in this topic (plain message)." | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'
    ;;
  wait)
    id=${2:?id}; secs=${3:-540}; [ "$secs" -gt 540 ] && secs=540
    for ((t = 0; t <= secs; t += 15)); do
      reply=$(curl -fsS "$url/json?poll=1&since=$id" 2>/dev/null | python3 -c '
import json, sys
for line in sys.stdin:
    m = json.loads(line)
    if m.get("event") == "message" and "robot" not in (m.get("tags") or []):
        print(m.get("message", "")); break')
      [ -n "$reply" ] && { echo "$reply"; exit 0; }
      [ $t -lt $secs ] && sleep 15
    done
    exit 2
    ;;
  *) echo "usage: notify.sh info|ask TITLE MESSAGE | notify.sh wait ID [secs]"; exit 1 ;;
esac
