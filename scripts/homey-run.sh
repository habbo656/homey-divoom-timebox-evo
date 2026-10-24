#!/usr/bin/env bash
# Run the app on the real Homey in dev mode (--remote: executes on the Homey) and capture its log.
# Safe wrapper for agents: single hardware user (lock), never uses --clean (keeps paired devices).
#
# Homey access: with an owner API key (HOMEY_TOKEN/HOMEY_ADDRESS, see scripts/homey-api.sh) the run goes through
# scripts/homey-dev-run.mjs, which hands the CLI a LAN-only Homey: no cloud login, no cloud request, no rate limit.
# HOMEY_RUN_MODE=lan (pipeline) requires that path, =cloud forces the plain `homey app run --remote` (Athom cloud, a few
# requests per install), =auto (default) uses LAN when the key works and falls back to the cloud with a note. The cloud
# path authenticates with HOMEY_PAT (Homey Developer Tools personal access token) when set, never the OAuth login flow.
#
# The installed dev build is KEPT between test windows (an install takes a minute and drops paired devices).
# `start` reuses the running build when the app sources are unchanged and reinstalls only when they changed. The build
# is uninstalled by `stop --uninstall` (e.g. before a Mac BLE probe, which needs the link) or after HOMEY_RUN_KEEP
# seconds (default 28800 = 8 h) without a `start`.
#
#   homey-run.sh run [seconds]        blocking: run N seconds (default 60, max 300), print the log of this window
#   homey-run.sh SECONDS              same, with a bare number (e.g. `homey-run.sh 90`)
#   homey-run.sh start [seconds]      begin a test window (seconds is accepted for compatibility; the build stays installed)
#   homey-run.sh wait [--session] REGEX [secs]
#                                     block until REGEX appears in this window's log (default 120 s); exit 1 on timeout/exit
#   homey-run.sh log [--session] [lines]
#                                     print the last lines of this window's log (default 200)
#   --session                         use the whole log since the build was installed (app init, first connect and poll
#                                     happened before a reused window started)
#   homey-run.sh stop [--uninstall]   end the window and print its last 400 log lines; the build stays installed unless
#                                     --uninstall (frees the BLE link and the hardware lock)
#   homey-run.sh status               installed build hash, idle deadline, alive or not
#   homey-run.sh [-h|--help|help]     print this usage (exit 2); no argument or an unknown one never starts a run
#
# Exit codes: 2 = usage, 3 = hardware lock held by another process, 4 = Homey not reachable / CLI not ready, 1 = other.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
# HOMEY_TOKEN/HOMEY_ADDRESS for LAN runs, HOMEY_PAT (exported) for every cloud call of the CLI.
# shellcheck source=scripts/homey-env.sh
source "$root/scripts/homey-env.sh"
state=${TMPDIR:-/tmp}/divoom-hw
lock=$state/lock
log=$state/homey-run.log
mark=$state/log.offset # byte offset where the current test window starts in $log
keep=${HOMEY_RUN_KEEP:-28800}

# The header usage block, to stderr.
usage() { sed -n '/^#   homey-run.sh/,/^# Exit codes/s/^# \{0,1\}//p' "$0" >&2; }
# Validate the command before anything is created: a usage error has no side effects and never starts a run.
bad() { echo "HOMEY-RUN: $1" >&2; usage; exit 2; }
case "${1:-}" in
  ''|-h|--help|help) usage; exit 2;;
  run) [[ "${2:-60}" =~ ^[0-9]+$ ]] || bad "seconds must be a number, got '$2'";;
  start|wait|log|stop|status) ;;
  *) [[ "$1" =~ ^[0-9]+$ ]] || bad "unknown command '$1'";;
esac
mkdir -p "$state"

num() { [[ "${1:-}" =~ ^[0-9]+$ ]] && echo "$1" || echo "$2"; }
clamp() { [ "$1" -gt "$2" ] && echo "$2" || echo "$1"; }
size() { stat -f%z "$log" 2>/dev/null || stat -c%s "$log" 2>/dev/null || echo 0; }
# This window's log: everything after the mark (or the whole log since the install with --session).
session=0
window() {
  local off=0; [ "$session" = 1 ] || off=$(cat "$mark" 2>/dev/null || echo 0)
  tail -c +"$((off + 1))" "$log" 2>/dev/null
}
# The CLI of the installed build is still running (checks the command too, so a reused PID does not count).
alive() {
  local pid; pid=$(cat "$lock/app.pid" 2>/dev/null) || return 1
  [ -n "$pid" ] && ps -p "$pid" -o command= 2>/dev/null | grep -qE 'app run|homey-dev-run\.mjs run'
}
# Hash of everything that goes into the build; docs, scripts, tests and pipeline files do not trigger a reinstall.
build_hash() {
  (cd "$root" && git ls-files -z -co --exclude-standard -- . ':(exclude)docs' ':(exclude)scripts' ':(exclude).github' \
    ':(exclude).claude' ':(exclude).hwtest' ':(exclude)*.md' ':(exclude)*.test.ts' ':(exclude)*__fixtures__*'
    if [ -f env.json ]; then printf 'env.json\0'; fi) | # gitignored, but the CLI bundles it
    (cd "$root" && xargs -0 shasum 2>/dev/null) | shasum | cut -c1-12
}

preflight() { # sets $runner: lan | cloud
  local mode=${HOMEY_RUN_MODE:-auto} out
  if [ "$mode" != cloud ]; then
    if out=$(node "$root/scripts/homey-dev-run.mjs" check 2>&1); then runner=lan; return 0; fi
    [ "$mode" = lan ] && { echo "$out"; echo "HOMEY-RUN: LAN token mode required (HOMEY_RUN_MODE=lan) but not available"; exit 4; }
    echo "HOMEY-RUN: LAN token mode not available, falling back to the cloud login (${out##*HOMEY-DEV-RUN: })"
  fi
  # Local check only: `homey whoami` would cost a cloud request; a missing login shows as the CLI's own error in the log.
  homey select current >/dev/null 2>&1 || { echo "HOMEY-RUN: no Homey selected (owner: homey select; with HOMEY_PAT set no login is needed)"; exit 4; }
  [ -n "${HOMEY_PAT:-}" ] || echo "HOMEY-RUN: no HOMEY_PAT; the cloud run uses the CLI's OAuth login (rate limited)"
  runner=cloud
}
take_lock() {
  if ! mkdir "$lock" 2>/dev/null; then
    owner=$(cat "$lock/pid" 2>/dev/null || true)
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
      rm -rf "$lock"; mkdir "$lock" || exit 3   # stale lock from a crashed run
    else
      echo "HOMEY-RUN: hardware busy (lock $lock, pid ${owner:-?})"; exit 3
    fi
  fi
}
stop_pid() {
  local pid=$1
  kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM "$pid" 2>/dev/null
  for ((i = 0; i < 20; i++)); do kill -0 "$pid" 2>/dev/null || return 0; sleep 1; done
  kill -9 "$pid" 2>/dev/null
}
uninstall() {
  [ -d "$lock" ] || return 0
  local app; app=$(cat "$lock/app.pid" 2>/dev/null || true)
  [ -f "$lock/pid" ] && kill -9 "$(cat "$lock/pid")" 2>/dev/null   # watchdog first, so it cannot race the stop
  [ -n "$app" ] && stop_pid "$app"   # SIGTERM lets the CLI uninstall the dev build cleanly
  rm -rf "$lock"; echo "HOMEY-RUN: uninstalled ($1)" >>"$log"
}
renew() { echo $(($(date +%s) + keep)) >"$lock/deadline"; }
begin_window() { size >"$mark"; }

# Blocking window: start (reuses the installed build), log for $1 seconds, print this window's log.
blocking() {
  local secs; secs=$(clamp "$1" 300)
  "$0" start || exit $?
  echo "HOMEY-RUN: logging for ${secs}s"
  for ((i = 0; i < secs; i++)); do [ -d "$lock" ] || break; sleep 1; done
  echo "----- last 400 log lines of this window -----"; window | tail -n 400
}

cmd=${1:-}
[[ "$cmd" =~ ^[0-9]+$ ]] && { blocking "$cmd"; exit 0; }   # bare number = blocking window
case "$cmd" in
  run)
    blocking "${2:-60}"
    ;;
  start)
    hash=$(build_hash)
    if alive && [ "$(cat "$lock/hash" 2>/dev/null)" = "$hash" ]; then
      renew; begin_window
      # Repeat the CLI's "Running …" line so `wait 'Running …'` works the same for a reused build.
      running=$(grep -E 'Running `' "$log" | tail -n 1)
      echo "HOMEY-RUN: reusing the installed build $hash (sources unchanged, no reinstall)" >>"$log"
      [ -n "$running" ] && echo "$running" >>"$log"
      echo "HOMEY-RUN: reusing the installed build $hash (no reinstall; log: $log)"
      exit 0
    fi
    if alive; then
      echo "HOMEY-RUN: sources changed ($(cat "$lock/hash" 2>/dev/null) -> $hash), reinstalling"
      uninstall "sources changed"
    elif [ -d "$lock" ]; then
      # The CLI died (e.g. install refused): stop its watchdog first, so it cannot delete the new lock, then start over.
      [ -f "$lock/pid" ] && kill -9 "$(cat "$lock/pid")" 2>/dev/null
      rm -rf "$lock"
    fi
    preflight; take_lock
    echo "$hash" >"$lock/hash"; echo "$runner" >"$lock/runner"; renew
    : >"$log"; begin_window
    # Watchdog: runs the app until it exits or the idle deadline passes (renewed by every start), then uninstalls it.
    nohup bash -c '
      cd "$3" || exit 1
      if [ "$4" = lan ]; then node scripts/homey-dev-run.mjs run >>"$1" 2>&1 & app=$!
      else homey app run --remote >>"$1" 2>&1 & app=$!; fi
      echo "$app" >"$2/app.pid"
      while kill -0 "$app" 2>/dev/null; do
        [ "$(date +%s)" -ge "$(cat "$2/deadline" 2>/dev/null || echo 0)" ] && break
        sleep 5
      done
      if kill -0 "$app" 2>/dev/null; then
        kill -TERM "$app"; for ((i = 0; i < 20; i++)); do kill -0 "$app" 2>/dev/null || break; sleep 1; done
        kill -9 "$app" 2>/dev/null; echo "HOMEY-RUN: idle deadline passed, uninstalled" >>"$1"
      else
        echo "HOMEY-RUN: process exited (build no longer running)" >>"$1"
      fi
      [ "$(cat "$2/pid" 2>/dev/null)" = "$$" ] && rm -rf "$2"' _ "$log" "$lock" "$root" "$runner" >/dev/null 2>&1 &
    echo $! >"$lock/pid"
    echo "HOMEY-RUN: installing build $hash and running it in the background ($runner; kept installed; log: $log)"
    ;;
  wait)
    shift; [ "${1:-}" = "--session" ] && { session=1; shift; }
    re=${1:?usage: homey-run.sh wait [--session] REGEX [secs]}
    secs=$(num "${2:-}" 120)
    for ((i = 0; i < secs; i++)); do
      window | grep -Eq -- "$re" && { window | grep -E -- "$re" | tail -n 3; exit 0; }
      [ -d "$lock" ] || { echo "HOMEY-RUN: run ended before /$re/ appeared"; window | tail -n 60; exit 1; }
      sleep 1
    done
    echo "HOMEY-RUN: timeout after ${secs}s waiting for /$re/"; window | tail -n 60; exit 1
    ;;
  log)
    shift; [ "${1:-}" = "--session" ] && { session=1; shift; }
    [ -f "$log" ] && window | tail -n "$(num "${1:-}" 200)" || echo "HOMEY-RUN: no log yet"
    ;;
  stop)
    if [ "${2:-}" = "--uninstall" ]; then
      [ -d "$lock" ] && uninstall "stop --uninstall" || echo "HOMEY-RUN: no active run"
    elif alive; then
      echo "HOMEY-RUN: window ended; build $(cat "$lock/hash") stays installed (stop --uninstall frees the link)" | tee -a "$log"
    else
      echo "HOMEY-RUN: no active run"
    fi
    echo "----- last 400 log lines of this window -----"; window | tail -n 400
    ;;
  status)
    if alive; then
      echo "HOMEY-RUN: installed build $(cat "$lock/hash") ($(cat "$lock/runner" 2>/dev/null || echo cloud)), current sources $(build_hash), idle uninstall at $(date -r "$(cat "$lock/deadline")" '+%F %T')"
    else
      echo "HOMEY-RUN: no build running"
    fi
    ;;
esac
