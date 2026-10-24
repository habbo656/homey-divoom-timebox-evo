# ADR 0006: Autonomous local pipeline with hardware-in-the-loop tests

**Status:** accepted, amended by 0007 · **Date:** 2026-10-06 · **Amends:** 0003 (owner gates)

**Context:** The owner wants the pipeline to run unattended: plan, implement, review, test on the real Homey and Timebox,
and merge, reaching the owner only when help is needed. GitHub should only manage the work; all execution is local,
and the repo docs must be complete without GitHub.

**Decision:**
- Owner gates removed: plans are posted on the issue as a record, PRs are created and squash-merged by the orchestrator
  once all local gates pass (`scripts/gate.sh`, doc-keeper, reviewer, tester). CI is not a merge gate.
- New `doc-keeper` agent and pipeline stage keeps `docs/` consistent with the code on every branch and per milestone.
- Hardware tests drive the running dev app with `homey api` (local) and verify the display with a webcam
  (`scripts/hw-snap.sh`); `scripts/homey-run.sh` gained a background mode.
- Owner channel is ntfy (`scripts/notify.sh`), used for blockers, pairing and milestone notices.
- Models, sized for the Claude Pro plan (amended 2026-10-06): Opus 5.5 for planner and reviewer (few tokens, decide
  quality); Sonnet 5.5 for orchestrator, developer, doc-keeper and tester (token-heavy or checklist work); one Opus
  developer escalation round before giving up. Fable is not used (extra usage credits on Pro).
- Runs are small (`/autopilot` default 1 issue), resumable, and report an abnormal end (usage limit) via ntfy.
- Safety moves from human gates to a command allowlist/denylist in `.claude/settings.json`.

**Consequences:** Issues flow without owner wait time; quality rests on the reviewer and tester, so both run at high
effort and must cite evidence. Releases and App Store publishing stay manual. Pairing a device still needs the owner.
A wrong plan is no longer caught before implementation; the reviewer checks against acceptance criteria instead.
