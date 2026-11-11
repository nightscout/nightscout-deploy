#!/usr/bin/env bash
# Creates the Kubernetes Secrets the binding references, at apply time. Nothing it handles is
# written to the repository or printed. Local material lives in a private temporary directory
# (umask 077) that is removed on exit.
#
#   scripts/secrets.sh seed    <namespace> <bindings/compose dir>
#       generate the PostgreSQL superuser password and the Vault demo CA and server certificate
#       (the Compose prepare.js material: 30 days, SAN DNS:vault), create the Secrets
#       ns-postgres-password, ns-vault-tls and ns-ca, and the ConfigMap ownership-grants from the
#       Compose ownership overlay's script. The CA signing key is discarded.
#
#   scripts/secrets.sh publish <namespace> <app image>
#       after Job/provision completes: copy each role's private documents out of the provision
#       state volume through a short-lived reader Pod and create ns-config-<role> for api,
#       realtime, evaluator, tenant-admin, ui and admin.
#
# Both refuse to replace an existing Secret: recreate the namespace for a fresh demonstration.
set -euo pipefail
umask 077

usage() { echo "usage: $0 seed <namespace> <compose dir> | publish <namespace> <app image>" >&2; exit 64; }
[ $# -eq 3 ] || usage
cmd=$1 ns=$2 arg=$3
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
k() { kubectl -n "$ns" "$@"; }

seed() {
  local compose=$1 grants
  grants="$compose/ownership-admin/ownership-grants.js"
  [ -f "$grants" ] || { echo "seed: $grants is missing (the Compose ownership overlay)" >&2; exit 66; }
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$work/postgres-password"
  (
    cd "$work"
    openssl req -x509 -newkey rsa:3072 -nodes -keyout ca.key -out ca.crt -days 30 -subj '/CN=Nightscout synthetic Kubernetes CA' 2>/dev/null
    openssl req -newkey rsa:3072 -nodes -keyout server.key -out server.csr -subj '/CN=vault' 2>/dev/null
    printf 'subjectAltName=DNS:vault\nextendedKeyUsage=serverAuth\n' > server.ext
    openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 30 -extfile server.ext 2>/dev/null
    rm -f ca.key ca.srl server.csr server.ext
  )
  k create secret generic ns-postgres-password --from-file=postgres-password="$work/postgres-password" >/dev/null
  k create secret generic ns-vault-tls --from-file=server.crt="$work/server.crt" --from-file=server.key="$work/server.key" >/dev/null
  k create secret generic ns-ca --from-file=ca.crt="$work/ca.crt" >/dev/null
  k create configmap ownership-grants --from-file=ownership-grants.js="$grants" >/dev/null
  echo '{"state":"seeded","secrets":["ns-postgres-password","ns-vault-tls","ns-ca"],"configMaps":["ownership-grants"]}'
}

publish() {
  local image=$1 role dir
  k wait --for=condition=complete job/provision --timeout=15s >/dev/null
  # A reader Pod with the state volume read-only, no network use, no service-account token.
  k apply -f - >/dev/null <<EOF
{"apiVersion":"v1","kind":"Pod","metadata":{"name":"provision-state-reader","labels":{"app.kubernetes.io/part-of":"nightscout-multitenant","app.kubernetes.io/component":"provision"}},
 "spec":{"restartPolicy":"Never","automountServiceAccountToken":false,"enableServiceLinks":false,
  "securityContext":{"fsGroup":1000,"seccompProfile":{"type":"RuntimeDefault"}},
  "containers":[{"name":"reader","image":"$image","imagePullPolicy":"IfNotPresent","command":["sleep","300"],
   "securityContext":{"runAsUser":1000,"runAsGroup":1000,"runAsNonRoot":true,"readOnlyRootFilesystem":true,"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}},
   "volumeMounts":[{"name":"state","mountPath":"/state","readOnly":true}]}],
  "volumes":[{"name":"state","persistentVolumeClaim":{"claimName":"provision-state","readOnly":true}}]}}
EOF
  k wait --for=condition=Ready pod/provision-state-reader --timeout=120s >/dev/null
  k exec provision-state-reader -- tar -C /state -cf - api realtime evaluator tenant-admin ui ownership-admin | tar -C "$work" -xf -
  k delete pod provision-state-reader --wait=false >/dev/null
  for role in api realtime evaluator tenant-admin ui; do
    args=()
    for file in "$work/$role"/*.json; do
      [ "$(basename "$file")" = complete.json ] || args+=(--from-file="$(basename "$file")=$file")
    done
    k create secret generic "ns-config-$role" "${args[@]}" >/dev/null
  done
  k create secret generic ns-config-admin --from-file=env.json="$work/ownership-admin/env.json" --from-file=admin.json="$work/ownership-admin/admin.json" >/dev/null
  echo '{"state":"published","secrets":["ns-config-api","ns-config-realtime","ns-config-evaluator","ns-config-tenant-admin","ns-config-ui","ns-config-admin"]}'
}

case $cmd in
  seed) seed "$arg" ;;
  publish) publish "$arg" ;;
  *) usage ;;
esac
