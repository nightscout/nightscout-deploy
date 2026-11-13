#!/usr/bin/env bash
# Whole-deployment recovery from a cold backup, in place: the deployment's current volumes are
# removed, its state directory is set aside (never deleted here), and the backup is restored.
# EVERY tenant returns to the backup instant. Use only after the stop conditions in
# ../runbooks/README.md have been worked through and a person has accepted that loss.
#   recover-from-backup.sh <backup-directory> --accept-loss-since-backup
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
backup=${1:?backup directory}
[ "${2:-}" = "--accept-loss-since-backup" ] || { echo 'RECOVERY_LOSS_NOT_ACCEPTED' >&2; exit 64; }
[ -f "$backup/manifest.json" ] || { echo 'RESTORE_MANIFEST_MISSING' >&2; exit 1; }
state=$("$here/stack.sh" state)
"$here/stack.sh" destroy --confirm-project "$NS_DRILL_PROJECT" >/dev/null 2>&1
aside="$state.aside-$(date +%s)"; mv "$state" "$aside"
"$here/restore-deployment.sh" "$backup"
[ -d "$aside/drill" ] && cp -a "$aside/drill" "$state/drill"
"$here/stack.sh" roles-up >/dev/null 2>&1
printf '{"step":"recover-from-backup","healthy":%s,"setAside":"%s"}\n' "$("$here/stack.sh" ps | grep -c 'running.healthy' || true)" "$(basename "$aside")"
