# ADR 0007: Owner acceptance test per milestone

**Status:** accepted · **Date:** 2026-10-06 · **Amends:** 0006

**Context:** The pipeline (ADR 0006) merges issues without owner gates. Automated review and hardware tests check
acceptance criteria per issue, but not how the milestone feels to a user in the Homey app (pairing, tiles, settings,
Flow editor, texts). The owner wants to accept every milestone by hand.

**Decision:**
- Each milestone ends with a user acceptance test (UAT) by the owner. Test instructions are generated per milestone
  (`docs/uat/v<version>.md`, doc-keeper uat mode) from the issues' acceptance criteria and the merged code; automatable
  cases are pre-checked by the tester first.
- A GitHub issue (label `uat`) carries the checklist and the verdict (`ACCEPTED` / `REJECTED <ids>`); the owner is
  notified via ntfy. Findings become `uat-finding` bugs that the pipeline fixes before a new round.
- `/autopilot` does not start a later milestone while an earlier one is not accepted. Releases follow acceptance.

**Consequences:** One owner touchpoint per milestone instead of per issue; milestones take longer to close; the test
instructions double as a user-level description of each release in the repo.
