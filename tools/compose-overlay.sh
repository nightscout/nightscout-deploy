#!/usr/bin/env bash
# Places this repository's Compose tree over a core checkout at the recorded commit so it can run.
#   tools/compose-overlay.sh <path-to-cgm-remote-monitor-checkout> <target-worktree-dir>
# Creates a detached worktree of core at the recorded commit, copies bindings/compose/multitenant
# over deploy/multitenant there, and prints the directory. It runs nothing.
set -euo pipefail
core=${1:?core checkout}; target=${2:?target worktree dir}
here=$(cd "$(dirname "$0")/.." && pwd)
commit=$(sed -n 's/^| upstream commit | `\([0-9a-f]\{40\}\)`.*/\1/p' "$here/bindings/compose/SOURCE.md")
[ -e "$target" ] && { echo "target exists: $target" >&2; exit 1; }
git -C "$core" worktree add --detach "$target" "$commit"
rm -rf "$target/deploy/multitenant"
cp -a "$here/bindings/compose/multitenant" "$target/deploy/multitenant"
echo "$target"
