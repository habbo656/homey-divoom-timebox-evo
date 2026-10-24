#!/usr/bin/env bash
# Self-hosted runner job-started hook (ACTIONS_RUNNER_HOOK_JOB_STARTED): refuse every job that is not the pipeline's
# own. The repository is public, and a workflow edited in a branch or fork could otherwise send a job to this Mac.
# Installed OUTSIDE the checkout by scripts/runner/install-hook.sh, so a job cannot change its own guard.
# A job is accepted only when all hold:
#   - repository is the configured one (RUNNER_GUARD_REPO, written by install-hook.sh from the runner registration)
#   - the workflow file comes from main (GITHUB_WORKFLOW_REF ends in @refs/heads/main)
#   - the event is workflow_dispatch, schedule or a push to main (never pull_request*, issues, comments)
#   - the triggering actor is the owner (RUNNER_GUARD_OWNER) or the pipeline bot
set -u
repo=${RUNNER_GUARD_REPO:?RUNNER_GUARD_REPO not set (scripts/runner/install-hook.sh writes it)}
owner=${RUNNER_GUARD_OWNER:-${repo%%/*}}
deny() { echo "::error title=Runner guard::job refused on this runner: $1"; echo "RUNNER-GUARD: refused: $1" >&2; exit 1; }

[ "${GITHUB_REPOSITORY:-}" = "$repo" ] || deny "repository ${GITHUB_REPOSITORY:-?}"
case "${GITHUB_WORKFLOW_REF:-}" in "$repo/.github/workflows/"*"@refs/heads/main") ;; *) deny "workflow ${GITHUB_WORKFLOW_REF:-?} is not from main" ;; esac
case "${GITHUB_EVENT_NAME:-}" in
  workflow_dispatch|schedule) ;;
  push) [ "${GITHUB_REF:-}" = refs/heads/main ] || deny "push to ${GITHUB_REF:-?}" ;;
  *) deny "event ${GITHUB_EVENT_NAME:-?}" ;;
esac
actor=${GITHUB_TRIGGERING_ACTOR:-${GITHUB_ACTOR:-}}
[ "$actor" = "$owner" ] || [ "$actor" = "github-actions[bot]" ] || deny "triggered by ${actor:-?}"
echo "RUNNER-GUARD: accepted ${GITHUB_WORKFLOW_REF##*/} ($GITHUB_EVENT_NAME by $actor)"
