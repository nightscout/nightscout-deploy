#!/usr/bin/env bash
# Current synthetic render determinism; historical preview golden stays unchanged.
set -euo pipefail
cd "$(dirname "$0")/.."
first=$(mktemp)
second=$(mktemp)
trap 'rm -f "$first" "$second"' EXIT
for env in synthetic separate-k1; do
  tk show --dangerous-allow-redirect "environments/$env" > "$first"
  tk show --dangerous-allow-redirect "environments/$env" > "$second"
  diff -u "$first" "$second"
  node check/invariants.js --env "environments/$env"
done
