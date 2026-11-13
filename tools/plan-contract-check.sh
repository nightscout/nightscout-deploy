#!/usr/bin/env bash
# Checks the Compose binding against core at the commit SOURCE.md pins.
#   tools/plan-contract-check.sh [path-to-cgm-remote-monitor-checkout]
#
# Always: bindings/compose/multitenant is committed and is the tree SOURCE.md records.
# With a core checkout: the plan's generated role documents satisfy core's deployment plan
# contract at the pinned commit (core docs/multitenant-plan-contract.md). The pinned commit's
# `nightscout plan check` runs on what bindings/compose/multitenant/plan-documents.js prints,
# once per topology below. Nothing is compared byte for byte with core, and nothing is
# connected to.
#
# It reads and never writes: core at the pinned commit and this repository's committed tree
# are extracted with `git archive` into a scratch directory that is removed on exit. The core
# checkout supplies node_modules; its package-lock.json must be the pinned commit's.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
source_md="$here/bindings/compose/SOURCE.md"
recorded_commit=$(sed -n 's/^| upstream commit | `\([0-9a-f]\{40\}\)`.*/\1/p' "$source_md")
recorded_local=$(sed -n 's/^| tree hash here | `\([0-9a-f]\{40\}\)`.*/\1/p' "$source_md")
local_tree=$(git -C "$here" rev-parse "HEAD:bindings/compose/multitenant")
dirty=$(git -C "$here" status --porcelain -- bindings/compose/multitenant | wc -l)
fail=0
[ -n "$recorded_commit" ] || { echo "FAIL: SOURCE.md names no upstream commit"; exit 1; }
[ "$dirty" -eq 0 ] || { echo "FAIL: bindings/compose/multitenant has uncommitted changes"; fail=1; }
if [ "$local_tree" = "$recorded_local" ]; then echo "ok   committed tree matches SOURCE.md ($local_tree)"; else echo "FAIL: committed tree $local_tree differs from SOURCE.md $recorded_local"; fail=1; fi
if [ "${1:-}" ]; then
  core=$1
  git -C "$core" cat-file -e "$recorded_commit^{commit}" 2>/dev/null || { echo "FAIL: core checkout has no commit $recorded_commit"; exit 1; }
  if ! git -C "$core" cat-file -e "$recorded_commit:lib/server/serve/plan-contract/index.js" 2>/dev/null; then
    echo "FAIL: core $recorded_commit does not publish the deployment plan contract (lib/server/serve/plan-contract)"; exit 1
  fi
  [ -d "$core/node_modules" ] || { echo "FAIL: $core has no node_modules (npm ci in the core checkout)"; exit 1; }
  if [ "$(git -C "$core" rev-parse "$recorded_commit:package-lock.json")" != "$(git -C "$core" hash-object "$core/package-lock.json")" ]; then
    echo "FAIL: the core checkout's package-lock.json is not the pinned commit's; its node_modules cannot stand in"; exit 1
  fi
  scratch=$(mktemp -d); trap 'rm -rf "$scratch"' EXIT
  mkdir -p "$scratch/core/deploy/multitenant"
  # The contract command, and what the plan requires from core by relative path.
  git -C "$core" archive "$recorded_commit" bin lib migrations package.json | tar -x -C "$scratch/core"
  git -C "$here" archive "HEAD:bindings/compose/multitenant" | tar -x -C "$scratch/core/deploy/multitenant"
  ln -s "$(cd "$core" && pwd)/node_modules" "$scratch/core/node_modules"
  # Topologies the plan generates documents for. Realtime placement is not among them (plan-documents.js).
  for topology in "default" "NS_API_REPLICAS=2" "NS_EVALUATOR_WORKERS=2"; do
    set_file="$scratch/set.json"; report="$scratch/report.json"
    if ! ( [ "$topology" = default ] || export "${topology?}"; node "$scratch/core/deploy/multitenant/plan-documents.js" > "$set_file" ) 2> "$scratch/plan.err"; then
      echo "FAIL: [$topology] the plan did not generate its documents: $(tail -n 1 "$scratch/plan.err")"; fail=1; continue
    fi
    if node "$scratch/core/bin/nightscout.js" plan check "$set_file" > "$report" 2> "$scratch/check.err"; then
      echo "ok   [$topology] $(node -e 'const r=require(process.argv[1]);process.stdout.write("contract "+r.contract+": "+r.processes.length+" processes accepted ("+r.processes.map(p=>p.name).join(" ")+")")' "$report")"
    else
      echo "FAIL: [$topology] core $recorded_commit refuses the plan's documents"
      node -e 'const r=require(process.argv[1]);for(const f of r.findings)console.log("       "+f.code+" "+(f.path||"")+": "+f.message);for(const p of r.processes)for(const f of p.findings)console.log("       "+p.name+": "+f.code+(f.document?" "+f.document:"")+(f.path?" "+f.path:"")+": "+f.message)' "$report" 2>/dev/null || tail -n 3 "$scratch/check.err"
      fail=1
    fi
  done
fi
exit $fail
