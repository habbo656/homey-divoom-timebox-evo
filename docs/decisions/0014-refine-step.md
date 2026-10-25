# ADR 0014: A refine step rates, clarifies and plans before develop

**Status:** accepted · **Date:** 2026-10-25 · **Amends:** 0011 (jobs of the pipeline)

**Context:** The develop job ran the planner, the developer and the doc-keeper in one session. The planner was told to
fill gaps "from the docs, the code or sensible defaults", so open requirements (behaviour, texts, defaults, Flow card
arguments) were silently decided by the agent, and nothing told the owner how big or risky an issue was before code
was written. The owner wants the requirement rated (risk, size), refined with the owner when it is unclear (no
assumptions on requirements), and planned in a separate step whose plan develop then implements.

**Decision:**
- New model job **refine** (read-only, Opus, the `planner` definition, KB skill): rates risk (low/medium/high) and
  size (S/M/L/XL), asks the owner about every open requirement instead of assuming it (technical *how* stays the
  planner's choice), proposes a split for XL issues, and otherwise writes the plan with the hardware test scenario.
- New deterministic job **record** posts the result (rating + plan, questions, or split) and decides whether develop
  runs. The plan marker carries the rating: `<!-- agent-plan hw=… risk=… size=… gate=… -->`.
- The rating drives the flow: risk high or size XL → the plan waits for the owner's `/agent go` (new command, marker
  `agent-plan-go`); size XL → a proposed split unless the owner keeps it as one issue (`/agent answer`); risk high or
  size L/XL → the developer runs on Opus from round 1. Everything else runs on without an owner gate (rule 2).
- **develop** no longer plans: it implements the newest posted plan. If it finds a requirement the plan leaves open, it
  asks (`needs_owner`) instead of assuming.
- refine runs when no plan exists, or when an owner `/agent answer` or new questions come after the newest plan
  (`issue.sh plan-state`). Fix rounds reuse the plan; findings go to the developer.

**Consequences:** One more Opus session per issue (and per answer), but no extra session per fix round. Owners see
risk and size on every plan and answer more questions up front; high-risk and XL work never starts unseen. Plans
posted before this change have no rating and count as confirmed (developer on Sonnet).
