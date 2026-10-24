---
description: Hardware test of the current branch on the real Homey + Timebox (tester agent, webcam)
argument-hint: [scenario or acceptance criteria]
---
Spawn the `tester` agent for the current branch. Scenario: ${ARGUMENTS:-derive it from the branch's issue plan comment
(`gh issue view <n> --comments`), or a smoke test: app starts, device connects, a brightness change is visible on the
webcam}. Relay its verdict, key log lines and photo paths.
