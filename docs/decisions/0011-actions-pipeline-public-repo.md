# ADR 0011: Agent pipeline in GitHub Actions for a public repository

**Status:** accepted · **Date:** 2026-10-24 · **Supersedes:** 0003 · **Amends:** 0006 (where agents run, owner channel)

**Context:** The local pipeline (ADR 0003, 0006) works only while the owner's session runs, needs a terminal with
`/autopilot`, and reaches the owner through ntfy. The owner wants the agents to run in GitHub Actions with as few manual
steps as possible, all owner communication on GitHub issues, and the repository to become public. A public repository
means anyone can write issues, comments and fork PRs (prompt injection), all Actions logs and artifacts are public, and a
self-hosted runner can be targeted by fork PRs. ADR 0001 failed on runner quirks, headless permission lists, a label state
machine and branch syncing.

**Decision:**
- Agents run in Actions: plan/implement/docs, review, UAT processing on GitHub-hosted runners; only the hardware test on
  the owner's Mac (self-hosted runner, interactive session for Bluetooth and camera permissions). A reusable
  runner check (`scripts/runner-check.sh`, `.github/actions/runner-check`) proves Bluetooth, BLE permission, webcam,
  Homey LAN API, LAN dev runs (no cloud login) and an available TimeBox before every hardware job.
- The owner starts and steers work only with the label `agent:approved` and `/agent …` comments; the UAT verdict stays an
  `ACCEPTED`/`REJECTED` comment. ntfy, `/autopilot`, `/implement`, `/uat` and `scripts/autopilot.sh` are removed.
- Security for the public repository: owner-only triggers; an approval record with a content hash; only owner and bot
  comments reach a model; an injection screen (tool-less model + heuristics) before any agent reads an issue; model jobs
  with read-only tokens and no GitHub access, deterministic jobs that publish their JSON and git bundles; protected paths
  that need the owner's `/agent approve-diff`; a job-started hook on the self-hosted runner that refuses every job not
  dispatched from `main` by the owner or the bot; CI on GitHub-hosted runners only; the Homey key and webcam photos never
  leave the Mac.
- Pipeline state lives in labels and hidden markers in bot comments written by deterministic steps, not in model output.
  Branches move between jobs as git bundles and are pushed fast-forward only.
- The owner verifies features and bugs before work (approval) and per milestone (UAT, ADR 0007). After `ACCEPTED` the
  pipeline ships the acceptance docs and the version bump and tags `v<version>`; publishing stays with the owner.

**Consequences:** Work continues without an open terminal; the owner's touchpoints are approval, answers, pairing during
a hardware test, protected diffs and the UAT, all on GitHub. Runs share the Claude Pro usage pool via
`CLAUDE_CODE_OAUTH_TOKEN`; a run at the limit resumes on the 3-hourly schedule. The pipeline is more complex than the
local one; its rules are in `docs/pipeline.md` and the deterministic parts are plain scripts in `scripts/agent/`. The
injection screen can be fooled; the read-only model jobs, the independent review, protected paths and the runner hook
are what keep a successful injection from reaching secrets, the Mac or `main`.
