#!/usr/bin/env bash
# Read-only audit of the repository setup the agent pipeline relies on (docs/pipeline.md, "Owner setup").
# Usage: scripts/repo-check.sh [owner/repo]   (default: the current checkout's GitHub repository)
# Prints "REPO-CHECK OK|FAIL|INFO <check>: …" and exits 0 only when every check is OK. Changes nothing; never prints
# secret values (GitHub never returns them anyway).
set -uo pipefail
repo=${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
fails=0
say() { echo "REPO-CHECK $1 $2: $3"; [ "$1" = FAIL ] && fails=$((fails + 1)); return 0; }
api() { gh api "repos/$repo$1" "${@:2}" 2>/dev/null; }

vis=$(api "" --jq '.visibility + " " + (.archived|tostring) + " " + .default_branch')
read -r visibility archived branch <<<"$vis"
[ "$visibility" = public ] && say OK visibility "public" || say FAIL visibility "${visibility:-unknown} (rulesets and environments need a public repo on GitHub Free)"
[ "$archived" = false ] && say OK archived "no" || say FAIL archived "$archived"
[ "$branch" = main ] && say OK default-branch "main" || say FAIL default-branch "$branch"

perm=$(api /actions/permissions/workflow --jq '.default_workflow_permissions + " " + (.can_approve_pull_request_reviews|tostring)')
read -r wfperm canpr <<<"$perm"
[ "$wfperm" = read ] && say OK token-default "read" || say FAIL token-default "${wfperm:-unknown} (Settings → Actions → Workflow permissions: read)"
[ "$canpr" = true ] && say OK actions-create-prs "allowed" || say FAIL actions-create-prs "${canpr:-unknown} (allow GitHub Actions to create and approve pull requests)"
fork=$(api /actions/permissions/fork-pr-contributor-approval --jq .approval_policy)
case "$fork" in
  all_external_contributors) say OK fork-pr-approval "all external contributors" ;;
  "") say INFO fork-pr-approval "not readable (check Settings → Actions → Fork pull request workflows)" ;;
  *) say FAIL fork-pr-approval "$fork (set: require approval for all external contributors)" ;;
esac

for env in agents hardware; do
  e=$(api "/environments/$env" --jq '.deployment_branch_policy | if . == null then "any" elif .custom_branch_policies then "custom" else "protected" end')
  if [ -z "$e" ]; then say FAIL "env-$env" "missing"; continue; fi
  if [ "$e" = custom ]; then
    b=$(api "/environments/$env/deployment-branch-policies" --jq '[.branch_policies[].name] | join(",")')
    [ "$b" = main ] && say OK "env-$env" "deployment branch main" || say FAIL "env-$env" "deployment branches: ${b:-none} (only main)"
  else say FAIL "env-$env" "deployment branches: $e (restrict to main)"; fi
  s=$(api "/environments/$env/secrets" --jq '[.secrets[].name] | join(",")')
  [[ ",$s," == *",CLAUDE_CODE_OAUTH_TOKEN,"* ]] && say OK "env-$env-secret" "CLAUDE_CODE_OAUTH_TOKEN set" || say FAIL "env-$env-secret" "CLAUDE_CODE_OAUTH_TOKEN missing"
done
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
