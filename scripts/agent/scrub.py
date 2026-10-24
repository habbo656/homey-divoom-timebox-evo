"""Remove bench and personal details from text before the pipeline posts it (public repository).

  scrub.py < in.txt > out.txt

Replaces UUIDs (device ids), MAC addresses, IPv4 addresses, LAN host names (*.local, *.lan, *.fritz.box, *.home),
home directory paths (/Users/<name>/…, /home/<name>/…) and the strings in SCRUB_EXTRA (newline-separated, e.g. the
runner user and host name) with placeholders. Model-written comments go through it in addition to the prompt rules.
"""
import os
import re
import sys

RULES = [
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I), "<device>"),
    (re.compile(r"\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b", re.I), "<mac>"),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b"), "<ip>"),
    # Host names only: "settings.local.json" or "home.md" are file names, not hosts.
    (re.compile(r"\b[\w-]+(?:\.[\w-]+)*\.(?:local|lan|home|fritz\.box)\b(?!\.\w|-)", re.I), "<host>"),
    (re.compile(r"/(?:Users|home)/[^/\s`'\"]+"), "~"),
]
# The ISSC GATT service/characteristic UUIDs are protocol facts, not device data.
KEEP = re.compile(r"49535343-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)


def scrub(text):
    kept = {}

    def hold(m):
        kept[f"\x00{len(kept)}\x00"] = m.group(0)
        return f"\x00{len(kept) - 1}\x00"

    text = KEEP.sub(hold, text)
    for extra in filter(None, (os.environ.get("SCRUB_EXTRA") or "").splitlines()):
        if len(extra.strip()) >= 3:
            text = re.sub(re.escape(extra.strip()), "<redacted>", text, flags=re.I)
    for rx, rep in RULES:
        text = rx.sub(rep, text)
    for k, v in kept.items():
        text = text.replace(k, v)
    return text


sys.stdout.write(scrub(sys.stdin.read()))
