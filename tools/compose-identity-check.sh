#!/usr/bin/env bash
# Check committed deployment custody. Semantic core compatibility is measured by
# plan-contract-check.sh against an explicit core commit, not copied helper bytes.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
[ "$#" -eq 0 ] || { echo 'usage: compose-identity-check.sh (use plan-contract-check.sh for core compatibility)'; exit 64; }
[ -z "$(git -C "$here" status --porcelain -- bindings/compose/multitenant)" ] || {
  echo 'FAIL: deployment binding has uncommitted changes'; exit 1;
}
tree=$(git -C "$here" rev-parse HEAD:bindings/compose/multitenant)
[ "$(git -C "$here" cat-file -t "$tree")" = tree ]
echo "ok   committed deployment binding $tree"
