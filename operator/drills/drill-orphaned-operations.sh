#!/usr/bin/env bash
# Drill: the API role is killed with requests in flight and leaves unfinished operation records
# behind. The tenant keeps serving after the role restarts. A tenant-local restore started now
# refuses before it closes the tenant; the operator clears the records whose owner is gone, and
# the restore then completes. Runbook: ../runbooks/role-death-mid-operation.md
# NS_DRILL_SKIP_CLEARANCE=1 leaves the clearance out (the control: the restore must then still refuse).
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
step precheck-refuses "$("$here/precheck.sh" "$tenant" | field reasons)" '["UNFINISHED_OPERATIONS_PRESENT"]'
# The restore itself refuses, and the tenant stays open.
step restore-refused-before-closing "\"$(driver oo-r1 restore $name | field error)\"" '"LIFECYCLE_RESTORE_PREFLIGHT_ORPHANED_OPERATIONS"'
step tenant-still-open "\"$(window "$tenant")\"" '"active|false|false"'
step no-restore-claim-recorded "$(sql "SELECT count(*) FROM nsdemo_control.tenant_lifecycle_restore_audit WHERE tenant_id='$tenant'")" "$audits_before"
step tenant-serves-after-refusal "$(driver oo-p2 probe $name --tenant a | field admitted)" true
seen=$(operator_cli oo-inspect inspect --tenant "$tenant" || true)
step inspect-counts-owner-gone "$(echo "$seen" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v={};try{v=JSON.parse(s.trim().split("\n").pop())}catch{};process.stdout.write(String(v.operations?v.operations.ownerGone:""))})')" "$orphans"
records_before=$(unfinished_records "$tenant")
if [ "${NS_DRILL_SKIP_CLEARANCE:-}" != 1 ]; then
  cleared=$(operator_cli oo-clear clear-operations --tenant "$tenant" || true)
  count() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v={};try{v=JSON.parse(s.trim().split("\n").pop())}catch{};process.stdout.write(String(Array.isArray(v[process.argv[1]])?v[process.argv[1]].length:""))})' "$1"; }
  step records-cleared "$(echo "$cleared" | count cleared)" "$orphans"
  step records-retained "$(echo "$cleared" | count retained)" 0
fi
# A clearance is a new row; the operation records themselves are untouched.
step operation-records-untouched "$(unfinished_records "$tenant")" "$records_before"
step unfinished-and-not-cleared "$(unfinished "$tenant")" 0
step restore-after-clearance "\"$(driver oo-r2 restore $name | field state)\"" '"activated"'
step tenant-open-after-restore "\"$(window "$tenant")\"" '"active|false|false"'
step state-restored "$(driver oo-vs verify-state $name | field pass)" true
step other-tenant-writes "$(driver oo-b progress $name | field pass)" true
finish
