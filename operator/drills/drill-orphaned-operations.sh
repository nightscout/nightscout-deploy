#!/usr/bin/env bash
# Drill: the API role is killed with requests in flight and leaves unfinished operation records
# behind. The tenant keeps serving after the role restarts. The records are reported, not blocking:
# a tenant-local restore suspends the tenant, drains in-flight transactions (a killed backend's
# transaction is already gone) and completes without any clearance step (decision
# restore-suspend-drain-replace). Runbook: ../runbooks/role-death-mid-operation.md
set -euo pipefail
drill=orphaned-operations
source "$(dirname "$0")/lib.sh"
name=oo; fresh $name
tenant=$(driver oo-seed seed $name | field tenant)
before=$("$here/precheck.sh" "$tenant" || true)
audits_before=$(sql "SELECT count(*) FROM nsdemo_control.tenant_lifecycle_restore_audit WHERE tenant_id='$tenant'")
step precheck-allows-before "$(echo "$before" | field start)" true
[ "$(echo "$before" | field start)" = true ] || printf '{"drill":"%s","step":"precheck-reasons-before","observed":%s}\n' "$drill" "$(echo "$before" | field reasons)"
( driver oo-churn churn $name --tenant a --count 2000 >/dev/null 2>&1 || true ) &
wait_file "$drill_state/$name.churn-started" 30 || true; sleep 1.5
docker kill "$(container api)" >/dev/null
docker kill "$NS_DRILL_PROJECT-oo-churn" >/dev/null 2>&1 || true; wait || true
"$stack" compose up -d --no-build --pull never --wait --wait-timeout 300 api >/dev/null 2>&1
# Counted after the role is back: a database backend may finish its own record just after the kill.
sleep 3; orphans=$(unfinished "$tenant")
printf '{"drill":"%s","step":"unfinished-records-after-role-restart","observed":%s}\n' "$drill" "$orphans"
[ "$orphans" -gt 0 ] || { printf '{"drill":"%s","result":"inconclusive","reason":"no request was in flight at the kill"}\n' "$drill"; exit 2; }
step tenant-serves-after-role-restart "$(driver oo-p1 probe $name --tenant a | field admitted)" true
# The unfinished records are reported, never a reason to refuse the restore.
step precheck-allows-with-unfinished-records "$("$here/precheck.sh" "$tenant" | field start)" true
records_before=$(unfinished_records "$tenant")
step restore-completes "\"$(driver oo-r1 restore $name | field state)\"" '"activated"'
step restore-claim-recorded "$(sql "SELECT count(*) - $audits_before FROM nsdemo_control.tenant_lifecycle_restore_audit WHERE tenant_id='$tenant'")" 1
# The operation records themselves are untouched; nothing edits or clears them.
step operation-records-untouched "$(unfinished_records "$tenant")" "$records_before"
step tenant-open-after-restore "\"$(window "$tenant")\"" '"active|false|false"'
step state-restored "$(driver oo-vs verify-state $name | field pass)" true
step other-tenant-writes "$(driver oo-b progress $name | field pass)" true
finish
