#!/usr/bin/env bash
# Drill: the one-shot bootstrap (roles, schemas, migrations, grants) is killed part-way, and a
# changed source or deployment revision is offered to an existing deployment (it migrates up).
# Runbook: ../runbooks/interrupted-upgrade.md
#   drill-interrupted-bootstrap.sh interrupted   on a PREPARED, NEVER BOOTSTRAPPED deployment
#   drill-interrupted-bootstrap.sh source-change on a running deployment
# `interrupted` ends by recreating this deployment from nothing, which is the only supported
# way out of a partial bootstrap; it removes this project's volumes and sets its state aside.
set -euo pipefail
mode=${1:?mode}; drill="interrupted-bootstrap:$mode"
here=$(cd "$(dirname "$0")" && pwd); stack="$here/stack.sh"; state=$("$stack" state)
failed=0
step() { [ -n "$2" ] || set -- "$1" null "$3"; printf '{"drill":"%s","step":"%s","observed":%s,"expected":%s,"pass":%s}\n' "$drill" "$1" "$2" "$3" "$([ "$2" = "$3" ] && echo true || echo false)"; [ "$2" = "$3" ] || failed=1; }
code() { sed -n 's/.*"error":"\([A-Z0-9_]*\)".*/\1/p' | tail -1; }
sql() { "$stack" compose exec -T postgres psql -U postgres -d nightscout_compose_test -X -A -t -c "$1"; }
case "$mode" in
interrupted)
  [ ! -e "$state/bootstrap/started.json" ] || { echo 'DRILL_REQUIRES_NEVER_BOOTSTRAPPED_DEPLOYMENT' >&2; exit 64; }
  "$stack" compose up -d --no-build --pull never --wait --wait-timeout 90 postgres vault >/dev/null 2>&1
  ( "$stack" compose --profile ops run --rm --name "$NS_DRILL_PROJECT-bootstrap" bootstrap >/dev/null 2>&1 || true ) &
  # Kill once the run has recorded its start and created at least three application schemas.
  n=0; until [ -e "$state/bootstrap/started.json" ] && [ "$(sql "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'nsdemo\_%'" 2>/dev/null || echo 0)" -ge 3 ]; do n=$((n+1)); [ $n -gt 600 ] && break; sleep 0.05; done
  docker kill "$NS_DRILL_PROJECT-bootstrap" >/dev/null 2>&1 || true; wait || true
  schemas=$(sql "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'nsdemo\_%'")
  printf '{"drill":"%s","step":"schemas-at-death","observed":%s}\n' "$drill" "$schemas"
  step killed-part-way "\"$( [ -e "$state/bootstrap/started.json" ] && [ ! -e "$state/bootstrap/complete.json" ] && [ "$schemas" -ge 1 ] && echo yes || echo no)\"" '"yes"'
  step no-role-credentials-issued "\"$( [ -e "$state/api/env.json" ] || [ -e "$state/admin/env.json" ] && echo issued || echo none)\"" '"none"'
  step rerun-refuses "\"$("$stack" compose --profile ops run --rm bootstrap 2>&1 | code)\"" '"BOOTSTRAP_PARTIAL_RECREATE_DEMO"'
  step no-role-starts "\"$("$stack" compose up -d --no-build --pull never --wait --wait-timeout 20 admin >/dev/null 2>&1 && echo started || echo refused)\"" '"refused"'
  "$stack" compose rm -sf admin >/dev/null 2>&1 || true
  # Control: the start marker is not the only guard. With it set aside, the leftover database
  # objects still refuse the run. The marker is put back afterwards.
  mv "$state/bootstrap/started.json" "$state/bootstrap/started.json.aside"
  step control-marker-removed-still-refuses "\"$("$stack" compose --profile ops run --rm bootstrap 2>&1 | code)\"" '"BOOTSTRAP_OBJECTS_ALREADY_EXIST"'
  rm -f "$state/bootstrap/started.json"; mv "$state/bootstrap/started.json.aside" "$state/bootstrap/started.json"
  # Recovery: recreate this deployment. Nothing of the partial run is adopted.
  folder="$NS_DRILL_CORE/deploy/multitenant"; port=$(sed -n 's/^NS_DEMO_PORT=//p' "$folder/.env")
  "$stack" destroy --confirm-project "$NS_DRILL_PROJECT" >/dev/null 2>&1
  aside="$state.partial-$(date +%s)"; mv "$state" "$aside"; mv "$folder/.env" "$aside/deployment.env"
  (cd "$folder" && node prepare.js --port "$port" --state "$state" >/dev/null)
  step fresh-bootstrap-completes "\"$("$stack" bootstrap 2>/dev/null | sed -n 's/.*"state":"\([a-z-]*\)".*/\1/p' | tail -1)\"" '"synthetic-infrastructure-ready"'
  step completion-recorded "\"$( [ -e "$state/bootstrap/complete.json" ] && echo yes || echo no)\"" '"yes"'
  ;;
source-change)
  before=$(sha256sum < "$state/bootstrap/complete.json")
  other=$(printf 'a%.0s' $(seq 40))
  # A changed revision is brought forward with migrate up, never refused.
  step changed-source-migrates "\"$("$stack" compose --profile ops run --rm -e NS_SOURCE_COMMIT="$other" bootstrap 2>/dev/null | sed -n 's/.*"state":"\([a-z-]*\)".*/\1/p' | tail -1)\"" '"existing-demo-unsealed"'
  step changed-deployment-revision-migrates "\"$("$stack" compose --profile ops run --rm -e NS_DEPLOY_COMMIT="$other" bootstrap 2>/dev/null | sed -n 's/.*"state":"\([a-z-]*\)".*/\1/p' | tail -1)\"" '"existing-demo-unsealed"'
  step completion-record-untouched "\"$(sha256sum < "$state/bootstrap/complete.json" | cut -c1-64)\"" "\"${before%% *}\""
  step control-same-source-accepted "\"$("$stack" bootstrap 2>/dev/null | sed -n 's/.*"state":"\([a-z-]*\)".*/\1/p' | tail -1)\"" '"existing-demo-unsealed"'
  step roles-still-healthy "$("$stack" ps | grep -c 'running.healthy' || true)" 8
  ;;
*) echo 'DRILL_USAGE' >&2; exit 64 ;;
esac
printf '{"drill":"%s","result":"%s"}\n' "$drill" "$([ "$failed" = 0 ] && echo pass || echo fail)"; exit "$failed"
