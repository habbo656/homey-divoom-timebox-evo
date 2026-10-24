#!/usr/bin/env bash
# Check that the hardware test bench is ready. Prints one line per check; exit 0 = ready, 1 = not ready.
# Fixes the one known local blocker itself: the Mac holding a Bluetooth Classic link to the Evo (the Evo then ignores BLE).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ok=1
say() { echo "PREFLIGHT $1: $2"; [ "$1" = FAIL ] && ok=0; }

# Dev runs: LAN token mode first (scripts/homey-dev-run.mjs: no cloud login, no rate limit); the cloud login is only the
# fallback. Local check only (`homey whoami` costs a cloud request and fails during the cloud rate limit).
if out=$(node scripts/homey-dev-run.mjs check 2>&1); then say OK "dev runs over the LAN (no cloud login)"
elif homey select current >/dev/null 2>&1; then say INFO "dev runs fall back to the cloud login (${out##*HOMEY-DEV-RUN: })"
else say FAIL "no LAN key for dev runs and no cloud login (see docs/pipeline.md, \"Homey without the cloud\")"; fi

run=$(scripts/homey-run.sh status)
case "$run" in
  *"installed build"*) say INFO "dev build kept installed on the Homey and holding the BLE link (fine for Homey tests; Mac probes: scripts/homey-run.sh stop --uninstall). ${run#HOMEY-RUN: }" ;;
  *) if [ -d "${TMPDIR:-/tmp}/divoom-hw/lock" ]; then say FAIL "hardware busy (stale lock: scripts/homey-run.sh stop --uninstall)"
     else say OK "hardware lock free"; fi ;;
esac

if command -v imagesnap >/dev/null && imagesnap -l 2>/dev/null | grep -q "=>"; then say OK "camera present"
else say FAIL "no webcam (brew install imagesnap; camera permission for the terminal)"; fi

if command -v blueutil >/dev/null; then
  mac=$(blueutil --paired 2>/dev/null | grep -i timebox | sed -E 's/^address: ([0-9a-f-]+).*/\1/' | head -1)
  if [ -n "$mac" ] && [ "$(blueutil --is-connected "$mac")" = 1 ]; then
    blueutil --disconnect "$mac" && sleep 2
    [ "$(blueutil --is-connected "$mac")" = 1 ] && say FAIL "Mac holds a Classic link to the Evo and could not drop it" \
      || say OK "dropped the Mac's Classic link to the Evo so it accepts BLE again"
  else say OK "Mac has no Classic link to the Evo"; fi
fi

mode=$(scripts/homey-api.sh --mode)
case "$mode" in token*) say OK "homey api mode: token (LAN)" ;; *) say INFO "homey api mode: cloud (rate limited; owner: API key, see docs/pipeline.md)" ;; esac
dev=$(scripts/homey-api.sh devices get-devices --jq '[.[]|select(.driverId|test("timebox";"i"))|{available}]' 2>/dev/null || echo "[]")
if [ "$dev" = "[]" ] || [ -z "$dev" ]; then say INFO "no Timebox device paired on the Homey (needed for device tests; owner pairs it in the Homey app)"
else say OK "Timebox device(s): $(grep -o '"available"' <<<"$dev" | grep -c .) paired, $(grep -o '"available": *true' <<<"$dev" | grep -c .) available (ids: scripts/homey-api.sh devices get-devices)"; fi

[ $ok = 1 ] && echo "PREFLIGHT: ready" || echo "PREFLIGHT: NOT ready"
[ $ok = 1 ]
