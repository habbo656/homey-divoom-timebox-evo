# ADR 0003: Local agent workflow replaces GitHub Actions pipeline

**Status:** superseded by 0011 (owner gates amended by 0006) · **Date:** 2026-10-06 · **Supersedes:** 0001

**Context:** The label-driven pipeline on a self-hosted runner was cumbersome (runner quirks, permission
allow-lists for headless runs, label state machine, branch sync, budget plumbing).

**Decision:** Agents run locally as Claude Code subagents (`.claude/agents/`) orchestrated by slash commands
(`.claude/commands/`). GitHub keeps issues, PRs and `ci.yml` only.
Owner gates: plan approval and push/PR/merge. Details in `docs/pipeline.md`.

**Consequences:** Interactive, no runner or secrets for agents, faster feedback; work happens only while the owner's
session runs, and there is no automatic triage of new issues.
