#!/usr/bin/env bash
# Compares bindings/compose/multitenant against the tree hash recorded in SOURCE.md, and, when a core
# checkout is given, against that checkout's deploy/multitenant at the recorded commit with this
# repository's recorded delta (bindings/compose/SOURCE.delta.patch) applied.
#   tools/compose-identity-check.sh [path-to-cgm-remote-monitor-checkout]
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
source_md="$here/bindings/compose/SOURCE.md"
delta="$here/bindings/compose/SOURCE.delta.patch"
recorded_commit=$(sed -n 's/^| upstream commit | `\([0-9a-f]\{40\}\)`.*/\1/p' "$source_md")
recorded_upstream=$(sed -n 's/^| upstream tree hash of that path | `\([0-9a-f]\{40\}\)`.*/\1/p' "$source_md")
recorded_local=$(sed -n 's/^| tree hash here | `\([0-9a-f]\{40\}\)`.*/\1/p' "$source_md")
local_tree=$(git -C "$here" rev-parse "HEAD:bindings/compose/multitenant")
dirty=$(git -C "$here" status --porcelain -- bindings/compose/multitenant bindings/compose/SOURCE.delta.patch | wc -l)
fail=0
[ "$dirty" -eq 0 ] || { echo "FAIL: bindings/compose/multitenant or the delta has uncommitted changes"; fail=1; }
if [ "$local_tree" = "$recorded_local" ]; then echo "ok   committed tree matches SOURCE.md ($local_tree)"; else echo "FAIL: committed tree $local_tree differs from SOURCE.md $recorded_local"; fail=1; fi
if [ "${1:-}" ]; then
  core_tree=$(git -C "$1" rev-parse "$recorded_commit:deploy/multitenant")
  if [ "$core_tree" = "$recorded_upstream" ]; then echo "ok   core $recorded_commit:deploy/multitenant is the recorded upstream tree ($core_tree)"; else echo "FAIL: core tree $core_tree differs from SOURCE.md $recorded_upstream"; fail=1; fi
  scratch=$(mktemp -d); trap 'rm -rf "$scratch"' EXIT
  mkdir "$scratch/core" "$scratch/here"
  git -C "$1" archive "$recorded_commit:deploy/multitenant" | tar -x -C "$scratch/core"
  git -C "$here" archive "HEAD:bindings/compose/multitenant" | tar -x -C "$scratch/here"
  if [ -s "$delta" ]; then (cd "$scratch/core" && git apply --whitespace=nowarn "$delta"); fi
  if diff -r "$scratch/core" "$scratch/here" >/dev/null; then echo "ok   core tree plus the recorded delta equals this tree"; else echo "FAIL: core tree plus the recorded delta differs from this tree"; fail=1; fi
fi
exit $fail
