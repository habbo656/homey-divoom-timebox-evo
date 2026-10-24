#!/usr/bin/env bash
# Hardware job (self-hosted runner): make sure a TimeBox is paired with the running dev build and available.
# Usage: await-device.sh ISSUE [minutes=30]. If none is, asks the owner on the issue to pair it (the only manual
# hardware step: `homey app run` uninstalls the dev build and its devices when a run ends) and polls the Homey on the
# LAN every 20 s. Exit 0 = available, 1 = timeout. Needs GH_TOKEN only for the one comment.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
n=${1:?issue}; mins=${2:-30}
avail() { scripts/homey-api.sh devices get-devices --jq '[.[]|select(.driverId|test("timebox";"i"))|select(.available==true)]|length' 2>/dev/null; }
[ "$(avail)" -ge 1 ] 2>/dev/null && { echo "AWAIT-DEVICE: TimeBox available"; exit 0; }
bash scripts/agent/issue.sh say "$n" "hardware test of #$n is waiting for you: please pair the TimeBox Evo in the Homey app now (Devices → + → Divoom TimeBox Evo). The dev build is installed and running; the test continues by itself as soon as the device shows up (waiting up to $mins min).
<!-- agent-pairing -->"
for ((t = 0; t < mins * 60; t += 20)); do
  sleep 20
  [ "$(avail)" -ge 1 ] 2>/dev/null && { echo "AWAIT-DEVICE: TimeBox paired and available after $((t + 20)) s"; exit 0; }
done
echo "AWAIT-DEVICE: no available TimeBox after $mins min"; exit 1
