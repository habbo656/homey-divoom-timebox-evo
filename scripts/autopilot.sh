#!/usr/bin/env bash
# Start the autonomous pipeline headless: works through the roadmap via /autopilot. Usage: autopilot.sh [max-issues=1]
# Needs: gh + homey CLI logged in, NTFY_TOPIC in .claude/settings.local.json. Output: .hwtest/autopilot-<time>.log
# Edits are auto-accepted; shell commands are limited to the allowlist in .claude/settings.json (others are denied).
# The orchestrator runs on Sonnet (it follows a checklist; agents pick their own models) to save plan usage.
# If the run ends abnormally (e.g. plan usage limit), the owner gets an ntfy message; a re-run resumes the issue.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
n=${1:-1}; [[ "$n" =~ ^[0-9]+$ ]] || n=1
export NTFY_TOPIC=${NTFY_TOPIC:-$(python3 -c 'import json;print(json.load(open(".claude/settings.local.json"))["env"]["NTFY_TOPIC"])' 2>/dev/null)}
mkdir -p .hwtest
log=".hwtest/autopilot-$(date +%Y%m%d-%H%M%S).log"
echo "autopilot: up to $n issue(s), log $log"
claude -p "/autopilot $n" --model "${AUTOPILOT_MODEL:-sonnet}" --permission-mode acceptEdits --verbose \
  --output-format stream-json 2>&1 | tee "$log" | python3 -c '
import json, sys
for line in sys.stdin:
    try: m = json.loads(line)
    except ValueError: continue
    if m.get("type") == "assistant":
        for b in m["message"].get("content", []):
            if b.get("type") == "text" and b["text"].strip(): print(b["text"].strip(), flush=True)
    elif m.get("type") == "result":
        print("== done:", m.get("subtype"), "api-equivalent cost $%.2f" % (m.get("total_cost_usd") or 0))'
rc=${PIPESTATUS[0]}
result=$(grep '"type":"result"' "$log" | tail -n 1)
if [ "$rc" -ne 0 ] || [ -z "$result" ] || ! grep -q '"subtype":"success"' <<<"$result" || grep -q '"is_error":true' <<<"$result"; then
  hint=$(grep -oiE "(usage|rate) limit[^\"]{0,80}" "$log" | tail -n 1)
  scripts/notify.sh info "autopilot stopped" "Run ended abnormally (exit $rc). ${hint:-See $log.} Re-run scripts/autopilot.sh to resume." || true
  exit 1
fi
