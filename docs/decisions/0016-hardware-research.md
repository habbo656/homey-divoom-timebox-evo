# ADR 0016: Hardware research on the self-hosted runner before planning

**Status:** accepted · **Date:** 2026-11-05 · **Amends:** 0011 (jobs on the self-hosted runner), 0014 (refine results)

**Context:** The only pipeline job with a model on the Mac was the hardware test, which needs a reviewed PR. A plan whose
first step is a measurement on the device had nowhere to run: develop has no Bluetooth, webcam or TimeBox, so #29 blocked
twice with "no commits", and `/agent retry` repeated the same run.

**Decision:**
- New plan state `research`. The planner returns `status: research`, or the developer returns `needs_research` as a safety
  net; the request is an issue comment with the plan's risk gate (`/agent go` for risk high or size XL).
- A `research` job runs one session on the Mac; a deterministic `research-report` job posts the report and dispatches the
  issue, and refine plans again from it. The evidence reaches `docs/protocol/` through the new plan.
- The job checks out `main`, never an agent branch, mints no bot token, gets no `HOMEY_PAT` and returns only a report, so no
  unreviewed code runs on the Mac and nothing but scrubbed text leaves it. The protected-path rule stays as it is.
- At most two research rounds per owner answer, then the owner is asked.
- `scripts/probe/divoom.py` refuses `hex:` payloads with the documented forbidden opcodes.

**Consequences:** A model with Bash now runs on the Mac before any review, on a request derived from the screened issue;
the checkout and the empty output path limit this, but the session is not sandboxed and its device commands are bounded
only by the prompt and the probe guard. It can occupy the Mac and the pipeline for up to 5 hours. It needs the BLE link: if
the installed app on the Homey holds it, the owner is asked to stop the app. It uninstalls a dev build, so a later hardware
test may ask for pairing again.
