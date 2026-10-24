#!/usr/bin/env bash
# Take a webcam photo of the Timebox Evo display. Usage: hw-snap.sh NAME [delay-seconds=0]
# Saves to .hwtest/<branch>/<NN>-NAME.jpg (gitignored) and prints the path; view it with the Read tool.
set -euo pipefail
name=${1:?usage: hw-snap.sh NAME [delay]}; delay=${2:-0}
[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "HW-SNAP: invalid name"; exit 1; }
[[ "$delay" =~ ^[0-9]+$ ]] || delay=0
root=$(git rev-parse --show-toplevel)
dir="$root/.hwtest/$(git rev-parse --abbrev-ref HEAD | tr '/' '_')"
mkdir -p "$dir"
n=$(printf '%02d' $(( $(ls "$dir" | wc -l) + 1 )))
sleep "$delay"
# -w 1.5: camera warm-up, otherwise the first frame is dark/blurred. Device name override: HW_CAMERA.
imagesnap -q -w 1.5 ${HW_CAMERA:+-d "$HW_CAMERA"} "$dir/$n-$name.jpg" 2>/dev/null
[ -s "$dir/$n-$name.jpg" ] || { echo "HW-SNAP: no image (camera permission/device?)"; exit 1; }
echo "$dir/$n-$name.jpg"
