#!/usr/bin/env bash
# `homey api …` for hardware tests. With an owner API key it uses the CLI's token mode (LAN only, no Athom cloud), which
# avoids the cloud rate limit ("Too many requests"): every plain `homey api` call first makes ~3 cloud requests.
# Key: HOMEY_TOKEN + HOMEY_ADDRESS from the environment, the gitignored .homey-api.env in the repo root, or (for the
# self-hosted runner, whose checkout has no such file) ${HOMEY_API_ENV:-~/.config/divoom-timebox/homey-api.env} (KEY=VALUE lines).
# Without a key it falls back to the plain cloud login. Refuses `raw` and `delete-*` like the deny list. Never prints the key.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
for envfile in "$root/.homey-api.env" "${HOMEY_API_ENV:-$HOME/.config/divoom-timebox/homey-api.env}"; do
  [ -f "$envfile" ] || continue
  while IFS= read -r line || [ -n "$line" ]; do
    k="${line%%=*}"; v="${line#*=}"
    v="${v%$'\r'}"; v="${v#\"}"; v="${v%\"}"
    case "$k" in
      HOMEY_TOKEN) [ -z "${HOMEY_TOKEN:-}" ] && HOMEY_TOKEN="$v" ;;
      HOMEY_ADDRESS) [ -z "${HOMEY_ADDRESS:-}" ] && HOMEY_ADDRESS="$v" ;;
    esac
  done < "$envfile"
done

# Tolerate a doubled scheme ("http://http://host") and a trailing slash in the address.
HOMEY_ADDRESS="${HOMEY_ADDRESS:-}"
while [[ "$HOMEY_ADDRESS" =~ ^https?://(https?://.*)$ ]]; do HOMEY_ADDRESS="${BASH_REMATCH[1]}"; done
HOMEY_ADDRESS="${HOMEY_ADDRESS%/}"

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
echo "homey-api.sh: no HOMEY_TOKEN/HOMEY_ADDRESS (.homey-api.env), using the cloud login (rate limited)" >&2
exec homey api "$@"
