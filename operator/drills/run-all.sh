#!/usr/bin/env bash
# The whole rehearsal, in order, on one freshly started synthetic deployment (stack.sh up).
#   run-all.sh <new-directory-for-backups-and-the-log>
# Writes every drill's JSON lines to <directory>/drills.jsonl and prints one line per drill.
# Exit 0 when every drill passed; a drill that could not land its fault reports `inconclusive`.
# The interrupted-bootstrap drill needs its own never-bootstrapped deployment and is run apart.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?new directory}; [[ "$out" = /* ]] && [ ! -e "$out" ] || { echo 'RUN_TARGET_REFUSED' >&2; exit 64; }
mkdir -m 0700 "$out"; log="$out/drills.jsonl"; bad=0
run() { local label=$1; shift; "$@" >> "$log" 2>&1; local rc=$?
  printf '{"drill":"%s","exit":%s}\n' "$label" "$rc"; [ $rc -eq 0 ] || [ $rc -eq 2 ] || bad=1; }
run tenant-restore "$here/drill-tenant-restore.sh"
run export-death "$here/drill-operation-death.sh" export
run ownership-lost-acknowledgement "$here/drill-operation-death.sh" ownership-lost-acknowledgement
run ownership-admin-death "$here/drill-operation-death.sh" ownership-admin-death
run api-death "$here/drill-dependency-restart.sh" api-death
run vault-restart "$here/drill-dependency-restart.sh" vault-restart
run postgres-restart "$here/drill-dependency-restart.sh" postgres-restart
run postgres-outage "$here/drill-dependency-restart.sh" postgres-outage
run source-change "$here/drill-interrupted-bootstrap.sh" source-change
run host-replacement-tampered "$here/drill-host-replacement.sh" "$out/backup-1" --control tampered-archive
run host-replacement-keys-omitted "$here/drill-host-replacement.sh" "$out/backup-2" --control keys-omitted
# Each interruption is followed by the operator's resume (drill-restore-resume.sh runs both).
for mode in operator-death-in-transaction operator-death-after-data-commit participant-death lost-acknowledgement; do
  run "restore-resume:$mode" "$here/drill-restore-resume.sh" "$mode"
done
run orphaned-operations "$here/drill-orphaned-operations.sh"
# Whole-deployment recovery stays rehearsed once: it is the way back when a tenant cannot be resumed.
run restore-interruption:operator-death-in-transaction "$here/drill-restore-interruption.sh" operator-death-in-transaction
run whole-deployment-recovery "$here/drill-whole-deployment-recovery.sh" "$out/backup-2"
# Last: these leave tenants admitted without root custody (stop condition 4) on the drill deployment.
run provision-lost-acknowledgement "$here/drill-operation-death.sh" provision-lost-acknowledgement
NS_DRILL_OTHER_TENANTS=42 run provision-admin-death "$here/drill-operation-death.sh" provision-admin-death
grep -c '"pass":true' "$log" | xargs printf '{"steps-passed":%s,'; grep -c '"pass":false' "$log" | xargs printf '"steps-failed":%s}\n'
exit $bad
