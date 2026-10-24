#!/usr/bin/env bash
# Read-only audit of the repository setup the agent pipeline relies on (docs/pipeline.md, "Owner setup").
# Usage: scripts/repo-check.sh [owner/repo]   (default: the current checkout's GitHub repository)
# Prints "REPO-CHECK OK|FAIL|INFO <check>: …" and exits 0 only when every check is OK. Changes nothing; never prints
# secret values (GitHub never returns them anyway).
set -uo pipefail
repo=${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
fails=0
say() { echo "REPO-CHECK $1 $2: $3"; [ "$1" = FAIL ] && fails=$((fails + 1)); return 0; }
api() { local o; o=$(gh api "repos/$repo$1" "${@:2}" 2>/dev/null) || return 1; printf '%s\n' "$o"; }

vis=$(api "" --jq '.visibility + " " + (.archived|tostring) + " " + .default_branch')
read -r visibility archived branch <<<"$vis"
[ "$visibility" = public ] && say OK visibility "public" || say FAIL visibility "${visibility:-unknown} (rulesets and environments need a public repo on GitHub Free)"
[ "$archived" = false ] && say OK archived "no" || say FAIL archived "$archived"
[ "$branch" = main ] && say OK default-branch "main" || say FAIL default-branch "$branch"

perm=$(api /actions/permissions/workflow --jq '.default_workflow_permissions + " " + (.can_approve_pull_request_reviews|tostring)')
read -r wfperm canpr <<<"$perm"
[ "$wfperm" = read ] && say OK token-default "read" || say FAIL token-default "${wfperm:-unknown} (Settings → Actions → Workflow permissions: read)"
# PRs are opened and merged with the bot app's token, so GITHUB_TOKEN no longer needs to create pull requests.
[ "$canpr" = false ] && say OK actions-create-prs "not allowed (not needed)" || say INFO actions-create-prs "${canpr:-unknown} (not needed any more: the bot app opens the PRs; can be switched off)"
fork=$(api /actions/permissions/fork-pr-contributor-approval --jq .approval_policy)
case "$fork" in
  all_external_contributors) say OK fork-pr-approval "all external contributors" ;;
  "") say INFO fork-pr-approval "not readable (check Settings → Actions → Fork pull request workflows)" ;;
  *) say FAIL fork-pr-approval "$fork (set: require approval for all external contributors)" ;;
esac

for env in agents hardware bot; do
  e=$(api "/environments/$env" --jq '.deployment_branch_policy | if . == null then "any" elif .custom_branch_policies then "custom" else "protected" end')
  if [ -z "$e" ]; then say FAIL "env-$env" "missing"; continue; fi
  if [ "$e" = custom ]; then
    b=$(api "/environments/$env/deployment-branch-policies" --jq '[.branch_policies[].name] | join(",")')
    [ "$b" = main ] && say OK "env-$env" "deployment branch main" || say FAIL "env-$env" "deployment branches: ${b:-none} (only main)"
  else say FAIL "env-$env" "deployment branches: $e (restrict to main)"; fi
  s=$(api "/environments/$env/secrets" --jq '[.secrets[].name] | join(",")')
  if [ "$env" != bot ]; then
    [[ ",$s," == *",CLAUDE_CODE_OAUTH_TOKEN,"* ]] && say OK "env-$env-secret" "CLAUDE_CODE_OAUTH_TOKEN set" || say FAIL "env-$env-secret" "CLAUDE_CODE_OAUTH_TOKEN missing"
  fi
  if [ "$env" != agents ]; then
    [[ ",$s," == *",AGENT_APP_PRIVATE_KEY,"* ]] && say OK "env-$env-app-key" "AGENT_APP_PRIVATE_KEY set" || say FAIL "env-$env-app-key" "AGENT_APP_PRIVATE_KEY missing (bot app private key)"
  fi
  if [ "$env" = hardware ]; then
    [[ ",$s," == *",HOMEY_PAT,"* ]] && say OK env-hardware-pat "HOMEY_PAT set" || say FAIL env-hardware-pat "HOMEY_PAT missing (Homey CLI cloud paths would use the OAuth login)"
  fi
done
vars=$(api /actions/variables --jq '[.variables[] | "\(.name)=\(.value)"] | join(" ")')
var() { tr ' ' '\n' <<<"$vars" | sed -n "s/^$1=//p"; }
app_id=$(var AGENT_APP_ID); slug=$(var AGENT_BOT_SLUG); email=$(var AGENT_BOT_EMAIL)
[[ "$app_id" =~ ^[0-9]+$ ]] && say OK var-app-id "AGENT_APP_ID set" || say FAIL var-app-id "AGENT_APP_ID missing (the bot app's App ID)"
if [ -n "$slug" ] && bid=$(gh api "users/$slug%5Bbot%5D" --jq .id 2>/dev/null); then
  say OK var-bot-slug "$slug[bot] exists"
  [ "$email" = "$bid+$slug[bot]@users.noreply.github.com" ] && say OK var-bot-email "matches the bot user" || say FAIL var-bot-email "AGENT_BOT_EMAIL must be $bid+$slug[bot]@users.noreply.github.com"
  inst=$(api /installation --jq .app_slug 2>/dev/null) || inst=""
  [ -z "$inst" ] && say INFO bot-installed "not readable with a user token (check Settings → GitHub Apps)" || say OK bot-installed "$inst"
else
  say FAIL var-bot-slug "AGENT_BOT_SLUG ${slug:-missing} (the bot app's slug; no such bot user)"
fi

rs=$(api /secrets --jq '[.secrets[].name] | join(",")')
[ -z "$rs" ] && say OK repo-secrets "none (secrets live in the environments)" || say INFO repo-secrets "repository-level secrets: $rs (visible to every workflow; prefer environments)"

rules=$(api /rulesets --jq '[.[] | select(.target == "branch") | "\(.id):\(.enforcement)"] | join(" ")')
active=0
for r in $rules; do
  id=${r%%:*}; enf=${r#*:}
  [ "$enf" = active ] || continue
  t=$(api "/rulesets/$id" --jq '[.rules[].type] | join(",")')
  inc=$(api "/rulesets/$id" --jq '.conditions.ref_name.include | join(",")')
  [[ "$inc" == *"~DEFAULT_BRANCH"* || "$inc" == *"refs/heads/main"* ]] || continue
  active=1
  for need in pull_request non_fast_forward deletion; do
    [[ ",$t," == *",$need,"* ]] || say FAIL ruleset "active ruleset $id lacks $need"
  done
done
[ $active = 1 ] && say OK ruleset "active on main" || say FAIL ruleset "no ACTIVE branch ruleset on main (found: ${rules:-none}; enforcement must be Active)"

need="agent:approved agent:needs-owner agent:blocked security:flagged owner:review status:in-progress uat uat-finding type:bug"
have=" $(gh label list -R "$repo" --limit 200 --json name --jq '[.[].name] | join(" ")') "
miss=""; for l in $need; do [[ "$have" == *" $l "* ]] || miss="$miss $l"; done
[ -z "$miss" ] && say OK labels "pipeline labels present" || say FAIL labels "missing:$miss"

run=$(api /actions/runners --jq '[.runners[] | "\(.name):\(.status):\([.labels[].name] | join("+"))"] | join(" ")')
case "$run" in
  *":online:"*macOS*) say OK runner "$(tr ' ' '\n' <<<"$run" | grep ':online:' | cut -d: -f1 | paste -sd, -) online" ;;
  "") say FAIL runner "no self-hosted runner registered" ;;
  *) say FAIL runner "registered but not online/macOS: $run" ;;
esac

for wf in ci agent-intake agent-pipeline agent-uat gate runner-check; do
  st=$(api "/actions/workflows/$wf.yml" --jq .state)
  [ "$st" = active ] && say OK "workflow-$wf" "active" || say FAIL "workflow-$wf" "${st:-missing}"
done

[ $fails -eq 0 ] && echo "REPO-CHECK: all OK" || echo "REPO-CHECK: $fails problem(s)"
[ $fails -eq 0 ]
