#!/usr/bin/env bash
# Soak driver for the stability test (docs/testing/stability.md): drives a paired Timebox on the real Homey for a long
# window and logs what it did. Needs a running dev build with the device paired (scripts/homey-run.sh start) and
# scripts/homey-api.sh configured (never plain `homey api`: cloud rate limit).
#
#   soak.sh --device <id> --minutes <n> [--idle] [--every 300] [--label <name>] [--image-url <url>]
#
#   --device <id>     Homey device id of the paired Timebox (scripts/homey-api.sh devices get-devices)
#   --minutes <n>     length of the soak window
#   --idle            send nothing to the device, only the periodic mem and photo
#   --every <s>       seconds between two actions in active mode (default 300)
#   --label <name>    name of the log file soak-<name>.log (default: active or idle)
#   --image-url <url> picture for the image step (default: a random 3840x2160 JPEG from picsum.photos)
#
# Active mode rotates every --every seconds through: dim, text, clock, lighting, countdown, 4K image URL, temperature,
# mode change. Both modes run the `mem` dev command every 30 min (the line `[dev] memory: ...` lands in the app log, the
# newest one is echoed here) and take a webcam photo every 60 min (scripts/hw-snap.sh). Each is also done at the start
# and at the end. A failing step is logged and the soak goes on: the failure is a finding, not a reason to stop.
# Log: .hwtest/<branch>/soak-<label>.log (gitignored).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
# The Athom CLI's startup announcement must never end up in a step's output (the Flow card check reads it).
export HOMEY_SKIP_STARTUP_NOTIFIERS=1

APP_ID=com.habbo656.divoom-timebox
MEM_EVERY=1800
PHOTO_EVERY=3600

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

device=""
minutes=""
idle=0
every=300
label=""
image_url="https://picsum.photos/3840/2160.jpg"
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --device) device=${2:?--device needs a value}; shift 2 ;;
    --minutes) minutes=${2:?--minutes needs a value}; shift 2 ;;
    --idle) idle=1; shift ;;
    --every) every=${2:?--every needs a value}; shift 2 ;;
    --label) label=${2:?--label needs a value}; shift 2 ;;
    --image-url) image_url=${2:?--image-url needs a value}; shift 2 ;;
    *) echo "soak.sh: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done
[ -n "$device" ] || { echo "soak.sh: --device is required" >&2; usage >&2; exit 2; }
[[ "$device" =~ ^[A-Za-z0-9-]+$ ]] || { echo "soak.sh: invalid --device" >&2; exit 2; }
[[ "$minutes" =~ ^[0-9]+$ ]] && [ "$minutes" -gt 0 ] || { echo "soak.sh: --minutes must be a positive number" >&2; exit 2; }
[[ "$every" =~ ^[0-9]+$ ]] && [ "$every" -gt 0 ] || { echo "soak.sh: --every must be a positive number of seconds" >&2; exit 2; }
if [ -z "$label" ]; then if [ "$idle" = 1 ]; then label=idle; else label=active; fi; fi
[[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "soak.sh: invalid --label" >&2; exit 2; }

branch_dir="$root/.hwtest/$(git rev-parse --abbrev-ref HEAD | tr '/' '_')"
mkdir -p "$branch_dir"
logfile="$branch_dir/soak-$label.log"

say() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" | tee -a "$logfile"; }

# Run a command with a time limit (macOS has no `timeout`): perl arms an alarm and execs the command.
CALL_TIMEOUT=60
with_timeout() { perl -e 'alarm shift; exec @ARGV or exit 127' "$CALL_TIMEOUT" "$@"; }

# attempt_with <check> <what> <command...>: run the command, log its outcome (one line, output trimmed), never abort the
# soak. It counts as failed when it exits non-zero (also on the timeout), or when <check> (called with the output)
# returns 0. An API error exits non-zero; a card's run error comes back in the result's `error` field.
attempt_with() {
  local check=$1 what=$2 out rc=0
  shift 2
  out=$(with_timeout "$@" 2>&1) || rc=$?
  if [ "$rc" = 0 ] && "$check" "$out"; then rc=99; fi
  if [ "$rc" = 0 ]; then say "ok   $what"; else say "FAIL $what (exit $rc): $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)"; fi
}
exit_code_only() { return 1; }
attempt() { attempt_with exit_code_only "$@"; }

# A Flow card run prints its result as JSON, e.g. { "returnTokens": null, "usedTokens": {}, "error": null, ... }.
# card_failed <output> returns 0 when that result carries a non-null "error". Parsed with jq when the output is plain
# JSON; otherwise (no jq, or other lines around it) a regex flags only "error": followed by a non-null value (a string,
# object, array, number or boolean), so "error": null, "Done." or other text never count.
card_failed() {
  local verdict
  if command -v jq >/dev/null 2>&1 &&
    verdict=$(printf '%s' "$1" | jq -r 'if type == "object" and .error != null then "fail" else "ok" end' 2>/dev/null) &&
    [ -n "$verdict" ]; then
    [[ "$verdict" == *fail* ]]
    return
  fi
  printf '%s' "$1" | tr '\n' ' ' | grep -Eq '"error"[[:space:]]*:[[:space:]]*["{[0-9tf-]'
}

dev_seq=0
# Write the app setting devLink. A suffix makes every write a new value (the app only reacts to a write).
# The value is stored literally: no JSON quotes (docs/pipeline.md).
devlink() {
  dev_seq=$((dev_seq + 1))
  attempt "devLink $1" scripts/homey-api.sh apps set-app-setting --id "$APP_ID" --name devLink --value "$1#soak$dev_seq"
}
capability() {
  attempt "set $1=$2" scripts/homey-api.sh devices set-capability-value --device-id "$device" --capability-id "$1" --value "$2"
}
card() {
  attempt_with card_failed "card $1 $2" scripts/homey-api.sh flow run-flow-card-action \
    --uri "homey:flowcardaction:homey:device:${device}:$1" --id "homey:device:${device}:$1" --args "$2"
}

memory_lines() { scripts/homey-run.sh log --session 100000 2>/dev/null | grep 'memory:' || true; }
do_mem() {
  local before after line i
  before=$(( $(memory_lines | wc -l) ))
  devlink mem
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    sleep 1
    after=$(memory_lines)
    if [ "$(printf '%s\n' "$after" | grep -c 'memory:')" -gt "$before" ]; then
      line=$(printf '%s\n' "$after" | tail -n 1)
      say "mem  $line"
      return 0
    fi
  done
  say "mem  no new memory line within 15 s (is the dev build running?)"
}
do_photo() {
  attempt "photo soak-$label-$1" scripts/hw-snap.sh "soak-$label-$1"
}

colors=('#ff0000' '#00ff00' '#0000ff' '#ffff00' '#ff00ff' '#00ffff')
styles=(full_screen rainbow boxed analog_square negative analog_round small)
channels=(lighting custom clock)

# One action of the active rotation; $1 = step counter (0-based).
step() {
  local n=$1 round color
  round=$((n / 8))
  color=${colors[$((round % ${#colors[@]}))]}
  case $((n % 8)) in
    0) if [ $((round % 2)) = 0 ]; then capability dim 0.3; else capability dim 0.8; fi ;;
    1) card timebox_show_text "{\"text\":\"Soak $n\",\"color\":\"$color\",\"background\":\"#000000\",\"speed\":\"normal\",\"duration\":20}" ;;
    2) card timebox_show_clock "{\"style\":\"${styles[$((round % ${#styles[@]}))]}\",\"color\":\"$color\"}" ;;
    3) card timebox_set_lighting "{\"color\":\"$color\"}" ;;
    4) card timebox_start_countdown '{"minutes":0,"seconds":15}' ;;
    5) card timebox_show_image_url "{\"url\":\"$image_url\",\"fit\":\"cover\",\"duration\":20}" ;;
    6) if [ $((round % 2)) = 0 ]; then card timebox_set_temperature '{"temperature":21}'; else card timebox_set_temperature '{"temperature":-5}'; fi ;;
    7) capability timebox_channel "${channels[$((round % ${#channels[@]}))]}" ;;
  esac
}

total=$((minutes * 60))
mode=active
[ "$idle" = 1 ] && mode=idle
say "soak start: device=$device minutes=$minutes mode=$mode every=${every}s label=$label branch=$(git rev-parse --abbrev-ref HEAD)"

start=$SECONDS
next_mem=0
next_photo=0
next_step=0
steps_done=0
while :; do
  elapsed=$((SECONDS - start))
  [ "$elapsed" -ge "$total" ] && break
  if [ "$elapsed" -ge "$next_mem" ]; then
    do_mem
    next_mem=$((elapsed + MEM_EVERY))
  fi
  if [ "$elapsed" -ge "$next_photo" ]; then
    do_photo "$((elapsed / 60))min"
    next_photo=$((elapsed + PHOTO_EVERY))
  fi
  if [ "$idle" = 0 ] && [ "$elapsed" -ge "$next_step" ]; then
    step "$steps_done"
    steps_done=$((steps_done + 1))
    next_step=$((next_step + every))
  fi
  sleep 5
done

say "soak end of window after $(((SECONDS - start) / 60)) min, $steps_done action(s)"
do_mem
do_photo "end"
say "soak done"
