#!/usr/bin/env bash
# Creates the Kubernetes Secrets the binding references, at apply time. Nothing it handles is
# written to the repository or printed. Local material lives in a private temporary directory
# (umask 077) that is removed on exit.
#
#   NS_KUBE_CONTEXT=<explicit> NS_RUN_ID=<rendered> scripts/secrets.sh seed <namespace> <compat-arg>
#       create ns-postgres-password, ns-vault-tls and ns-ca. The compatibility argument
#       is retained from the old CLI; no Compose checkout is read. Discard the CA signing key.
#   ... scripts/secrets.sh publish <namespace> <compat-image-arg>
#       export from the owned provision Job's waiting done container before acknowledging
#       completion. Include extensionless source token files and source-owned admin documents.
#       The image argument is retained; no reader Pod or PVC is created by this helper.
#
# Both refuse to replace existing Secrets. Partial publication requires operator diagnosis;
# do not automatically rerun provisioning or delete a namespace with unknown ownership.
set -euo pipefail
umask 077

usage() { echo "usage: $0 seed <namespace> <compose dir> | publish <namespace> <app image>" >&2; exit 64; }
[ $# -eq 3 ] || usage
cmd=$1 ns=$2 arg=$3
: "${NS_KUBE_CONTEXT:?Supply an explicit operator kube context}"
: "${NS_RUN_ID:?Supply the rendered runId}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
k() { kubectl --context "$NS_KUBE_CONTEXT" -n "$ns" "$@"; }
owner=$(kubectl --context "$NS_KUBE_CONTEXT" get namespace "$ns" -o jsonpath='{.metadata.labels.nightscout\.org/run-id}')
[ "$owner" = "$NS_RUN_ID" ] || { echo 'REFUSED: namespace run ownership does not match' >&2; exit 65; }

seed() {
  local compose=$1 # retained CLI argument for compatibility; no external asset dependency
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$work/postgres-password"
  (
    cd "$work"
    openssl req -x509 -newkey rsa:3072 -nodes -keyout ca.key -out ca.crt -days 30 -subj '/CN=Nightscout synthetic Kubernetes CA' 2>/dev/null
    openssl req -newkey rsa:3072 -nodes -keyout server.key -out server.csr -subj '/CN=vault' 2>/dev/null
    printf 'subjectAltName=DNS:vault,DNS:vault-bootstrap\nextendedKeyUsage=serverAuth\n' > server.ext
    openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 30 -extfile server.ext 2>/dev/null
    rm -f ca.key ca.srl server.csr server.ext
  )
  k create secret generic ns-postgres-password --from-file=postgres-password="$work/postgres-password" >/dev/null
  k create secret generic ns-vault-tls --from-file=server.crt="$work/server.crt" --from-file=server.key="$work/server.key" >/dev/null
  k create secret generic ns-ca --from-file=ca.crt="$work/ca.crt" >/dev/null
  k label secret ns-postgres-password ns-vault-tls ns-ca "nightscout.org/run-id=$NS_RUN_ID" >/dev/null
  echo '{"state":"seeded","secrets":["ns-postgres-password","ns-vault-tls","ns-ca"],"configMaps":[]}'
}

publish() {
  local image=$1 role pod uid file member kind filename args # image retained as a compatibility argument; creates no reader Pod
  mapfile -t pods < <(k get pods -l "job-name=provision,nightscout.org/run-id=$NS_RUN_ID" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')
  [ "${#pods[@]}" -eq 1 ] || { echo 'publish: requires exactly one owned provision Pod' >&2; exit 66; }
  pod=${pods[0]}
  uid=$(k get pod "$pod" -o jsonpath='{.metadata.uid}')
  k exec "$pod" -c done -- test -f /state/.ready
  # Private archive flows directly into a private temporary directory, never a log.
  k exec "$pod" -c done -- tar -C /state -cf - api realtime evaluator pgstream tenant-admin ui admin primer | tar -C "$work" -xf -
  [ "$(k get pod "$pod" -o jsonpath='{.metadata.uid}')" = "$uid" ] || { echo 'publish: provision Pod changed' >&2; exit 65; }
  for member in api evaluator realtime; do
    for kind in config env operation; do
      test -f "$work/admin/verification/$member.$kind.json"
    done
  done
  test -f "$work/primer/expected-verification.json"
  for role in api realtime evaluator tenant-admin ui admin primer; do
    args=()
    for file in "$work/$role"/*; do
      [ -f "$file" ] && [ "$(basename "$file")" != complete.json ] && args+=(--from-file="$(basename "$file")=$file")
    done
    if [ "$role" = admin ]; then
      for member in api evaluator realtime; do
        for kind in config env operation; do
          filename="$member.$kind.json"
          test -f "$work/admin/verification/$filename"
          args+=(--from-file="verification-$filename=$work/admin/verification/$filename")
        done
      done
    fi
    k create secret generic "ns-config-$role" "${args[@]}" >/dev/null
    k label secret "ns-config-$role" "nightscout.org/run-id=$NS_RUN_ID" >/dev/null
  done
  k create secret generic ns-config-pgstream --from-file=pgstream.yaml="$work/pgstream/pgstream.yaml" >/dev/null
  k label secret ns-config-pgstream "nightscout.org/run-id=$NS_RUN_ID" >/dev/null
  k exec "$pod" -c done -- touch /state/.exported
  k wait --for=condition=complete job/provision --timeout=30s >/dev/null
  echo '{"state":"published","secrets":["ns-config-api","ns-config-realtime","ns-config-evaluator","ns-config-pgstream","ns-config-tenant-admin","ns-config-ui","ns-config-admin","ns-config-primer"]}'

}

case $cmd in
  seed) seed "$arg" ;;
  publish) publish "$arg" ;;
  *) usage ;;
esac
