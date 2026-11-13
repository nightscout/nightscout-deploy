#!/usr/bin/env bash
# Drill: the API role is killed with requests in flight and leaves unfinished operation
# markers behind. The tenant keeps serving after the role restarts, but a tenant-local restore
# started now would close it for good. Runbook: ../runbooks/role-death-mid-operation.md
# The drill shows the pre-check refusing, then (on synthetic state) what happens when the
# pre-check is ignored. It never clears a marker.
set -euo pipefail
drill=orphaned-operations
source "$(dirname "$0")/lib.sh"
name=oo; fresh $name
tenant=$(driver oo-seed seed $name | field tenant)
before=$("$here/precheck.sh" "$tenant" || true)
step precheck-allows-before "$(echo "$before" | field start)" true
[ "$(echo "$before" | field start)" = true ] || printf '{"drill":"%s","step":"precheck-reasons-before","observed":%s}\n' "$drill" "$(echo "$before" | field reasons)"
( driver oo-churn churn $name --tenant a --count 2000 >/dev/null 2>&1 || true ) &
wait_file "$drill_state/$name.churn-started" 30 || true; sleep 1.5
docker kill "$(container api)" >/dev/null
docker kill "$NS_DRILL_PROJECT-oo-churn" >/dev/null 2>&1 || true; wait || true
"$stack" compose up -d --no-build --pull never --wait --wait-timeout 300 api >/dev/null 2>&1
# Counted after the role is back: a database backend may finish its own marker just after the kill.
sleep 3; orphans=$(unfinished "$tenant")
printf '{"drill":"%s","step":"unfinished-markers-after-role-restart","observed":%s}\n' "$drill" "$orphans"
[ "$orphans" -gt 0 ] || { printf '{"drill":"%s","result":"inconclusive","reason":"no request was in flight at the kill"}\n' "$drill"; exit 2; }
step tenant-serves-after-role-restart "$(driver oo-p1 probe $name --tenant a | field admitted)" true
step precheck-refuses "$("$here/precheck.sh" "$tenant" | field reasons)" '["UNFINISHED_OPERATIONS_PRESENT"]'
# What the pre-check prevents. Synthetic state only.
step ignored-precheck-restore-refused "\"$(driver oo-r restore $name | field error)\"" '"LIFECYCLE_RESTORE_DRAIN_TIMEOUT"'
step tenant-now-held-closed "\"$(window "$tenant")\"" '"suspended|true|true"'
step stored-rows-not-restored "\"$(audit "$tenant")\"" '"suspended"'
step tenant-refused "$(driver oo-p2 probe $name --tenant a | field admitted)" false
step other-tenant-writes "$(driver oo-b progress $name | field pass)" true
step markers-still-present "$(unfinished "$tenant")" "$orphans"
cp -p "$drill_state/$name.expect.json" "$drill_state/ri.expect.json"
printf '{"drill":"%s","stop":"unfinished markers are never cleared by hand; tenant A is held closed; operator decision required"}\n' "$drill"
finish
