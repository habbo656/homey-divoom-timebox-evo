#!/usr/bin/env bash
# Classify an agent branch diff (deterministic). Usage: diff-check.sh BASE HEAD
# Output lines (to $GITHUB_OUTPUT if set): protected=true|false, docs_only=true|false, files=<count>
# and the protected files on stdout. Protected = files that run with more privileges than the agent had (workflows,
# agent definitions and settings, scripts the self-hosted runner or the gate executes, npm dependencies and their
# install scripts) or that define the rules. A protected diff is never hardware-tested or merged without the owner's
# `/agent approve-diff` on the PR for that exact head commit.
set -euo pipefail
base=${1:?base}; head=${2:?head}
protected_re='^(\.github/|\.claude/|CLAUDE\.md$|scripts/(agent|runner)/|scripts/(gate|homey-api|homey-env|homey-run|hw-preflight|hw-snap|repo-check|runner-check|soak)\.sh$|scripts/homey-dev-run\.mjs$|scripts/probe/|package\.json$|package-lock\.json$|\.npmrc$|\.nvmrc$|\.homeyignore$|eslint\.config\.mjs$|tsconfig\.json$)'
files=$(git diff --name-only "$base...$head")
prot=$(grep -E "$protected_re" <<<"$files" || true)
docs=$(grep -vE '^(docs/|README\.md$)' <<<"$files" || true)
p=false; [ -n "$prot" ] && p=true
d=false; [ -n "$files" ] && [ -z "$docs" ] && d=true
res=$(printf 'protected=%s\ndocs_only=%s\nfiles=%s\n' "$p" "$d" "$(grep -c . <<<"$files" || true)")
[ -n "${GITHUB_OUTPUT:-}" ] && echo "$res" >>"$GITHUB_OUTPUT"
echo "$res"
[ -n "$prot" ] && sed 's/^/PROTECTED: /' <<<"$prot"
true
