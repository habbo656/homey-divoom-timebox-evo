# ADR 0015: Agent run metrics on a public GitHub Pages dashboard

**Status:** accepted · **Date:** 2026-10-25 · **Amends:** 0011 (jobs and push targets of the pipeline)

**Context:** The pipeline ran Claude Code with `--output-format json` but kept only one stderr line per session.
Turns, duration, tokens and cost per stage, and the outcome of a run (gate, review findings, hardware verdict, fix
rounds, UAT verdict), were lost, so drift after a model, Claude Code or prompt change could not be seen (#24).

**Decision:**
- `.github/actions/claude` writes a stage metrics record from the numeric and enum fields of the result only.
- A deterministic `metrics` job at the end of `agent-pipeline.yml` (`if: always()`, so failed, cancelled and
  usage-limited runs count) and of `agent-uat.yml` merges the stage records with the run context and outcome
  (`scripts/agent/metrics.py`), validates the record against a closed schema (`.github/agent/metrics.schema.json`:
  every string needs an enum or pattern, no additional properties) and publishes it as one file per run on the
  `gh-pages` branch (`scripts/agent/pages-publish.sh`, bot token, fetch/retry on a rejected push).
- `gh-pages` becomes the only push target besides `agent/*` branches; model jobs keep read-only tokens.
- A static dashboard (`pages/`, copied to the branch root on every publish) renders the data with a strict CSP and
  never via `innerHTML`.

**Consequences:** The repository is public, so the dashboard is too; only numbers, IDs and enums are published, and a
new field needs a schema entry. One more short bot job per run. The owner enables Pages once (`docs/pipeline.md`,
owner setup step 7). Not covered: peak context per turn, post-merge fix commits, alerts.
