#!/usr/bin/env bash
# Cold whole-deployment backup of the Compose binding: the PostgreSQL volume, the Vault volume
# and the private state directory, taken together with every container of the project stopped.
#   backup.sh <new-absolute-backup-directory>
# The three parts are one unit: ciphertext in PostgreSQL names Transit keys held in the Vault
# volume, and the state directory holds the role credentials, the CA and the unseal custody.
# The backup directory is as sensitive as the deployment itself. Nothing is overwritten.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
target=${1:?new absolute backup directory}
[[ "$target" = /* ]] && [ ! -e "$target" ] || { echo 'BACKUP_TARGET_REFUSED: an absolute path that does not exist yet' >&2; exit 64; }
state=$("$here/stack.sh" state)
folder="$NS_DRILL_CORE/deploy/multitenant"
running=$("$here/stack.sh" compose ps -q --status running | wc -l)
[ "$running" -eq 0 ] || { echo "BACKUP_REQUIRES_STOPPED_DEPLOYMENT: $running container(s) running" >&2; exit 1; }
helper=$("$here/stack.sh" compose config --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).services.postgres.image))')
mkdir -m 0700 "$target"
for volume in postgres-data vault-data; do
  name="${NS_DRILL_PROJECT}_${volume}"
  docker volume inspect "$name" >/dev/null 2>&1 || { echo "BACKUP_VOLUME_MISSING: $volume" >&2; exit 1; }
  docker run --rm --name "$NS_DRILL_PROJECT-backup-$volume" --network none --user 0:0 --entrypoint tar \
    -v "$name:/volume:ro" -v "$target:/backup" "$helper" -C /volume --numeric-owner -cpf "/backup/$volume.tar" .
  docker run --rm --name "$NS_DRILL_PROJECT-backup-own-$volume" --network none --user 0:0 --entrypoint chown \
    -v "$target:/backup" "$helper" "$(id -u):$(id -g)" "/backup/$volume.tar"
  chmod 0600 "$target/$volume.tar"
done
# Sockets are runtime endpoints, recreated by the roles; drill bookkeeping is not deployment state.
tar -C "$state" --exclude='./ipc/*' --exclude='./drill' -cpf "$target/state.tar" .
cp -p "$folder/.env" "$target/deployment.env"
chmod 0600 "$target/state.tar" "$target/deployment.env"
node - "$target" "$NS_DRILL_PROJECT" "$NS_DRILL_IMAGE" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { execFileSync } = require('node:child_process');
const [target, project, image] = process.argv.slice(2);
const env = Object.fromEntries(fs.readFileSync(path.join(target, 'deployment.env'), 'utf8').trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
const digest = name => crypto.createHash('sha256').update(fs.readFileSync(path.join(target, name))).digest('hex');
const files = Object.fromEntries(['postgres-data.tar', 'vault-data.tar', 'state.tar', 'deployment.env'].map(name => [name, digest(name)]));
const imageId = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8' }).trim();
fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({ version: 1, kind: 'compose-cold-backup', project, createdAt: new Date().toISOString(),
  sourceCommit: env.NS_SOURCE_COMMIT, deployCommit: env.NS_DEPLOY_COMMIT, imageId, files }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
process.stdout.write(JSON.stringify({ step: 'backup', state: 'written', sourceCommit: env.NS_SOURCE_COMMIT, deployCommit: env.NS_DEPLOY_COMMIT, files: Object.keys(files).length }) + '\n');
NODE
