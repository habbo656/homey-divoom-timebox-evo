#!/usr/bin/env bash
# Read-only GitHub lookups for model sessions in GitHub Actions (docs/pipeline.md, ADR 0017). Models never run `gh`:
# `gh auth token` prints the token and `gh api --hostname` sends data to any host. This script has fixed queries, takes
# no host or path, and returns only what the owner and the bot wrote (comments.py), so other users' text stays out.
# Needs GH_READ_TOKEN (the job's read-only token, input read-token of .github/actions/claude), GITHUB_REPOSITORY, BOT.
#
#   gh-read.sh issue N    the issue, its comments and the numbers of its agent PRs
#   gh-read.sh pr N       the PR, its branch and head, its comments, reviews and inline review comments
set -euo pipefail
: "${GITHUB_REPOSITORY:?}"
: "${GH_READ_TOKEN:?gh-read.sh: no read token in this session (only the refine, develop and review jobs have one)}"
OWNER=${OWNER:-${GITHUB_REPOSITORY%%/*}}
BOT=${BOT:-}
[ -n "${BOT%\[bot\]}" ] || { echo "gh-read.sh: BOT (the pipeline app's \"<slug>[bot]\" login) not set" >&2; exit 2; }
export GH_TOKEN=$GH_READ_TOKEN
here="$(cd "$(dirname "$0")" && pwd)"
cmd=${1:-}; n=${2:-}
[[ "$n" =~ ^[0-9]+$ ]] || { echo "usage: gh-read.sh issue|pr N" >&2; exit 2; }
repo="repos/$GITHUB_REPOSITORY"
py() { python3 "$here/comments.py" "$1" "$OWNER" "$BOT"; }

case "$cmd" in
  issue)
    gh api "$repo/issues/$n" | py header
    t=$(mktemp)
    gh api "$repo/issues/$n/comments" --paginate >"$t"
    py trusted-md <"$t"
    others=$(py others <"$t"); rm -f "$t"
    [ "$others" -eq 0 ] || echo "($others comment(s) by other users omitted: not trusted input.)"
    echo "Agent PRs: $(bash "$here/issue.sh" prs "$n" | tr '\n' ' ')"
    ;;
  pr)
    gh api "$repo/issues/$n" | py header
    gh api "$repo/pulls/$n" --jq '"Branch: \(.head.ref)\nHead: \(.head.sha)\n"'
    t=$(mktemp)
    { gh api "$repo/issues/$n/comments" --paginate
      gh api "$repo/pulls/$n/reviews" --paginate
      gh api "$repo/pulls/$n/comments" --paginate
    } >"$t"
    py trusted-md <"$t"
    others=$(py others <"$t"); rm -f "$t"
    [ "$others" -eq 0 ] || echo "($others comment(s) by other users omitted: not trusted input.)"
    ;;
  *) echo "usage: gh-read.sh issue|pr N" >&2; exit 2 ;;
esac
