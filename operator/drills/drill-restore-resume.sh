#!/usr/bin/env bash
# Drill: a tenant-local restore is interrupted, and the operator's `resume` reopens the tenant.
# Runbooks: ../runbooks/role-death-mid-operation.md and ../runbooks/lost-acknowledgement.md
#   drill-restore-resume.sh operator-death-in-transaction | operator-death-after-data-commit |
#                           participant-death | lost-acknowledgement
# It runs drill-restore-interruption.sh for the mode (which ends with tenant A held closed), then
# inspects, resumes and checks what clients and the other tenant see.
# NS_DRILL_SKIP_RESUME=1 leaves the resume out (the control: the reopened steps must then fail).
set -euo pipefail
mode=${1:?mode}
case "$mode" in
  operator-death-in-transaction|participant-death) want_case=before-data; want_audit=suspended ;;
  operator-death-after-data-commit|lost-acknowledgement) want_case=data-replaced; want_audit=restored ;;
  *) echo 'DRILL_USAGE' >&2; exit 64 ;;
esac
"$(dirname "$0")/drill-restore-interruption.sh" "$mode" || { printf '{"drill":"restore-resume:%s","result":"fail","reason":"the interruption drill did not end with the tenant held closed"}\n' "$mode"; exit 1; }
drill="restore-resume:$mode"
source "$(dirname "$0")/lib.sh"
name=ri
tenant=$(field tenant < "$drill_state/$name.expect.json")
rows_closed=$(rows_digest "$tenant")
# A write the other tenant completes while A is held closed.
during=$(driver rr-b0 progress $name | field wrote)

seen=$(operator_cli rr-inspect inspect --tenant "$tenant" || true)
claim=$(echo "$seen" | field claimId)
step inspect-case "\"$(echo "$seen" | field interrupted)\"" "\"$want_case\""
step inspect-resumable "$(echo "$seen" | field resumable)" true
step inspect-writes-nothing "\"$(window "$tenant")\"" '"suspended|true|true"'

if [ "$mode" = participant-death ]; then
  # Every role must answer now: with one role stopped the resume is refused and nothing changes.
  "$stack" compose stop realtime >/dev/null 2>&1
  down=$(operator_cli rr-down resume --tenant "$tenant" --claim "$claim" || true)
  printf '{"drill":"%s","step":"resume-refusal-with-a-role-stopped","observed":"%s"}\n' "$drill" "$(echo "$down" | field error)"
  step resume-refused-with-a-role-stopped "\"$( [ -n "$(echo "$down" | field error)" ] && echo refused || echo accepted)\"" '"refused"'
  step still-closed-with-a-role-stopped "\"$(window "$tenant" | cut -d'|' -f1)\"" '"suspended"'
  "$stack" compose up -d --no-build --pull never --wait --wait-timeout 120 realtime >/dev/null 2>&1
fi

if [ "${NS_DRILL_SKIP_RESUME:-}" != 1 ]; then
  result=$(operator_cli rr-resume resume --tenant "$tenant" --claim "$claim" || true)
  step resume-case "\"$(echo "$result" | field interrupted)\"" "\"$want_case\""
  step resume-state "\"$(echo "$result" | field state)\"" '"active"'
fi
step window-open "\"$(window "$tenant")\"" '"active|false|false"'
step restore-audit-unchanged "\"$(audit "$tenant")\"" "\"$want_audit\""
step resume-recorded "\"$(resumed "$claim")\"" "\"$want_case\""
step tenant-a-admitted "$(driver rr-pa probe $name --tenant a | field admitted)" true
if [ "$want_case" = before-data ]; then
  # Nothing was replaced: A's stored rows are what they were while it was closed, and before the restore.
  step tenant-a-stored-rows "\"$( [ "$(rows_digest "$tenant")" = "$rows_closed" ] && echo unchanged || echo changed)\"" '"unchanged"'
  step tenant-a-state-as-before-the-restore "$(driver rr-vs verify-state $name --expect changed | field pass)" true
else
  # The replaced rows were committed before the interruption: A serves the restored state and its history.
  step tenant-a-state-restored "$(driver rr-vs verify-state $name | field pass)" true
  step tenant-a-history-converges "$(driver rr-vh verify-history $name | field pass)" true
fi
# The other tenant lost nothing: the write it made while A was closed is there, and it writes again.
step other-tenant-write-during-closure-present "$(driver rr-l lookup $name --tenant b --id "$during" | field present)" true
step other-tenant-writes-after-resume "$(driver rr-b1 progress $name | field pass)" true
step second-resume-refused "\"$(operator_cli rr-again resume --tenant "$tenant" --claim "$claim" | field error)\"" '"LIFECYCLE_RESUME_NOT_SUSPENDED"'
# The tenant is an ordinary open tenant again: a new restore of the same artifact completes.
step restore-after-resume "\"$(driver rr-restore restore $name | field state)\"" '"activated"'
step state-after-that-restore "$(driver rr-vs2 verify-state $name | field pass)" true
finish
