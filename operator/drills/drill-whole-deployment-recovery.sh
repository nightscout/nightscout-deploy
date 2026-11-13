#!/usr/bin/env bash
# Drill: the decision an operator faces when a tenant is held closed and cannot be reopened by
# any supported command: recover the WHOLE deployment from the last cold backup. It measures
# what that costs the other tenants. Runbook: ../runbooks/README.md (stop conditions) and
# ../runbooks/backup-and-restore.md (whole-deployment recovery).
#   drill-whole-deployment-recovery.sh <backup-directory>
# Start it with tenant A held closed (for example after drill-restore-interruption.sh).
set -euo pipefail
drill=whole-deployment-recovery
source "$(dirname "$0")/lib.sh"
backup=${1:?backup directory}; name=wr
[ -f "$drill_state/ri.expect.json" ] && cp -p "$drill_state/ri.expect.json" "$drill_state/$name.expect.json"
tenant=$(field tenant < "$drill_state/$name.expect.json")
step a-held-closed-before "\"$(window "$tenant" | cut -d'|' -f1)\"" '"suspended"'
# A write the other tenant completes AFTER the backup was taken.
late=$(driver wr-b progress $name | field wrote)
step other-tenant-late-write-present "$(driver wr-l1 lookup $name --tenant b --id "$late" | field present)" true
"$here/recover-from-backup.sh" "$backup" --accept-loss-since-backup >/dev/null
step roles-healthy "$("$stack" ps | grep -c 'running.healthy' || true)" 8
step restored-rows-without-registry-entry "$(unregistered)" 0
step a-open-after-recovery "\"$(window "$tenant")\"" '"active|false|false"'
step both-tenants-admitted-after-recovery "\"$(driver wr-pa history-digest $name | field step)\"" '"history-digest"'
# The cost: the other tenant's write made after the backup is gone.
step other-tenant-late-write-lost "$(driver wr-l2 lookup $name --tenant b --id "$late" | field present)" false
finish
