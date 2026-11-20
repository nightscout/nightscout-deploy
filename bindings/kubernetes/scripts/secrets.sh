#!/usr/bin/env bash
# Seeds every Secret the binding references, before apply (decision provisioning-secrets-in).
# Secrets flow into Jobs and roles; nothing is copied out of a Pod and there is no
# acknowledgement step, so one `tk apply` then converges. Nothing it handles is written to the
# repository or printed. Local material lives in a private temporary directory (umask 077) that is
# removed on exit.
#
#   NS_KUBE_CONTEXT=<explicit> NS_RUN_ID=<rendered> \
#     scripts/secrets.sh seed <namespace> <app image>
#
# For evaluator K>1 also set NS_EVALUATOR_WORKERS=<slices.evaluator>.
#
# Creates ns-postgres-password, ns-vault-tls, ns-ca (CA signing key discarded),
# ns-credentials-postgres and ns-credentials-vault (one PostgreSQL password per deployment role
# and the Vault token ids; mounted only by the provision Job), ns-config-<role> (each role's
# credentials, scoped by role) and ns-signing-secret: the deployment signing secret (decision
# deployment-signing-secret), one object mounted into api, admin and tenant-admin. Requires Docker
# and the application image locally.
#
# A fixture restore does not run this script: it re-creates the seed run's Secrets, including
# ns-signing-secret, whose secret derived the public keys in the restored PostgreSQL (issuers refuse
# a key they cannot derive, SIGNING_KEY_MISMATCH).
#
# It refuses to replace existing Secrets. To reseed, delete the owned namespace and start again.
set -euo pipefail
umask 077

usage() { echo "usage: $0 seed <namespace> <app image>" >&2; exit 64; }
[ $# -eq 3 ] && [ "$1" = seed ] || usage
ns=$2 image=$3
: "${NS_KUBE_CONTEXT:?Supply an explicit operator kube context}"
: "${NS_RUN_ID:?Supply the rendered runId}"
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
k() { kubectl --context "$NS_KUBE_CONTEXT" -n "$ns" "$@"; }
owner=$(kubectl --context "$NS_KUBE_CONTEXT" get namespace "$ns" -o jsonpath='{.metadata.labels.nightscout\.org/run-id}')
[ "$owner" = "$NS_RUN_ID" ] || { echo 'REFUSED: namespace run ownership does not match' >&2; exit 65; }
signing_valid() { [ -f "$1" ] && [ ! -L "$1" ] && grep -Eqx '[a-f0-9]{64}' "$1" && [ "$(wc -l < "$1")" -le 1 ]; }
created=()
secret() { local name=$1; shift; k create secret generic "$name" "$@" >/dev/null; created+=("$name"); }
from_dir() { local dir=$1 file; for file in "$dir"/*; do [ -f "$file" ] && printf -- '--from-file=%s=%s\n' "$(basename "$file")" "$file"; done; }

head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$work/postgres-password"
(
  cd "$work"
  openssl req -x509 -newkey rsa:3072 -nodes -keyout ca.key -out ca.crt -days 30 -subj '/CN=Nightscout synthetic Kubernetes CA' 2>/dev/null
  openssl req -newkey rsa:3072 -nodes -keyout server.key -out server.csr -subj '/CN=vault' 2>/dev/null
  printf 'subjectAltName=DNS:vault,DNS:vault-bootstrap\nextendedKeyUsage=serverAuth\n' > server.ext
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 30 -extfile server.ext 2>/dev/null
  rm -f ca.key ca.srl server.csr server.ext
)

# Evaluator K>1: NS_EVALUATOR_WORKERS must equal the rendered slices.evaluator (inventory
# seed.environment). The image renders pgstream.yaml slice_receivers for that roster; leave it
# unset for K=1.
evaluator_env=()
if [ -n "${NS_EVALUATOR_WORKERS:-}" ]; then
  # The upper bound is the image's (evaluator-workers.js MAX_WORKERS); its seed render refuses above it.
  [[ "$NS_EVALUATOR_WORKERS" =~ ^[1-9][0-9]*$ ]] && [ "$NS_EVALUATOR_WORKERS" -ge 2 ] || { echo 'REFUSED: NS_EVALUATOR_WORKERS must be 2 or more, or unset for evaluator K=1' >&2; exit 64; }
  evaluator_env=(-e "NS_EVALUATOR_WORKERS=$NS_EVALUATOR_WORKERS")
fi

case "${NS_INPUT_TRANSPORT:-pgstream}" in
  pgstream) ;;
  writer-driven) evaluator_env+=(-e "NS_INPUT_TRANSPORT=writer-driven") ;;
  *) echo 'REFUSED: unknown NS_INPUT_TRANSPORT' >&2; exit 64 ;;
esac

# Prepare per-role credentials offline in the application image.
mkdir -m 700 "$work/seed"
docker run --rm --network none --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" -w /opt/app \
  -v "$work/seed:/seed" -v "$here/ops:/run/ns-overlay:ro" ${evaluator_env[@]+"${evaluator_env[@]}"} \
  --entrypoint node "$image" /run/ns-overlay/seed.cjs >/dev/null
docs=$work/seed/roles

secret ns-postgres-password --from-file=postgres-password="$work/postgres-password"
secret ns-vault-tls --from-file=server.crt="$work/server.crt" --from-file=server.key="$work/server.key"
secret ns-ca --from-file=ca.crt="$work/ca.crt"
mapfile -t args < <(from_dir "$work/seed/credentials/postgres"); secret ns-credentials-postgres "${args[@]}"
mapfile -t args < <(from_dir "$work/seed/credentials/vault"); secret ns-credentials-vault "${args[@]}"
signing_valid "$work/seed/credentials/signing-secret" || { echo 'REFUSED: the seeded signing secret is missing or invalid' >&2; exit 65; }
secret ns-signing-secret --from-file=signing-secret="$work/seed/credentials/signing-secret"
for role in api realtime evaluator tenant-admin ui admin primer; do
  mapfile -t args < <(from_dir "$docs/$role")
  secret "ns-config-$role" "${args[@]}"
done
if [ "${NS_INPUT_TRANSPORT:-pgstream}" = pgstream ]; then
  secret ns-config-pgstream --from-file=pgstream.yaml="$docs/pgstream/pgstream.yaml"
fi
k label secret "${created[@]}" "nightscout.org/run-id=$NS_RUN_ID" >/dev/null
printf '{"state":"seeded","secrets":[%s]}\n' "$(printf '"%s",' "${created[@]}" | sed 's/,$//')"
