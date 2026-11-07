"""Filter issue comments read from `gh api …/comments --paginate` (one JSON array per page) on stdin.

  comments.py trusted-md OWNER BOT    Markdown of the owner's and the bot's comments (agent input); also takes PR
                                      reviews and inline review comments, in order of time
  comments.py header OWNER BOT        title, state and body of one issue or PR (`gh api …/issues/N`, one object),
                                      title and body only if the owner or the bot wrote them
  comments.py owner-md OWNER BOT      Markdown of the owner's comments only (screen input)
  comments.py others OWNER BOT        number of comments by anyone else
  comments.py marker OWNER BOT NAME   body of the newest bot comment containing "<!-- agent-NAME "
  comments.py markers OWNER BOT NAME  number of bot comments containing "<!-- agent-NAME "
  comments.py plan-state OWNER BOT    what the pipeline does next (refine, research, ready or wait), plus the
                                      hw/risk/size/gate attributes of the newest plan or research request and the
                                      research rounds since the owner's last answer (docs/pipeline.md, refine)
"""
import json
import re
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


def login(c):
    # A PR review of a deleted account has no user.
    return (c.get("user") or {}).get("login")


def when(c):
    return c.get("created_at") or c.get("submitted_at") or ""


def where(c):
    if c.get("path"):
        return f" on {c['path']}:{c.get('line') or c.get('original_line') or '?'}"
    return f" (review: {c['state']})" if c.get("state") else ""


def header(c, owner, bot):
    print(f"# #{c['number']} ({c['state']}, author {login(c)})")
    if login(c) in (owner, bot):
        print(f"Title: {c['title']}\n\n````text\n{fence(c['body'])}\n````\n")
    else:
        print("(Title and body by another user omitted: not trusted input.)\n")


def main():
    mode, owner, bot = sys.argv[1], sys.argv[2], sys.argv[3]
    if mode == "header":
        return header(json.load(sys.stdin), owner, bot)
    # Stable: comments of one list without timestamps (tests) keep their order.
    cs = sorted(pages(sys.stdin.read()), key=when)
    trusted = [c for c in cs if login(c) in (owner, bot)]
    if mode in ("trusted-md", "owner-md"):
        for c in trusted if mode == "trusted-md" else [c for c in cs if login(c) == owner]:
            # A review that only approves or requests changes has no text.
            if c.get("body"):
                print(f"### {login(c)} at {when(c)}{where(c)}\n````text\n{fence(c['body'])}\n````\n")
    elif mode == "others":
        print(len(cs) - len(trusted))
    elif mode in ("marker", "markers"):
        tag = f"<!-- agent-{sys.argv[4]} "
        hits = [c for c in cs if login(c) == bot and tag in (c["body"] or "")]
        print(len(hits) if mode == "markers" else (hits[-1]["body"] if hits else ""))
    elif mode == "plan-state":
        plan_state(cs, owner, bot)
    else:
        sys.exit(f"comments.py: unknown mode {mode}")


def is_answer(body):
    # /agent answer, or /agent retry with instructions: the plan has to follow them. A bare retry repeats the run.
    return re.match(r"/agent (answer\b|retry\b\s*\S)", body.lstrip()) is not None


def plan_state(cs, owner, bot):
    # Newest position of each event: plan, research request and report, owner confirmation (/agent go), questions,
    # owner answer. A plan or a research request is the "current step"; attrs are those of the newest of the two.
    last = {"plan": -1, "request": -1, "research": -1, "go": -1, "questions": -1, "answer": -1}
    attrs = {}
    rounds = 0
    for i, c in enumerate(cs):
        body, author = c["body"] or "", login(c)
        if author == bot:
            for key, tag in (("plan", "plan"), ("request", "research-request")):
                m = re.search(rf"<!-- agent-{tag} ([^>]*)-->", body)
                if m:
                    last[key], attrs = i, dict(re.findall(r"(\w+)=([\w.-]+)", m.group(1)))
            if "<!-- agent-research " in body:
                last["research"], rounds = i, rounds + 1
            if "<!-- agent-plan-go " in body:
                last["go"] = i
            if "<!-- agent-questions " in body:
                last["questions"] = i
        elif author == owner and is_answer(body):
            last["answer"], rounds = i, 0
    step = max(last["plan"], last["request"])
    if step < 0 or max(last["answer"], last["questions"], last["research"]) > step:
        # Nothing yet, or the owner answered, questions came up or research results arrived after it: plan (again).
        state = "refine"
    elif attrs.get("gate") == "owner" and last["go"] < step:
        state = "wait"
    else:
        state = "research" if last["request"] > last["plan"] else "ready"
    print(f"state={state}")
    for k in ("hw", "risk", "size", "gate"):
        print(f"{k}={attrs.get(k, '')}")
    print(f"research_rounds={rounds}")


main()
