#!/usr/bin/env bash
# `homey api …` for hardware tests. With an owner API key it uses the CLI's token mode (LAN only, no Athom cloud), which
# avoids the cloud rate limit ("Too many requests"): every plain `homey api` call first makes ~3 cloud requests.
# Credentials: HOMEY_TOKEN + HOMEY_ADDRESS (and HOMEY_PAT for the cloud fallback), loaded by scripts/homey-env.sh.
# Without a key it falls back to the cloud: with HOMEY_PAT (homey-env.sh) instead of the OAuth login. Refuses `raw` and `delete-*` like the deny list. Never prints the key.
set -uo pipefail
# shellcheck source=scripts/homey-env.sh
source "$(dirname "$0")/homey-env.sh"

for a in "$@"; do
  case "$a" in
    raw|call|request|delete-*) echo "homey-api.sh: '$a' is not allowed (use the Homey app)" >&2; exit 2 ;;
  esac
done

if [ "${1:-}" = "--mode" ]; then
  [ -n "${HOMEY_TOKEN:-}" ] && [ -n "${HOMEY_ADDRESS:-}" ] && echo "token" || echo "cloud"
  exit 0
fi

if [ -n "${HOMEY_TOKEN:-}" ] && [ -n "${HOMEY_ADDRESS:-}" ]; then
  exec homey api "$@" --token "$HOMEY_TOKEN" --address "$HOMEY_ADDRESS"
fi
if [ -n "${HOMEY_PAT:-}" ]; then echo "homey-api.sh: no HOMEY_TOKEN/HOMEY_ADDRESS, using the cloud with HOMEY_PAT" >&2
else echo "homey-api.sh: no HOMEY_TOKEN/HOMEY_ADDRESS and no HOMEY_PAT, using the cloud login (rate limited)" >&2; fi
exec homey api "$@"
