# ADR 0013: The protocol knowledge base reaches the agents as a skill

**Status:** accepted · **Date:** 2026-10-25 · **Amends:** 0011 (inputs and secrets of the model jobs)

**Context:** The owner reverse-engineered the TimeBox Evo protocol from the Divoom app and firmware 25024 and verified
most of it on hardware, in the private repository `habbo656/divoom-timebox-protocol-rea`. Its `agent/divoom-evo/`
packages the knowledge base twice with the same engine and data: as an Agent Skill (`SKILL.md` + a Node CLI, ~80 tokens
idle) and as an MCP server (7 tools, ~850 tokens idle). The pipeline's agents should use it instead of guessing bytes.
The model jobs run with Bash and Node already; they must never hold the bot app's private key (ADR 0012), and on a
public repository artifacts and caches are readable by others, so a deterministic job cannot hand the private KB over.

**Decision:**
- Use the **skill**, not the MCP server: it needs no MCP configuration or extra tool permissions in the headless
  sessions, costs less context, and the subagents (which have no Skill tool) can call its CLI with Bash. Local sessions
  may use either; the skill prefers the MCP tools when they exist.
- Access by a **read-only deploy key** of the KB repository (`KB_DEPLOY_KEY`, environment `agents`), not by the bot app:
  if a model extracted it, it could read the KB and nothing else.
- `.github/actions/kb` installs only `agent/divoom-evo/` as `.claude/skills/divoom-evo` in the develop and review jobs;
  the path is git-ignored and publish refuses branches that commit anything under `.claude/skills/`.
- `docs/divoom-protocol.md` stays the project's reference: KB facts are cited and count as SOURCE until verified here.

**Consequences:** Planner, developer, reviewer and doc-keeper look up opcode cards, recipes and exact frames on demand.
The owner adds one deploy key and one secret; `KB_REF` can pin a KB branch or tag. Facts from the private KB appear in
public plans, reviews and docs (the KB is licensed CC BY 4.0); whole sections must not. The hardware job on the Mac does
not get the KB.
