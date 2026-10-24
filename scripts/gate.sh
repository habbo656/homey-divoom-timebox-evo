#!/usr/bin/env bash
# Local quality gate (replaces waiting for CI): clean install, lint, format check, build, tests, release version check, Homey validation.
# Prints one PASS/FAIL line per step and the tail of the first failing step. Exit 0 only if all pass.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
out=$(mktemp)
for step in "npm ci" "npm run lint" "npm run format:check" "npm run build" "npm test" "npm run release:check" "homey app validate"; do
  if $step >"$out" 2>&1; then echo "GATE PASS: $step"
  else echo "GATE FAIL: $step"; tail -n 60 "$out"; rm -f "$out"; exit 1; fi
done
rm -f "$out"; echo "GATE: all green"
