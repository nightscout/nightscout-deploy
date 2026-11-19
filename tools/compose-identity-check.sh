#!/usr/bin/env bash
# Check committed deployment custody.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
[ "$#" -eq 0 ] || { echo 'usage: compose-identity-check.sh'; exit 64; }
[ -z "$(git -C "$here" status --porcelain -- bindings/compose/multitenant)" ] || {
  echo 'FAIL: deployment binding has uncommitted changes'; exit 1;
}
tree=$(git -C "$here" rev-parse HEAD:bindings/compose/multitenant)
[ "$(git -C "$here" cat-file -t "$tree")" = tree ]
echo "ok   committed deployment binding $tree"
