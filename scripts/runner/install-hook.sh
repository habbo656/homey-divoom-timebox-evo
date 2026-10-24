#!/usr/bin/env bash
# Owner, once per runner (and after every change of scripts/runner/job-started.sh on main):
#   scripts/runner/install-hook.sh /path/to/actions-runner APP_SLUG
# APP_SLUG is the pipeline's GitHub App (repository variable AGENT_BOT_SLUG); its "<slug>[bot]" may trigger jobs.
# Copies the guard to ~/.config/divoom-timebox/ (outside any checkout), registers it in the runner's .env as
# ACTIONS_RUNNER_HOOK_JOB_STARTED and reminds you to restart the runner (the .env is read at start).
set -euo pipefail
runner=${1:?usage: install-hook.sh RUNNER_DIR APP_SLUG}
slug=${2:?usage: install-hook.sh RUNNER_DIR APP_SLUG}
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "bad app slug: $slug"; exit 1; }
[ -f "$runner/.runner" ] || { echo "not a runner directory: $runner"; exit 1; }
dest="$HOME/.config/divoom-timebox/job-started.sh"
mkdir -p "$(dirname "$dest")"
install -m 0755 "$(dirname "$0")/job-started.sh" "$dest"
envf="$runner/.env"; touch "$envf"
repo=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8-sig"))["gitHubUrl"].split("github.com/")[1])' "$runner/.runner")
grep -vE '^(ACTIONS_RUNNER_HOOK_JOB_STARTED|RUNNER_GUARD_REPO|RUNNER_GUARD_BOT)=' "$envf" >"$envf.tmp" || true
echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=$dest" >>"$envf.tmp"
echo "RUNNER_GUARD_REPO=$repo" >>"$envf.tmp"
echo "RUNNER_GUARD_BOT=$slug[bot]" >>"$envf.tmp"
mv "$envf.tmp" "$envf"
echo "installed $dest and registered it in $envf; restart the runner now (Ctrl-C in its terminal, then ./run.sh)"
