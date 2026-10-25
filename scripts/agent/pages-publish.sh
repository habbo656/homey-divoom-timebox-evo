#!/usr/bin/env bash
# Publish one validated metrics record to the gh-pages branch (the only push target besides agent/*; docs/pipeline.md,
# Run metrics). Run from the checkout of main with the bot's git credentials (.github/actions/bot-token git: "true").
#   pages-publish.sh RECORD
# Writes data/runs/<run_id>-<run_attempt>.json, rebuilds data/index.json from that folder and syncs the dashboard
# (pages/). One file per run, so concurrent runs never conflict on a record; a rejected push (another run pushed
# first) starts again from the new gh-pages head. Creates gh-pages as an orphan branch on the first run.
set -euo pipefail
rec=${1:?record}
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
name=$(python3 "$here/metrics.py" validate "$rec") || { echo "::error::metrics record rejected, not published"; exit 2; }
w="${RUNNER_TEMP:-/tmp}/gh-pages"
for try in 1 2 3 4 5; do
  git -C "$root" worktree remove --force "$w" >/dev/null 2>&1 || rm -rf "$w"
  if git -C "$root" fetch -q --depth 1 origin "+refs/heads/gh-pages:refs/remotes/origin/gh-pages" 2>/dev/null; then
    git -C "$root" worktree add -q --detach "$w" origin/gh-pages
  else
    git -C "$root" worktree add -q --detach "$w" HEAD
    git -C "$w" checkout -q --orphan gh-pages-new
    git -C "$w" rm -rfq . >/dev/null
  fi
  mkdir -p "$w/data/runs"
  cp "$rec" "$w/data/runs/$name"
  cp "$root"/pages/* "$w/"
  touch "$w/.nojekyll"
  python3 "$here/metrics.py" index "$w"
  git -C "$w" add -A
  git -C "$w" diff --cached --quiet || git -C "$w" commit -qm "metrics: run ${name%.json}"
  if git -C "$w" push -q origin "HEAD:refs/heads/gh-pages" 2>/dev/null; then
    echo "published data/runs/$name"
    git -C "$root" worktree remove --force "$w" >/dev/null 2>&1 || true
    exit 0
  fi
  sleep $((try * 3 + RANDOM % 5))
done
echo "::error::gh-pages push failed 5 times; record $name not published"
exit 1
