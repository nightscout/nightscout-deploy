#!/usr/bin/env bash
# Source contract check against exact committed core and deployment inputs.
# No Docker, PG, HTTP or install; no core helper byte comparison.
# tools/plan-contract-check.sh --prospective CORE_CHECKOUT CORE_COMMIT NEW_PRIVATE_OUTPUT
set -euo pipefail
[ "$#" -eq 4 ] && [ "$1" = --prospective ] || { echo 'usage: plan-contract-check.sh --prospective CORE_CHECKOUT CORE_COMMIT NEW_PRIVATE_OUTPUT'; exit 64; }
core=$2; commit=$3; output=$4
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || { echo 'FAIL: exact core commit required'; exit 64; }
[[ "$output" = /* ]] && [ ! -e "$output" ] && [ ! -L "$output" ] || { echo 'FAIL: new absolute private output required'; exit 64; }
here=$(cd "$(dirname "$0")/.." && pwd)
[ -z "$(git -C "$here" status --porcelain -- tools/plan-contract-check.sh tools/prospective-plan-documents.js tools/prospective-plan-documents.test.js)" ] || { echo 'FAIL: prospective tooling must be committed'; exit 1; }
[ "$(git -C "$core" cat-file -t "$commit" 2>/dev/null)" = commit ] || { echo 'FAIL: core identity must be a commit object'; exit 1; }
git -C "$core" cat-file -e "$commit:lib/server/serve/plan-contract/index.js" || { echo 'FAIL: core does not publish the contract'; exit 1; }
[ -d "$core/node_modules" ] || { echo 'FAIL: existing pinned dependencies required'; exit 1; }
[ "$(git -C "$core" rev-parse "$commit:package-lock.json")" = "$(git -C "$core" hash-object "$core/package-lock.json")" ] || { echo 'FAIL: dependency lock mismatch'; exit 1; }
umask 077
mkdir -m 700 "$output"
bash "$here/tools/compose-identity-check.sh" > "$output/identity.stdout" 2> "$output/identity.stderr"
scratch=$(mktemp -d); trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/core/deploy/multitenant" "$scratch/core/tools"
git -C "$core" archive "$commit" bin lib migrations package.json > "$output/core-source.tar"
tar -xf "$output/core-source.tar" -C "$scratch/core"
git -C "$here" archive HEAD:bindings/compose/multitenant > "$output/deploy-bindings.tar"
tar -xf "$output/deploy-bindings.tar" -C "$scratch/core/deploy/multitenant"
git -C "$here" show HEAD:tools/prospective-plan-documents.js > "$scratch/core/tools/prospective-plan-documents.js"
git -C "$here" show HEAD:tools/prospective-plan-documents.test.js > "$scratch/core/tools/prospective-plan-documents.test.js"
ln -s "$(cd "$core" && pwd)/node_modules" "$scratch/core/node_modules"
started=$SECONDS
contract=0
for topology in default api2 evaluator2; do
  remaining=$((120 - (SECONDS-started)))
  [ "$remaining" -gt 0 ] || { contract=1; echo 'FAIL: prospective wall bound'; break; }
  limit=$remaining; [ "$limit" -le 30 ] || limit=30
  vars=(); case "$topology" in api2) vars=(NS_API_REPLICAS=2);; evaluator2) vars=(NS_EVALUATOR_WORKERS=2);; esac
  if (ulimit -f 2048; timeout --kill-after=2 "$limit" env -i PATH="$PATH" HOME="${HOME:-/tmp}" "${vars[@]}" node "$scratch/core/tools/prospective-plan-documents.js") > "$output/$topology.input.json" 2> "$output/$topology.producer.stderr"; then :; else contract=1; echo "FAIL: [$topology] document producer"; continue; fi
  remaining=$((120 - (SECONDS-started))); [ "$remaining" -gt 0 ] || { contract=1; break; }
  limit=$remaining; [ "$limit" -le 30 ] || limit=30
  if (ulimit -f 2048; timeout --kill-after=2 "$limit" env -i PATH="$PATH" HOME="${HOME:-/tmp}" node "$scratch/core/bin/nightscout.js" plan check "$output/$topology.input.json") > "$output/$topology.report.json" 2> "$output/$topology.check.stderr"; then echo "ok   [$topology] prospective core document conformance"; else contract=1; echo "FAIL: [$topology] prospective core document conformance"; fi
done
printf '{"scope":"DEPLOYMENT_CONTRACT_SOURCE_ONLY","coreCommit":"%s","deployCommit":"%s","bindingTree":"%s","contractFailure":%s,"runtimeAcceptance":"UNMEASURED"}\n' "$commit" "$(git -C "$here" rev-parse HEAD)" "$(git -C "$here" rev-parse HEAD:bindings/compose/multitenant)" "$contract" > "$output/result.json"
echo "Contract failures: $contract; runtime UNMEASURED"
[ "$contract" -eq 0 ]
