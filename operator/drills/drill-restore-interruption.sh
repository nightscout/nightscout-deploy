#!/usr/bin/env bash
# Drill: a tenant-local restore interrupted at a known phase. Runbooks:
# ../runbooks/role-death-mid-operation.md and ../runbooks/lost-acknowledgement.md
#   drill-restore-interruption.sh operator-death-in-transaction | operator-death-after-data-commit |
#                                 participant-death | lost-acknowledgement
# Every mode ends with tenant A held closed and this script STOPPING there: it never clears the
# suspension, replays the restore or reopens the tenant. Recovery is a person's decision.
# NS_DRILL_SKIP_FAULT=1 runs the same assertions without injecting the fault (the control: the
# assertions must then fail).
set -euo pipefail
mode=${1:?mode}; drill="restore-interruption:$mode"
source "$(dirname "$0")/lib.sh"
case "$mode" in
  operator-death-in-transaction)   phase=row;       want_audit=suspended ;;
  operator-death-after-data-commit) phase=committed; want_audit=restored ;;
  participant-death)               phase=row;       want_audit=${NS_DRILL_EXPECT_AUDIT:-suspended} ;;
  lost-acknowledgement)            phase=committed; want_audit=restored ;;
  *) echo 'DRILL_USAGE' >&2; exit 64 ;;
esac
name=ri; fresh $name
tenant=$(driver ri-seed seed $name | field tenant)
step window-before "\"$(window "$tenant" | cut -d'|' -f1)\"" '"active"'
rows_before=$(rows_digest "$tenant")
operator_name="$NS_DRILL_PROJECT-ri-op"
( driver ri-op restore $name --hold $phase --hold-ms 120000 > "$drill_state/$name.restore-out" 2>&1 || true ) &
wait_file "$drill_state/$name.hold-$phase" 60 || { step hold-reached '"no"' '"yes"'; finish; }
# While A is held: the other tenant keeps working.
step other-tenant-writes-while-held "$(driver ri-b1 progress $name | field pass)" true
if [ "${NS_DRILL_SKIP_FAULT:-}" != 1 ]; then
  case "$mode" in
    operator-death-*) docker kill "$operator_name" >/dev/null ;;
    participant-death) docker kill "$(container realtime)" >/dev/null ;;
    lost-acknowledgement) docker pause "$(container realtime)" >/dev/null ;;
  esac
fi
touch "$drill_state/$name.release"; wait || true
outcome=$(field error < "$drill_state/$name.restore-out" || true)
case "$mode" in operator-death-*) ;; *) printf '{"drill":"%s","step":"restore-refusal","observed":"%s","cause":"%s"}\n' "$drill" "$outcome" "$(field cause < "$drill_state/$name.restore-out")" ;; esac
[ "$mode" = lost-acknowledgement ] && [ "${NS_DRILL_SKIP_FAULT:-}" != 1 ] && docker unpause "$(container realtime)" >/dev/null
[ "$mode" = participant-death ] && [ "${NS_DRILL_SKIP_FAULT:-}" != 1 ] && "$stack" compose up -d --no-build --pull never --wait --wait-timeout 120 realtime >/dev/null 2>&1

# Persisted state, as the operator reads it.
step window-claim-and-digest-retained "\"$(window "$tenant")\"" '"suspended|true|true"'
step window-phase "\"$(window "$tenant" | cut -d'|' -f1)\"" '"suspended"'
step audit-state "\"$(audit "$tenant")\"" "\"$want_audit\""
step data-committed-marker "\"$( [ -e "$drill_state/$name.data-committed" ] && echo yes || echo no)\"" "\"$( [ "$want_audit" = restored ] && echo yes || echo no)\""
# Stored rows of A, read by the administrator: unchanged when the data transaction never committed.
step tenant-a-stored-rows "\"$( [ "$(rows_digest "$tenant")" = "$rows_before" ] && echo unchanged || echo changed)\"" "\"$( [ "$want_audit" = restored ] && echo changed || echo unchanged)\""
step unfinished-operations "$(unfinished "$tenant")" 0
# Service, as clients see it.
step tenant-a-admitted "$(driver ri-pa probe $name --tenant a | field admitted)" false
step other-tenant-writes-after "$(driver ri-b2 progress $name | field pass)" true
# Nothing reopens it: not time, not a second restore, not a role restart.
sleep 5
step window-phase-after-wait "\"$(window "$tenant" | cut -d'|' -f1)\"" '"suspended"'
step second-restore-refused "\"$(driver ri-op2 restore $name | field error)\"" '"LIFECYCLE_RESTORE_ALREADY_SUSPENDED"'
"$stack" compose restart api >/dev/null 2>&1
"$stack" compose up -d --no-build --pull never --wait --wait-timeout 300 api >/dev/null 2>&1 || true
step api-healthy-after-restart "\"$(docker inspect --format '{{.State.Health.Status}}' "$(container api)")\"" '"healthy"'
step tenant-a-admitted-after-restart "$(driver ri-pa2 probe $name --tenant a | field admitted)" false
step other-tenant-admitted-after-restart "$(driver ri-pb2 probe $name --tenant b | field admitted)" true
step window-phase-after-restart "\"$(window "$tenant" | cut -d'|' -f1)\"" '"suspended"'
printf '{"drill":"%s","stop":"tenant A is held closed; operator decision required (runbooks/README.md, stop conditions)"}\n' "$drill"
finish
