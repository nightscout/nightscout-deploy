#!/usr/bin/env bash
# Drill: cold backup, loss of the host, restore onto an empty project, independent verification.
# Runbook: ../runbooks/backup-and-restore.md and ../runbooks/host-and-dependency-replacement.md
#   drill-host-replacement.sh <new-backup-directory> [--control tampered-archive|keys-omitted]
# State is verified by the SQL census (no application involved); history is verified by the
# API history reply of both tenants; they are separate steps with separate results.
# DESTRUCTIVE to this drill project only: its volumes are removed and recreated from the backup.
set -euo pipefail
drill=host-replacement
source "$(dirname "$0")/lib.sh"
backup=${1:?new backup directory}; control=${3:-}
[ "${2:-}" = "" ] || [ "${2:-}" = "--control" ] || { echo 'DRILL_USAGE' >&2; exit 64; }
roles="nginx ui tenant-admin evaluator realtime api admin feed-reader"
fresh hr
driver hr-seed seed hr >/dev/null
before_history=$(driver hr-h1 history-digest hr)
"$stack" compose stop $roles >/dev/null 2>&1
registered_before=$(registered)
"$here/census.sh" > "$drill_state/hr.census-before"
step census-tables-before "$( [ "$(wc -l < "$drill_state/hr.census-before")" -gt 50 ] && echo '"many"' || echo '"few"')" '"many"'
"$stack" stop >/dev/null 2>&1
"$here/backup.sh" "$backup" >/dev/null
step backup-written "\"$( [ -f "$backup/manifest.json" ] && echo yes || echo no)\"" '"yes"'

# Host loss: every volume of the project is gone, and the state directory is set aside.
mkdir -m 0700 "$backup.drill-notes"; cp -p "$drill_state"/hr.* "$backup.drill-notes"/
"$stack" destroy --confirm-project "$NS_DRILL_PROJECT" >/dev/null 2>&1
mv "$state" "$state.lost-$(date +%s)"
step volumes-after-loss "$(docker volume ls -q --filter "label=com.docker.compose.project=$NS_DRILL_PROJECT" | wc -l)" 0

if [ "$control" = tampered-archive ]; then
  # Control: one changed byte in the database archive must refuse before anything is created.
  cp -a "$backup" "$backup.tampered"; printf 'X' | dd of="$backup.tampered/postgres-data.tar" bs=1 seek=4096 conv=notrunc 2>/dev/null
  refusal=$("$here/restore-deployment.sh" "$backup.tampered" 2>&1 >/dev/null | head -1 || true)
  step control-tampered-archive-refused "\"${refusal%%:*}\"" '"RESTORE_ARCHIVE_DIGEST_MISMATCH"'
  step control-nothing-created "$(docker volume ls -q --filter "label=com.docker.compose.project=$NS_DRILL_PROJECT" | wc -l)" 0
  rm -rf "$backup.tampered"
fi

"$here/restore-deployment.sh" "$backup" >/dev/null
mkdir -p -m 0700 "$drill_state"; cp -p "$backup.drill-notes"/hr.* "$drill_state"/

if [ "$control" = keys-omitted ]; then
  # Control: the database and state without the Vault volume. The keys named by the ciphertext
  # are gone; the deployment must refuse to start rather than initialize a new Vault.
  docker volume rm "${NS_DRILL_PROJECT}_vault-data" >/dev/null
  refusal=$("$stack" roles-up 2>&1 | sed -n 's/.*"error":"\([A-Z_]*\)".*/\1/p' | head -1 || true)
  step control-keys-omitted-refused "\"$refusal\"" '"BOOTSTRAP_VAULT_STATE_CHANGED"'
  step control-no-role-started "$("$stack" compose ps -q --status running api realtime evaluator 2>/dev/null | wc -l)" 0
  # Put it back: discard the refused attempt and restore the complete unit again.
  "$stack" destroy --confirm-project "$NS_DRILL_PROJECT" >/dev/null 2>&1
  mv "$state" "$state.refused-$(date +%s)"
  "$here/restore-deployment.sh" "$backup" >/dev/null
  mkdir -p -m 0700 "$drill_state"; cp -p "$backup.drill-notes"/hr.* "$drill_state"/
fi

# State, independently: PostgreSQL alone, before any application role starts.
"$stack" compose up -d --no-build --pull never --wait --wait-timeout 90 postgres >/dev/null 2>&1
"$here/census.sh" > "$drill_state/hr.census-after"
step state-census-identical "\"$(sha256sum < "$drill_state/hr.census-after" | cut -c1-64)\"" "\"$(sha256sum < "$drill_state/hr.census-before" | cut -c1-64)\""

# The registry travels with the backup: every restored tenant is registered, none is left without an entry.
step registered-tenants-restored "$(registered)" "$registered_before"
step restored-rows-without-registry-entry "$(unregistered)" 0
"$stack" roles-up >/dev/null 2>&1 || true
step roles-healthy "$("$stack" ps | grep -c 'running.healthy' || true)" 8
# History, independently: the reply an incremental client gets, per tenant.
after_history=$(driver hr-h2 history-digest hr)
step history-a "$(echo "$after_history" | field a)" "$(echo "$before_history" | field a)"
step history-b "$(echo "$after_history" | field b)" "$(echo "$before_history" | field b)"
step tenant-a-admitted "$(driver hr-pa probe hr --tenant a | field admitted)" true
step other-tenant-writes "$(driver hr-pb progress hr | field pass)" true
# The restored deployment still performs a tenant-local restore (cohort, keys and authority intact).
step tenant-restore-after-replacement "\"$(driver hr-r restore hr | field state)\"" '"activated"'
step tenant-state-after-restore "$(driver hr-v verify-state hr | field pass)" true

# Sensitivity of the census: after the write above it must differ from the backup census.
"$stack" compose stop $roles >/dev/null 2>&1
"$here/census.sh" > "$drill_state/hr.census-changed"
step control-census-detects-change "\"$(cmp -s "$drill_state/hr.census-changed" "$drill_state/hr.census-before" && echo same || echo differs)\"" '"differs"'
"$stack" roles-up >/dev/null 2>&1 || true
step roles-healthy-at-end "$("$stack" ps | grep -c 'running.healthy' || true)" 8
finish
