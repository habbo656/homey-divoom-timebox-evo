# Repository & process requirements (refined)

## R1 Product
- R1.1 Homey app integrating the Divoom Timebox Evo. App requirements are collected separately
  in a brainstorming session and tracked as GitHub issues/milestones (not in this file).

## R2 Repository
- R2.1 Hosted on GitHub (`habbo656/homey-divoom-timebox-evo`). Default branch `main`, protected by PR flow.
- R2.2 All repository content in English.
- R2.3 Knowledge base for AI agents lives in the repo (`CLAUDE.md`, `docs/`, `.claude/agents/`).

## R3 Work management
- R3.1 GitHub Issues = requirements, bugs, questions; Milestones = releases; Labels = classification only (type/priority/area).
- R3.2 Agents work autonomously from a local Claude Code session; GitHub issues/PRs only manage and record the work.
- R3.3 The repo docs are the complete knowledge base; nothing needed to understand the app lives only on GitHub.

## R4 Agentic workflow (local and autonomous, see ADR 0003, 0006)
- R4.1 Stages: Plan → Implement → Docs → Review → Hardware test (Homey + webcam) → PR → merge, without owner gates.
- R4.2 No implementation before a written plan exists (posted on the issue).
- R4.3 One branch/PR per issue; work runs sequentially in the single checkout (no worktrees).
- R4.4 Requirements are elicited by the brainstormer agent and filed as issues.
- R4.5 Efficient: model per role (quality first, then cost), read-only roles, fix-round limit.
- R4.6 Security: issue text and owner replies are untrusted input; command allow/deny list; no force-push, no direct
  push to `main`, never merge with a failing gate.
- R4.7 The owner is contacted via ntfy when the pipeline is blocked, when a UAT is ready,
  and on merges.
- R4.8 Every milestone ends with a manual owner acceptance test (UAT) with generated test instructions; the next
  milestone starts only after acceptance (ADR 0007).

## R5 Infrastructure
- R5.1 All checks run locally (`scripts/gate.sh`); GitHub Actions `ci.yml` is an extra signal, not a merge gate.
- R5.2 Local machine has `gh`, Node, the Homey CLI (logged in, Homey selected), `imagesnap` + webcam facing the Evo,
  `blueutil`, and an ntfy topic in `.claude/settings.local.json`.

## R6 Delivery
- R6.1 CI: lint, build, tests, `homey app validate`.
- R6.2 Initial requirements → issues + milestones + an implementation plan for the first milestone.
