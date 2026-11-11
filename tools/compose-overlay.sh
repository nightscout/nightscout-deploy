#!/usr/bin/env bash
# Places this repository's Compose tree over a core checkout at the recorded commit so it can run.
#   tools/compose-overlay.sh <path-to-cgm-remote-monitor-checkout> <target-worktree-dir>
# Creates a detached worktree of core at the recorded commit, replaces deploy/multitenant there with
# bindings/compose/multitenant at this repository's HEAD (git archive: committed files only), writes
# the overlay marker deploy/multitenant/.overlay.json (this checkout's path and HEAD), and prints the
# directory. It runs nothing. With the marker, prepare.js and build.js check core HEAD for every
# other build input and this commit for deploy/multitenant, and build the image from the two
# commits (labels org.opencontainers.image.revision and org.nightscout.deploy.revision).
set -euo pipefail
core=${1:?core checkout}; target=${2:?target worktree dir}
here=$(cd "$(dirname "$0")/.." && pwd)
commit=$(sed -n 's/^| upstream commit | `\([0-9a-f]\{40\}\)`.*/\1/p' "$here/bindings/compose/SOURCE.md")
[ -e "$target" ] && { echo "target exists: $target" >&2; exit 1; }
# The overlay is a committed tree: uncommitted edits here would run without being the recorded commit.
[ -z "$(git -C "$here" status --porcelain -- bindings/compose/multitenant)" ] || {
  echo "bindings/compose/multitenant has uncommitted changes; commit them first" >&2; exit 1; }
deploy_commit=$(git -C "$here" rev-parse HEAD)
git -C "$core" worktree add --detach "$target" "$commit"
rm -rf "$target/deploy/multitenant"
mkdir "$target/deploy/multitenant"
git -C "$here" archive "$deploy_commit:bindings/compose/multitenant" | tar -x -C "$target/deploy/multitenant"
printf '{"version":1,"deployRepository":"%s","deployCommit":"%s"}\n' "$here" "$deploy_commit" > "$target/deploy/multitenant/.overlay.json"
echo "$target"
