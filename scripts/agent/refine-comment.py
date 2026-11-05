"""Render the refine result as the issue comment (deterministic, no model). Runs in GitHub Actions.

  refine-comment.py RESULT OWNER ISSUE OUT [RESEARCH_ROUNDS]
                                              writes the comment to OUT and prints status=, gate=, hw= lines

status ready: rating + plan + hardware test scenario, marker <!-- agent-plan hw=… risk=… size=… gate=… -->;
gate=owner (risk high or size XL) asks the owner for `/agent go`. needs_owner: rating + questions; split: rating +
proposed issues (both <!-- agent-questions … -->); research: rating + the measurements for the hardware runner,
marker <!-- agent-research-request risk=… size=… gate=… -->, with the same owner gate; after MAX_RESEARCH_ROUNDS rounds
since the owner's last answer it asks the owner instead (status needs_owner); invalid: none of them.
docs/pipeline.md, refine.
"""
import json
import sys

MAX_RESEARCH_ROUNDS = 2

result, owner, issue, out = sys.argv[1:5]
rounds = int(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5].isdigit() else 0
r = json.load(open(result))
status = r.get("status")
risk = r.get("risk") if r.get("risk") in ("low", "medium", "high") else "high"
size = r.get("size") if r.get("size") in ("S", "M", "L", "XL") else "XL"
gate = "owner" if risk == "high" or size == "XL" else "none"
hw = "true" if r.get("needs_hwtest", True) else "false"
rating = f"## Rating\n\n**Risk:** {risk} · **Size:** {size}\n\n{r.get('rating_reason', '').strip()}\n"
answer = "Answer with a comment that starts with `/agent answer`; the pipeline plans again with your answer."

if status == "ready" and r.get("plan", "").strip():
    body = f"{rating}\n## Plan\n\n{r['plan'].strip()}\n\n## Hardware test scenario\n\n{r.get('hw_scenario', 'none').strip()}\n"
    if gate == "owner":
        body += (f"\n@{owner} this plan is rated risk {risk}, size {size}, so it waits for you: comment `/agent go` to "
                 "start development, or `/agent answer <changes>` for a new plan.\n")
    body += f"<!-- agent-plan hw={hw} risk={risk} size={size} gate={gate} -->"
elif status == "split" and r.get("split"):
    items = "\n".join(f"{i}. {s}" for i, s in enumerate(r["split"], 1))
    body = (f"@{owner} #{issue} is too large for one change. Proposed split:\n\n{items}\n\n{rating}\n"
            "Create these issues (add them to `docs/roadmap.md`) and close or narrow this one, or comment "
            "`/agent answer keep as one issue` to plan it as it is.\n<!-- agent-questions kind=split -->")
elif status == "research" and r.get("research", "").strip():
    # The text is model output: it must not carry a pipeline marker of its own.
    text = r["research"].strip().replace("<!-- agent-", "<!-- ")
    if rounds >= MAX_RESEARCH_ROUNDS:
        status = "needs_owner"
        body = (f"@{owner} #{issue} already had {rounds} hardware research rounds and the pipeline wants another one, "
                f"so it stops here:\n\n{text}\n\n{answer}\n\n{rating}<!-- agent-questions kind=research-limit -->")
    else:
        body = f"{rating}\n## Hardware research requested\n\n{text}\n"
        if gate == "owner":
            body += (f"\n@{owner} this work is rated risk {risk}, size {size}, so the research waits for you: comment "
                     "`/agent go` to run it on the hardware runner, or `/agent answer <changes>` for a new request.\n")
        body += f"<!-- agent-research-request risk={risk} size={size} gate={gate} -->"
elif r.get("questions"):
    status = "needs_owner"
    qs = "\n".join(f"- {q}" for q in r["questions"])
    body = (f"@{owner} the planner needs decisions before it can plan #{issue}; it does not assume requirements.\n\n"
            f"{qs}\n\n{answer}\n\n{rating}<!-- agent-questions -->")
else:
    status, body = "invalid", ""  # neither a plan, a split nor questions: the job blocks the issue

open(out, "w").write(body + "\n")
print(f"status={status}\ngate={gate}\nhw={hw}")
