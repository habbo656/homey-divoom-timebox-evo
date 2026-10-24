"""Filter issue comments read from `gh api …/comments --paginate` (one JSON array per page) on stdin.

  comments.py trusted-md OWNER BOT    Markdown of the owner's and the bot's comments (agent input)
  comments.py owner-md OWNER BOT      Markdown of the owner's comments only (screen input)
  comments.py others OWNER BOT        number of comments by anyone else
  comments.py marker OWNER BOT NAME   body of the newest bot comment containing "<!-- agent-NAME "
  comments.py markers OWNER BOT NAME  number of bot comments containing "<!-- agent-NAME "
"""
import json
import sys


def pages(text):
    dec, i, out = json.JSONDecoder(), 0, []
    while i < len(text):
        while i < len(text) and text[i].isspace():
            i += 1
        if i >= len(text):
            break
        page, i = dec.raw_decode(text, i)
        out += page
    return out


def fence(body):
    # Keep untrusted text inside its fence: break any run of four backticks.
    return (body or "").replace("````", "``​``")


def main():
    mode, owner, bot = sys.argv[1], sys.argv[2], sys.argv[3]
    cs = pages(sys.stdin.read())
    trusted = [c for c in cs if c["user"]["login"] in (owner, bot)]
    if mode in ("trusted-md", "owner-md"):
        for c in trusted if mode == "trusted-md" else [c for c in cs if c["user"]["login"] == owner]:
            print(f"### {c['user']['login']} at {c['created_at']}\n````text\n{fence(c['body'])}\n````\n")
    elif mode == "others":
        print(len(cs) - len(trusted))
    elif mode in ("marker", "markers"):
        tag = f"<!-- agent-{sys.argv[4]} "
        hits = [c for c in cs if c["user"]["login"] == bot and tag in (c["body"] or "")]
        print(len(hits) if mode == "markers" else (hits[-1]["body"] if hits else ""))
    else:
        sys.exit(f"comments.py: unknown mode {mode}")


main()
