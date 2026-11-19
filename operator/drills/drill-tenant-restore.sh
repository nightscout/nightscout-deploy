#!/usr/bin/env bash
# Drill: export one tenant, change it, restore it, and verify state and history separately.
# Runbook: ../runbooks/backup-and-restore.md (tenant-local restore)
# Controls built in: both verifications are run BEFORE the restore and must fail there; an
# artifact whose content was changed, and one stored under another digest, must be refused
# without closing the tenant.
set -euo pipefail
drill=tenant-restore
source "$(dirname "$0")/lib.sh"
name=tr; fresh $name
seeded=$(driver tr-seed seed $name); tenant=$(echo "$seeded" | field tenant); digest=$(echo "$seeded" | field digest)
step artifact-published "\"$( [ -f "$state/artifacts/tenant-artifact-$digest/manifest.json" ] && echo yes || echo no)\"" '"yes"'
step control-state-check-fails-before-restore "\"$(driver tr-c1 verify-state $name | field error)\"" '"DRILL_STATE_MISMATCH"'
step control-history-check-fails-before-restore "\"$(driver tr-c2 verify-history $name | field error)\"" '"DRILL_HISTORY_MISMATCH"'

# Control: artifact content changed after export (digest field left as exported).
other=$(printf '%s' "$digest" | tr '0-9a-f' '1-9a-f0')
table="$state/artifacts/tenant-artifact-$digest/entries.entries.csv"
cp -p "$table" "$state/drill/table-original.csv"
printf '\n' >> "$table"
refusal=$(driver tr-c3 restore $name --digest "$digest" | field error || true)
mv "$state/drill/table-original.csv" "$table"
step control-changed-artifact-refused "\"$( [ -n "$refusal" ] && echo refused || echo accepted)\"" '"refused"'
printf '{"drill":"%s","step":"changed-artifact-refusal-code","observed":"%s"}\n' "$drill" "$refusal"
# Control: an intact artifact stored under a different digest name.
cp -a "$state/artifacts/tenant-artifact-$digest" "$state/artifacts/tenant-artifact-$other"
step control-misnamed-artifact-refused "\"$(driver tr-c4 restore $name --digest "$other" | field error)\"" '"LIFECYCLE_ARTIFACT_DIGEST"'
rm -rf "$state/artifacts/tenant-artifact-$other"
step tenant-still-open-after-refusals "\"$(window "$tenant")\"" '"active|false|false"'
step tenant-still-changed-after-refusals "$(driver tr-c5 verify-state $name --expect changed | field pass)" true

step restore "\"$(driver tr-r restore $name | field state)\"" '"activated"'
step state-restored "$(driver tr-v1 verify-state $name | field pass)" true
step history-converges "$(driver tr-v2 verify-history $name | field pass)" true
step other-tenant-unchanged-and-writing "$(driver tr-b progress $name | field pass)" true
# The same round trip through the shipping command line, as the runbook writes it.
cli_digest=$(operator_cli tr-cli1 export --tenant "$tenant" --directory /run/ns-artifacts | field digest || true)
step cli-export-prints-digest "\"$( [[ "$cli_digest" =~ ^[a-f0-9]{64}$ ]] && echo yes || echo no)\"" '"yes"'
step cli-restore "\"$(operator_cli tr-cli2 restore --tenant "$tenant" --directory /run/ns-artifacts --digest "$cli_digest" | field state)\"" '"restored-and-active"'
step cli-restore-unknown-digest-refused "\"$(operator_cli tr-cli3 restore --tenant "$tenant" --directory /run/ns-artifacts --digest "$(printf '0%.0s' $(seq 64))" | field error)\"" '"ENOENT"'
step window-after "\"$(window "$tenant")\"" '"active|false|false"'
step audit-after "\"$(audit "$tenant")\"" '"activated"'
finish
