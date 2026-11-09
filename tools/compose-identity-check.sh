#!/usr/bin/env bash
# Compares bindings/compose/multitenant against the recorded upstream tree hash, and, when a core
# checkout is given, against that checkout's deploy/multitenant at the recorded commit.
#   tools/compose-identity-check.sh [path-to-cgm-remote-monitor-checkout]
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
recorded_commit=$(sed -n 's/^| upstream commit | `\([0-9a-f]\{40\}\)`.*/\1/p' "$here/bindings/compose/SOURCE.md")
recorded_tree=$(sed -n 's/^| upstream tree hash of that path | `\([0-9a-f]\{40\}\)`.*/\1/p' "$here/bindings/compose/SOURCE.md")
local_tree=$(git -C "$here" rev-parse "HEAD:bindings/compose/multitenant")
dirty=$(git -C "$here" status --porcelain -- bindings/compose/multitenant | wc -l)
fail=0
[ "$dirty" -eq 0 ] || { echo "FAIL: bindings/compose/multitenant has uncommitted changes"; fail=1; }
if [ "$local_tree" = "$recorded_tree" ]; then echo "ok   committed tree matches SOURCE.md ($local_tree)"; else echo "FAIL: committed tree $local_tree differs from SOURCE.md $recorded_tree"; fail=1; fi
if [ "${1:-}" ]; then
  core_tree=$(git -C "$1" rev-parse "$recorded_commit:deploy/multitenant")
  if [ "$core_tree" = "$local_tree" ]; then echo "ok   core $recorded_commit:deploy/multitenant matches ($core_tree)"; else echo "FAIL: core tree $core_tree differs"; fail=1; fi
fi
exit $fail
