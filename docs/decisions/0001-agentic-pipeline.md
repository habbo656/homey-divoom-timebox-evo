# ADR 0001: Label-driven agentic pipeline on GitHub Actions

**Status:** superseded by 0003 · **Date:** 2026-10-05

**Context:** Fully agentic development with human owner gates, low cost, parallel developers.

**Decision:** Issue labels form a state machine; each transition triggers one Actions workflow
that runs a role-specific Claude Code agent (`.claude/agents/`) on the self-hosted runner via
`claude -p`. Cheap models for triage, stronger models for planning/implementation. Two human gates:
plan approval and PR merge. Details in `docs/pipeline.md`.

**Consequences:** Transparent and auditable in GitHub; cost bounded by budgets and gating;
parallelism limited by number of runner instances.
