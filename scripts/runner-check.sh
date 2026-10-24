#!/usr/bin/env bash
# Check that this machine (the self-hosted runner or the owner's Mac) can do hardware work.
# Usage: runner-check.sh [--require LIST] [--scan SECONDS]
#   LIST: comma-separated checks that must be OK (default: bluetooth,homey-api,homey-run,device); the others only inform.
# Checks: tools, bluetooth (radio on), ble (bleak scan works = macOS Bluetooth permission for this process tree),
#         camera (webcam visible = camera permission), homey-cli (cloud login; only the fallback needs it), homey-api (LAN
#         token mode reaches the Homey), homey-run (the key may run dev builds over the LAN: no cloud, no rate limit),
#         device (a Timebox is paired on the Homey and available = on and connected), lock (no foreign hardware run).
# Prints "RUNNER-CHECK OK|FAIL|INFO <check>: …" lines and "RUNNER-CHECK: ready|NOT ready"; exit 0 only if every
# required check is OK. In GitHub Actions it also writes <check>=ok|fail outputs, ready=true|false and a step summary.
# Prints states and counts only: no key, address, user, host, camera or device names (public Actions logs).
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root" || exit 1
require="bluetooth,homey-api,homey-run,device"; scan=4
while [ $# -gt 0 ]; do
  case "$1" in
    --require) require="${2:?--require LIST}"; shift 2 ;;
    --scan) scan="${2:?--scan SECONDS}"; shift 2 ;;
    *) echo "usage: runner-check.sh [--require LIST] [--scan SECONDS]"; exit 2 ;;
  esac
done
[[ "$scan" =~ ^[0-9]+$ ]] || scan=4

declare -a names=() states=() msgs=()
say() { # $1 OK|FAIL|INFO, $2 check, $3 message
  echo "RUNNER-CHECK $1 $2: $3"
  names+=("$2"); states+=("$1"); msgs+=("$3")
}

# tools
missing=""
for t in node npm homey python3 blueutil imagesnap git; do command -v "$t" >/dev/null || missing="$missing $t"; done
[ -z "$missing" ] && say OK tools "node, npm, homey, python3, blueutil, imagesnap, git present" \
  || say FAIL tools "missing:$missing (brew install blueutil imagesnap; nvm; npm i -g homey)"

# bluetooth radio
if command -v blueutil >/dev/null; then
  [ "$(blueutil -p 2>/dev/null)" = 1 ] && say OK bluetooth "radio on" || say FAIL bluetooth "radio off or not accessible (blueutil -p)"
else say FAIL bluetooth "blueutil missing"; fi

# BLE scan through bleak (needs the macOS Bluetooth permission of the process that started the runner)
py=""
for c in "${PROBE_PYTHON:-}" "$root/.venv/bin/python" "$HOME/.cache/divoom-timebox/venv/bin/python"; do
  [ -n "$c" ] && [ -x "$c" ] && "$c" -c 'import bleak' 2>/dev/null && { py="$c"; break; }
done
if [ -z "$py" ]; then say FAIL ble "no Python with bleak (python3 -m venv ~/.cache/divoom-timebox/venv && …/pip install -r scripts/probe/requirements.txt)"
else
  out=$("$py" - "$scan" 2>&1 <<'PY'
import asyncio, sys
from bleak import BleakScanner
async def main(t):
    found = await asyncio.wait_for(BleakScanner.discover(timeout=t, return_adv=True), t + 15)
    names = [(d.name or a.local_name or "") for d, a in found.values()]
    evo = any("timebox" in n.lower() for n in names)
    print(f"{len(found)} {int(evo)}")
asyncio.run(main(float(sys.argv[1])))
PY
)
  rc=$?
  last=$(tail -n 1 <<<"$out")
  if [ $rc -eq 0 ] && [[ "$last" =~ ^([0-9]+)\ ([01])$ ]]; then
    n=${BASH_REMATCH[1]}; evo=${BASH_REMATCH[2]}
    if [ "$n" -gt 0 ]; then
      say OK ble "scan ${scan} s: $n device(s); Timebox advertising: $([ "$evo" = 1 ] && echo yes || echo 'no (normal while the Homey holds its link)')"
    else say FAIL ble "scan ran but saw 0 devices (Bluetooth permission denied for this process tree?)"; fi
  else say FAIL ble "scan failed (rc $rc): $(tr '\n' ' ' <<<"$out" | tail -c 200)"; fi
fi

# camera
if command -v imagesnap >/dev/null && cam=$(imagesnap -l 2>/dev/null | grep '=>' | head -1 | sed 's/=> //') && [ -n "$cam" ]; then
  say OK camera "video device present"
else say FAIL camera "no video device (webcam unplugged, or no camera permission for this process tree)"; fi

# homey CLI (local check only; `homey whoami` costs a cloud request)
homey select current >/dev/null 2>&1 && say OK homey-cli "logged in, Homey selected (cloud fallback only)" \
  || say INFO homey-cli "no cloud login (fine: dev runs use the LAN key)"

# dev runs over the LAN (scripts/homey-dev-run.mjs): reachable, key accepted, scope homey.app
if out=$(node scripts/homey-dev-run.mjs check 2>&1); then say OK homey-run "LAN dev run possible (no cloud login, no rate limit)"
else say FAIL homey-run "${out##*HOMEY-DEV-RUN: }"; fi

# homey API (token mode = LAN, no cloud rate limit) and the Timebox device
mode=$(scripts/homey-api.sh --mode 2>/dev/null)
case "$mode" in
  token*)
    dev=$(scripts/homey-api.sh devices get-devices --jq '[.[]|select(.driverId|test("timebox";"i"))|{available,on:(.capabilitiesObj.onoff.value // null)}]' 2>/dev/null)
    rc=$?
    if [ $rc -ne 0 ] || [ -z "$dev" ]; then
      say FAIL homey-api "request failed (Homey offline, wrong address or key?)"
      say FAIL device "unknown (Homey API not reachable)"
    else
      say OK homey-api "token mode (LAN)"
      compact=$(tr -d ' \n' <<<"$dev")
      paired=$(grep -o '"available"' <<<"$compact" | grep -c . || true)
      avail=$(grep -o '"available":true' <<<"$compact" | grep -c . || true)
      on=$(grep -o '"on":true' <<<"$compact" | grep -c . || true)
      if [ "$paired" -eq 0 ]; then say FAIL device "no Timebox paired on the Homey (owner pairs it in the Homey app)"
      elif [ "$avail" -gt 0 ]; then say OK device "$avail of $paired paired Timebox(es) available, $on switched on"
      else say FAIL device "$paired Timebox(es) paired but unavailable (off, out of range or link lost)"; fi
    fi ;;
  *)
    say FAIL homey-api "no HOMEY_TOKEN/HOMEY_ADDRESS (env, .homey-api.env or ~/.config/divoom-timebox/homey-api.env)"
    say FAIL device "unknown (Homey API not configured)" ;;
esac

# hardware lock (a kept dev build is fine; a stale lock without a build is not)
run=$(scripts/homey-run.sh status 2>/dev/null)
case "$run" in
  *"installed build"*) say INFO lock "dev build installed and holding the BLE link" ;;
  *) [ -d "${TMPDIR:-/tmp}/divoom-hw/lock" ] && say FAIL lock "stale lock (scripts/homey-run.sh stop --uninstall)" || say OK lock "free" ;;
esac

# verdict
ready=true
IFS=',' read -r -a req <<<"$require"
for r in "${req[@]}"; do
  r="${r// /}"; [ -z "$r" ] && continue
  found=0
  for i in "${!names[@]}"; do
    if [ "${names[$i]}" = "$r" ]; then found=1; [ "${states[$i]}" = OK ] || ready=false; fi
  done
  [ $found = 1 ] || { echo "RUNNER-CHECK FAIL $r: unknown check"; ready=false; }
done

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  for i in "${!names[@]}"; do
    case "${states[$i]}" in OK) v=ok ;; FAIL) v=fail ;; *) continue ;; esac
    echo "${names[$i]}=$v" >>"$GITHUB_OUTPUT"
  done
  echo "ready=$ready" >>"$GITHUB_OUTPUT"
fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Runner check: $([ $ready = true ] && echo ready || echo NOT ready)"
    echo; echo "Required: \`$require\`"; echo
    echo "| Check | State | Detail |"; echo "|---|---|---|"
    for i in "${!names[@]}"; do echo "| ${names[$i]} | ${states[$i]} | ${msgs[$i]//|/\\|} |"; done
  } >>"$GITHUB_STEP_SUMMARY"
fi

[ $ready = true ] && echo "RUNNER-CHECK: ready" || echo "RUNNER-CHECK: NOT ready (required: $require)"
[ $ready = true ]
