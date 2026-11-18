#!/usr/bin/env bash
# Read-only check before a tenant-local restore is started. It lets an operator see the blocking
# conditions without starting anything. Unfinished operation records are reported only: the
# restore drains in-flight transactions itself (decision restore-suspend-drain-replace).
#   precheck.sh <tenant-uuid>
# Exit 0: no blocking condition was read. Exit 1: do not start the restore; see the reasons.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tenant=${1:?tenant uuid}
[[ "$tenant" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo 'PRECHECK_USAGE' >&2; exit 64; }
prefix=${NS_DRILL_SCHEMA_PREFIX:-nsdemo}
[[ "$prefix" =~ ^[a-z][a-z0-9]{0,20}$ ]] || { echo 'PRECHECK_USAGE' >&2; exit 64; }
sql() { "$here/stack.sh" compose exec -T postgres psql -U postgres -d nightscout_compose_test -X -A -t -v ON_ERROR_STOP=1 -c "$1"; }
phase=$(sql "SELECT phase FROM ${prefix}_control.tenant_lifecycle_windows WHERE tenant_id='$tenant'")
registry=$(sql "SELECT state FROM ${prefix}_registry.tenant_registry WHERE tenant_id='$tenant'")
count_unfinished() { sql "SELECT count(*) FROM ${prefix}_control.tenant_lifecycle_operations o WHERE tenant_id='$tenant' AND NOT finished AND NOT EXISTS (SELECT 1 FROM ${prefix}_control.tenant_lifecycle_operation_clearance c WHERE c.operation_id=o.operation_id)"; }
# A request in flight has an unfinished marker for as long as it runs. Only a count that is
# still there after re-reading is a blocking condition.
unfinished=$(count_unfinished); tries=0
while [ "$unfinished" != 0 ] && [ $tries -lt 3 ]; do sleep 2; unfinished=$(count_unfinished); tries=$((tries + 1)); done
authority=$(sql "SELECT count(*) FROM ${prefix}_control.tenant_lifecycle_restore_authority WHERE tenant_id='$tenant' AND active")
healthy=0; for role in api realtime evaluator tenant-admin; do
  id=$("$here/stack.sh" compose ps -q "$role"); [ -n "$id" ] && [ "$(docker inspect --format '{{.State.Health.Status}}' "$id")" = healthy ] && healthy=$((healthy + 1))
done
reasons=()
[ "$registry" = active ] || reasons+=("TENANT_NOT_ACTIVE_IN_REGISTRY")
[ "$phase" = active ] || reasons+=("TENANT_WINDOW_NOT_ACTIVE")
[ "$authority" = 1 ] || reasons+=("RESTORE_AUTHORITY_NOT_COMMISSIONED")
[ "$healthy" = 4 ] || reasons+=("PARTICIPANT_NOT_HEALTHY")
printf '{"step":"precheck","phase":"%s","unfinishedOperations":%s,"restoreAuthority":%s,"healthyParticipants":%s,"start":%s,"reasons":[%s]}\n' \
  "$phase" "${unfinished:-null}" "${authority:-0}" "$healthy" "$([ ${#reasons[@]} -eq 0 ] && echo true || echo false)" \
  "$(printf '"%s",' "${reasons[@]}" | sed 's/,$//; s/^""$//')"
[ ${#reasons[@]} -eq 0 ]
