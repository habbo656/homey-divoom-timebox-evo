#!/usr/bin/env bash
# Pick the next piece of agent work from docs/roadmap.md (deterministic, no model). Runs in GitHub Actions.
# Needs GH_TOKEN, GITHUB_REPOSITORY. Output lines (to $GITHUB_OUTPUT if set): kind=issue|wait|idle|done, issue=N, reason=…
#   issue: work on #N (an approved roadmap issue, an approved uat-finding bug, or the milestone's UAT issue)
#   wait:  the owner has to act first (UAT verdict, blocked or questioned issue) — nothing is started
#   idle:  open issues exist but none is approved (`agent:approved`); the reason lists them
# Milestones run in table order; a milestone counts as done when its row says "accepted". When every issue of the
# current milestone is closed, this opens (and approves, as the bot) the UAT issue `UAT v<version>: <milestone>`.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
: "${GITHUB_REPOSITORY:?}"
emit() { local s; s=$(printf 'kind=%s\nissue=%s\nreason=%s\n' "$1" "${2:-}" "$3"); [ -n "${GITHUB_OUTPUT:-}" ] && echo "$s" >>"$GITHUB_OUTPUT"; echo "$s"; exit 0; }
labels_of() { gh issue view "$1" --json state,labels --jq '.state + " ," + ([.labels[].name] | join(",")) + ","'; }

row=$(grep -E '^\| [0-9]+\.[0-9]+\.[0-9]+' docs/roadmap.md | grep -v 'accepted' | head -n 1)
[ -n "$row" ] || emit "done" "" "every roadmap milestone is accepted"
version=$(awk -F'|' '{gsub(/ /,"",$2); print $2}' <<<"$row" | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')
name=$(awk -F'|' '{print $3}' <<<"$row" | sed -E 's/^ +//; s/ *\(.*//; s/ +$//')
issues=$(awk -F'|' '{print $4}' <<<"$row" | grep -oE '#[0-9]+' | tr -d '#' | awk '!seen[$0]++')
milestone=$(gh api "repos/$GITHUB_REPOSITORY/milestones?state=all&per_page=100" --jq ".[] | select(.title | startswith(\"v$version\")) | .title" | head -n 1)

pick() { # $1 = space-separated issue numbers in order; emits for the first actionable one, returns if all closed
  local n info unapproved=""
  for n in $1; do
    info=$(labels_of "$n") || continue
    [ "${info%% *}" = OPEN ] || continue
    case "$info" in
      *,agent:blocked,*|*,security:flagged,*) emit wait "$n" "#$n is blocked or flagged; the owner decides (/agent retry or /agent override)" ;;
      *,agent:needs-owner,*) emit wait "$n" "#$n waits for an owner answer (/agent answer …)" ;;
      *,agent:approved,*) emit issue "$n" "next approved issue of v$version" ;;
      *) unapproved="$unapproved #$n" ;;
    esac
  done
  [ -z "$unapproved" ] || emit idle "" "v$version: open but not approved:$unapproved (label agent:approved to start)"
}

uat=$(gh issue list --label uat --state open --search "\"UAT v$version\" in:title" --json number --jq '.[0].number // empty')
if [ -n "$uat" ]; then
  findings=$(gh issue list --label uat-finding --state open ${milestone:+--milestone "$milestone"} --json number --jq '[.[].number] | sort | .[]')
  [ -n "$findings" ] && pick "$findings"
  ready=$(bash scripts/agent/issue.sh markers "$uat" uat-ready); rejected=$(bash scripts/agent/issue.sh markers "$uat" uat-rejected)
  [ "${ready:-0}" -gt "${rejected:-0}" ] && emit wait "$uat" "UAT v$version is with the owner (reply ACCEPTED or REJECTED on #$uat)"
  pick "$uat"
  emit wait "$uat" "UAT issue #$uat is not approved"
fi

pick "$issues"
# Every issue of the milestone is closed: open the UAT issue.
url=$(gh issue create --title "UAT v$version: $name" --label uat ${milestone:+--milestone "$milestone"} \
  --body "Owner acceptance test for v$version ($name). The pipeline writes \`docs/uat/v$version.md\`, pre-checks the [auto] cases on the hardware and then posts the checklist here.")
n=${url##*/}
bash scripts/agent/issue.sh approve "$n" "${BOT:?}" >/dev/null
emit issue "$n" "milestone v$version complete: UAT issue #$n opened"
