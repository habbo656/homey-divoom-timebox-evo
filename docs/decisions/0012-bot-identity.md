# ADR 0012: The pipeline writes to GitHub as its own GitHub App

**Status:** accepted · **Date:** 2026-10-24 · **Amends:** 0011 (identity of the deterministic write steps)

**Context:** The owner wants to tell at a glance what they committed, pushed or merged and what the agents did, and to
judge agent PRs as someone else's work. The Actions pipeline wrote as the generic `github-actions[bot]` (shared by every
workflow), and local Claude Code sessions committed with the owner's git identity. Options: a GitHub App, or a machine
user account with a personal access token.

**Decision:**
- A dedicated GitHub App, installed on this repository only, is the pipeline's identity. Deterministic write jobs mint a
  short-lived installation token (`.github/actions/bot-token`) and use it for every GitHub write and `git push`; their
  `GITHUB_TOKEN` is read-only. The private key lives in the environments `bot` and `hardware` (deployment branch `main`),
  never in `agents`; model jobs only commit locally with the bot's name and email.
- The app has no Workflows permission, so the "pipeline cannot push workflow files" guarantee is unchanged.
- Scripts and the runner guard trust `<slug>[bot]` (repository variable `AGENT_BOT_SLUG`, runner `RUNNER_GUARD_BOT`)
  instead of `github-actions[bot]`.
- Local Claude Code sessions commit as the bot (`GIT_AUTHOR_*`/`GIT_COMMITTER_*` in `.claude/settings.json`).
- Merging stays autonomous (no approving review required); only the identity changes.

**Consequences:** History, PRs, comments and labels show the bot instead of the owner or `github-actions`. App-token
events trigger workflows: `ci.yml` runs on agent PRs (it could become a required check later), and `agent-intake` must
skip the bot's own events. No second account, email or long-lived PAT to rotate; the owner keeps one private key in two
environments. The hardware job holds a write token on the Mac only while it waits for pairing.
