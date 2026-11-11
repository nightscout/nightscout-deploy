#!/usr/bin/env bash
# The committed render (check/golden/preview.yaml) must equal a fresh `tk show`.
# Refresh with: tk show --dangerous-allow-redirect environments/preview > check/golden/preview.yaml
set -euo pipefail
cd "$(dirname "$0")/.."
fresh=$(mktemp)
trap 'rm -f "$fresh"' EXIT
tk show --dangerous-allow-redirect environments/preview > "$fresh"
if diff -u check/golden/preview.yaml "$fresh"; then echo 'ok   golden render current'; else echo 'FAIL golden render differs from tk show'; exit 1; fi
