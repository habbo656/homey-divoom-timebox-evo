#!/usr/bin/env bash
# Static context size: the bytes of what every agent session loads or is told to read first, as key=bytes lines
# (total, claude_md, agents, prompts, skills, docs). Approximate tokens = bytes / 4. Recorded with every run
# (scripts/agent/metrics.py), so prompt and knowledge-base growth shows up as its own trend. docs/pipeline.md, Run metrics.
#   claude_md  CLAUDE.md
#   agents     .claude/agents/*.md
#   prompts    .github/agent/*.md (the pipeline's prompt templates)
#   skills     the frontmatter description of every installed .claude/skills/*/SKILL.md (what a session loads up front)
#   docs       the files listed under "Read first" in CLAUDE.md
set -euo pipefail
cd "$(dirname "$0")/../.."
bytes() { cat "$@" 2>/dev/null | wc -c | tr -d ' '; }
shopt -s nullglob
claude_md=$(bytes CLAUDE.md)
agents=$(bytes .claude/agents/*.md)
prompts=$(bytes .github/agent/*.md)
skills=0
for f in .claude/skills/*/SKILL.md; do
  n=$(awk 'NR == 1 && $0 != "---" { exit } NR > 1 && $0 == "---" { exit } NR > 1 && /^description:/ { p = 1 }
           p && NR > 1 { if (/^[a-z_-]+:/ && !/^description:/) exit; print }' "$f" | wc -c | tr -d ' ')
  skills=$((skills + n))
done
docs=0
for f in $(sed -n '/^## Read first/,/^## /p' CLAUDE.md | grep -oE '^- `[^`]+\.md`' | tr -d '`' | cut -c3-); do
  [ -f "$f" ] && docs=$((docs + $(bytes "$f")))
done
printf 'total=%s\nclaude_md=%s\nagents=%s\nprompts=%s\nskills=%s\ndocs=%s\n' \
  $((claude_md + agents + prompts + skills + docs)) "$claude_md" "$agents" "$prompts" "$skills" "$docs"
