#!/usr/bin/env bash
# Restore a cold whole-deployment backup (backup.sh) into an empty Compose project: the
# replacement-host procedure. It returns every tenant to the backup instant; writes made after
# the backup are absent afterwards. It refuses to overwrite: the project must have no volumes
# and the state directory must not exist. It starts nothing; run `stack.sh roles-up` after the
# census comparison.
#   restore-deployment.sh <backup-directory>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
: "${NS_DRILL_CORE:?}" "${NS_DRILL_PROJECT:?}" "${NS_DRILL_IMAGE:?}"
case "$NS_DRILL_PROJECT" in recovery-drills-*) ;; *) echo 'DRILL_PROJECT_REFUSED' >&2; exit 64;; esac
source_dir=${1:?backup directory}
folder="$NS_DRILL_CORE/deploy/multitenant"
[ -f "$source_dir/manifest.json" ] || { echo 'RESTORE_MANIFEST_MISSING' >&2; exit 1; }
state=$(sed -n 's/^NS_DEMO_STATE=//p' "$folder/.env")
[ -n "$state" ] && [ ! -e "$state" ] || { echo 'RESTORE_STATE_EXISTS: move the old state directory aside first; it is never overwritten' >&2; exit 1; }
for volume in postgres-data vault-data vault-logs; do
  ! docker volume inspect "${NS_DRILL_PROJECT}_${volume}" >/dev/null 2>&1 || { echo "RESTORE_VOLUME_EXISTS: $volume" >&2; exit 1; }
done
node - "$source_dir" "$folder/.env" "$NS_DRILL_IMAGE" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { execFileSync } = require('node:child_process');
const [source, envFile, image] = process.argv.slice(2);
const refuse = code => { process.stderr.write(code + '\n'); process.exit(1); };
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
if (manifest.version !== 1 || manifest.kind !== 'compose-cold-backup') refuse('RESTORE_MANIFEST_REFUSED');
for (const [name, expected] of Object.entries(manifest.files)) {
  let actual; try { actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(source, name))).digest('hex'); } catch { refuse('RESTORE_ARCHIVE_MISSING: ' + name); }
  if (actual !== expected) refuse('RESTORE_ARCHIVE_DIGEST_MISMATCH: ' + name);
}
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
// Same source and deployment revision only: this is a restore, not an upgrade.
if (env.NS_SOURCE_COMMIT !== manifest.sourceCommit || env.NS_DEPLOY_COMMIT !== manifest.deployCommit) refuse('RESTORE_SOURCE_MISMATCH');
const labels = JSON.parse(execFileSync('docker', ['image', 'inspect', '--format', '{{json .Config.Labels}}', image], { encoding: 'utf8' }));
if (labels?.['org.opencontainers.image.revision'] !== manifest.sourceCommit) refuse('RESTORE_IMAGE_MISMATCH');
NODE
export NS_DEMO_IMAGE="$NS_DRILL_IMAGE"
helper=$(docker compose --project-name "$NS_DRILL_PROJECT" --project-directory "$folder" --env-file "$folder/.env" -f "$folder/compose.yaml" config --format json 2>/dev/null |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).services.postgres.image))')
mkdir -m 0700 "$state"
tar -C "$state" -xpf "$source_dir/state.tar"
mkdir -p -m 0700 "$state/ipc"
for volume in postgres-data vault-data; do
  name="${NS_DRILL_PROJECT}_${volume}"
  docker volume create --label "com.docker.compose.project=$NS_DRILL_PROJECT" --label "com.docker.compose.volume=$volume" "$name" >/dev/null
  docker run --rm --name "$NS_DRILL_PROJECT-restore-$volume" --network none --user 0:0 --entrypoint tar \
    -v "$name:/volume" -v "$source_dir:/backup:ro" "$helper" -C /volume --numeric-owner -xpf "/backup/$volume.tar"
done
printf '{"step":"restore-deployment","state":"volumes-and-state-restored","started":false}\n'
