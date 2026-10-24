# shellcheck shell=bash
# Homey credentials for the hardware scripts (sourced, not executed). Never prints a value.
#   HOMEY_TOKEN + HOMEY_ADDRESS  owner API key + LAN address: `homey api --token` and LAN dev runs, no Athom cloud
#   HOMEY_PAT                    Athom personal access token (Homey Developer Tools): every cloud path of the Homey CLI
#                                (`homey app run` cloud mode, `homey api` without a key, `homey select`, `homey app
#                                install`) uses it instead of the OAuth login, so no login/refresh flow is involved
# Sources, first value wins: the environment (in GitHub Actions HOMEY_PAT comes from the `hardware` environment
# secret), the gitignored .homey-api.env in the checkout, then
# ${HOMEY_API_ENV:-~/.config/divoom-timebox/homey-api.env} (the runner's checkout has no .homey-api.env). KEY=VALUE lines.
# HOMEY_PAT is exported, because the CLI reads it from its environment.
homey_env_load() {
  local root envfile line k v
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  for envfile in "$root/.homey-api.env" "${HOMEY_API_ENV:-$HOME/.config/divoom-timebox/homey-api.env}"; do
    [ -f "$envfile" ] || continue
    while IFS= read -r line || [ -n "$line" ]; do
      k="${line%%=*}"; v="${line#*=}"
      v="${v%$'\r'}"; v="${v#\"}"; v="${v%\"}"
      case "$k" in
        HOMEY_TOKEN) [ -n "${HOMEY_TOKEN:-}" ] || HOMEY_TOKEN="$v" ;;
        HOMEY_ADDRESS) [ -n "${HOMEY_ADDRESS:-}" ] || HOMEY_ADDRESS="$v" ;;
        HOMEY_PAT) [ -n "${HOMEY_PAT:-}" ] || HOMEY_PAT="$v" ;;
      esac
    done <"$envfile"
  done
  # Tolerate a doubled scheme ("http://http://host") and a trailing slash in the address.
  HOMEY_ADDRESS="${HOMEY_ADDRESS:-}"
  while [[ "$HOMEY_ADDRESS" =~ ^https?://(https?://.*)$ ]]; do HOMEY_ADDRESS="${BASH_REMATCH[1]}"; done
  HOMEY_ADDRESS="${HOMEY_ADDRESS%/}"
  HOMEY_TOKEN="${HOMEY_TOKEN:-}"
  if [ -n "${HOMEY_PAT:-}" ]; then export HOMEY_PAT; else unset HOMEY_PAT; fi
}
homey_env_load
