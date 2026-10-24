# Repository & process requirements (refined)

## R1 Product
- R1.1 Homey app integrating the Divoom Timebox Evo. App requirements are collected separately
  in a brainstorming session and tracked as GitHub issues/milestones (not in this file).

## R2 Repository
- R2.1 Hosted on GitHub (`habbo656/homey-divoom-timebox-evo`, to be made public; security model in `docs/pipeline.md`). Default branch `main`, protected by PR flow.
- R2.2 All repository content in English.
- R2.3 Knowledge base for AI agents lives in the repo (`CLAUDE.md`, `docs/`, `.claude/agents/`).

## R3 Work management
- R3.1 GitHub Issues = requirements, bugs, questions; Milestones = releases; Labels = classification plus the owner-set
  `agent:approved` and the pipeline state labels (`docs/pipeline.md`).
- R3.2 Agents work autonomously in GitHub Actions (ADR 0011); GitHub issues/PRs manage and record the work and are the
  only owner channel.
- R3.3 The repo docs are the complete knowledge base; nothing needed to understand the app lives only on GitHub.

## R4 Agentic workflow (GitHub Actions, autonomous; ADR 0006, 0007, 0011)
- R4.1 Stages: Plan → Implement → Docs → Gate + independent Review → Hardware test (Homey + webcam, self-hosted runner)
  → PR → merge, without owner gates after the approval.
- R4.2 No implementation before a written plan exists (posted on the issue).
- R4.3 One branch/PR per issue; one issue at a time.
- R4.4 Requirements are elicited by the brainstormer agent and filed as issues; agents start only on issues the owner
  approved (`agent:approved`), screened for prompt injection.
- R4.5 Efficient: model per role (quality first, then cost), read-only roles, fix-round limit.
- R4.6 Security (public repository): owner-only triggers, injection screen, untrusted input only from the owner and the
  bot, model jobs without GitHub write access, protected paths need the owner, the self-hosted runner accepts only
  pipeline jobs from `main`; no force-push, no direct push to `main`, never merge with a failing gate.
- R4.7 The owner is contacted only on GitHub (issue/PR comments with `@mention`): questions, blocks, pairing, protected
  diffs, UAT.
- R4.8 Every milestone ends with a manual owner acceptance test (UAT) with generated test instructions; the next
  milestone starts only after acceptance (ADR 0007).

## R5 Infrastructure
- R5.1 The merge gate is `scripts/gate.sh`, run by `gate.yml` on GitHub-hosted runners (agent PRs inside the pipeline,
  other PRs via `ci.yml`).
- R5.2 Self-hosted runner on the owner's Mac (interactive session): Node, the Homey CLI (logged in, Homey selected), the
  Homey key in `~/.config/divoom-timebox/homey-api.env`, `imagesnap` + webcam facing the Evo, `blueutil`, the runner job
  hook; verified by `scripts/runner-check.sh`. Secret `CLAUDE_CODE_OAUTH_TOKEN` in the environments `agents` and `hardware`.

## R6 Delivery
- R6.1 CI: lint, build, tests, `homey app validate`.
- R6.2 Initial requirements → issues + milestones + an implementation plan for the first milestone.
