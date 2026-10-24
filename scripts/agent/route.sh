#!/usr/bin/env bash
# Decide what an issue/comment event means for the agent pipeline (deterministic, no model, no network).
# Input (env): EVENT ACTION SENDER OWNER BOT(the pipeline app's "<slug>[bot]" login) LABEL ISSUE IS_PR LABELS(comma list) BODY(comment body; untrusted).
# Output: "do=<action>" and "reason=<text>" lines (to $GITHUB_OUTPUT if set, else stdout).
#   none | screen (owner approved → screen + record) | override (owner approves despite a screen flag)
#   revoke (someone else edited an approved issue / set the label) | resume (owner answered or said retry)
#   approve-diff (owner approved a protected-path PR diff) | stop | next (start the next approved issue)
#   uat-check (owner verdict on a UAT issue)
# Only the repository owner can start anything. Bodies are parsed for a fixed command word only.
set -uo pipefail
out() { if [ -n "${GITHUB_OUTPUT:-}" ]; then printf 'do=%s\nreason=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"; else printf 'do=%s\nreason=%s\n' "$1" "$2"; fi; exit 0; }
labels=",${LABELS:-},"
owner=0; [ "${SENDER:-}" = "${OWNER:?}" ] && owner=1
bot=0; [ -n "${BOT:-}" ] && [ "${BOT%\[bot\]}" != "" ] && [ "${SENDER:-}" = "$BOT" ] && bot=1

case "${EVENT:-}/${ACTION:-}" in
  issues/labeled)
    [ "${LABEL:-}" = agent:approved ] || out none "label ${LABEL:-} is not a trigger"
    [ $bot = 1 ] && out none "set by the pipeline itself"
    [ $owner = 1 ] && out screen "owner set agent:approved"
    out revoke "agent:approved can only be set by @$OWNER (set by @${SENDER:-?})" ;;
  issues/edited)
    [[ "$labels" == *",agent:approved,"* ]] || out none "issue not approved"
    [ $owner = 1 ] && out screen "owner edited an approved issue (screen again)"
    [ $bot = 1 ] && out none "edited by the pipeline"
    out revoke "the issue was edited by @${SENDER:-?} after the approval" ;;
  issue_comment/created)
    [ $owner = 1 ] || out none "comment not by the owner (ignored)"
    first=$(printf '%s' "${BODY:-}" | tr -d '\r' | sed -n '/[^[:space:]]/{p;q;}' | sed -E 's/^[[:space:]]+//')
    word=$(printf '%s' "$first" | awk '{print $1}')
    if [[ "$labels" == *",uat,"* ]] && [[ "$word" =~ ^(ACCEPTED|REJECTED)$ ]]; then out uat-check "owner verdict $word"; fi
    case "$first" in
      "/agent approve-diff"*) [ "${IS_PR:-}" = true ] && out approve-diff "owner approved the PR diff" || out none "approve-diff only on a PR" ;;
      "/agent approve"*) [ "${IS_PR:-}" = true ] && out none "approve is for issues" || out screen "owner approved by comment" ;;
      "/agent override"*) out override "owner overrides the screen" ;;
      "/agent answer"*|"/agent retry"*) out resume "owner said /agent $(awk '{print $2}' <<<"$first")" ;;
      "/agent stop"*) out stop "owner stopped the pipeline for this issue" ;;
      "/agent next"*) out next "owner asked for the next issue" ;;
      *) out none "no /agent command" ;;
    esac ;;
  *) out none "event ${EVENT:-}/${ACTION:-} not handled" ;;
esac
