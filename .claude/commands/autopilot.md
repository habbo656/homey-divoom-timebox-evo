---
description: Work through the roadmap autonomously — one issue after another via /implement, owner acceptance (UAT) per milestone
argument-hint: [max issues, default 1]
---
Process up to ${ARGUMENTS:-1} issues sequentially, fully autonomously. Each milestone ends with an owner acceptance
test (UAT, `docs/uat/README.md`); the next milestone starts only after the owner accepted the previous one.

1. **Pending acceptance first:** if an open issue labelled `uat` exists, run `/uat <version> check`
   (`.claude/commands/uat.md`).
   - Open `uat-finding` bugs of that milestone exist → take the first one as the next issue (step 2).
   - All findings fixed but the owner has not re-tested → run `/uat <version> prepare` (new round), then stop.
   - Verdict still pending → stop: "waiting for UAT v<version>".
   - Accepted → continue below.
2. Pick the next issue: open `uat-finding` bugs first, else the first issue in the milestone table of
   `docs/roadmap.md` (listed order) that is still open on GitHub (`gh issue view <n> --json state,labels`) and not
   labelled `agent:blocked`. Never start an issue of a later milestone while an earlier milestone is not accepted.
   If none is left, notify `info` "roadmap done" and stop.
3. Run the `/implement` pipeline (`.claude/commands/implement.md`) for it, end to end, including merge.
4. If it ended blocked (owner unreachable or chose to stop), stop the autopilot: later issues build on it.
5. When the merged issue was the last open one of its milestone (or the last open `uat-finding`): spawn the
   `doc-keeper` in audit mode on `main` and ship its changes as a `docs:` PR, then run `/uat <version> prepare` and stop
   (the owner tests now; the hardware stays untouched until the verdict).
6. Otherwise continue with step 1 until the issue budget is used up. Final report: issues merged, PRs, UAT state,
   blockers, next issue.

Between issues keep only a short summary in context (issue, PR, result); details live in GitHub and `docs/`.
