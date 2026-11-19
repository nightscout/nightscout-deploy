#!/usr/bin/env bash
# Compose wrapper for recovery drills on a disposable synthetic deployment.
#   NS_DRILL_CORE     prepared core checkout with this binding overlaid (tools/compose-overlay.sh)
#   NS_DRILL_PROJECT  Compose project; must start with "recovery-drills-"
#   NS_DRILL_IMAGE    application image whose labels match the prepared source and deploy commits
#   NS_DRILL_BACKEND_SUBNET, NS_DRILL_EDGE_SUBNET  optional explicit CIDRs, for a host whose
#                     Docker default address pools are exhausted; both or neither
# It addresses one explicit project and never searches, stops or removes any other.
# `destroy` is the only command that removes volumes, and only this project's.
set -euo pipefail
: "${NS_DRILL_CORE:?prepared core checkout}" "${NS_DRILL_PROJECT:?Compose project}" "${NS_DRILL_IMAGE:?application image}"
case "$NS_DRILL_PROJECT" in recovery-drills-*) ;; *) echo 'DRILL_PROJECT_REFUSED: project must start with recovery-drills-' >&2; exit 64;; esac
folder="$NS_DRILL_CORE/deploy/multitenant"
[ -f "$folder/.env" ] || { echo 'DRILL_NOT_PREPARED' >&2; exit 64; }
state=$(sed -n 's/^NS_DEMO_STATE=//p' "$folder/.env")
[ -d "$state" ] || { echo 'DRILL_STATE_MISSING' >&2; exit 64; }
prepared_project=$(sed -n 's/^NS_DEMO_PROJECT=//p' "$folder/.env")
[ -z "$prepared_project" ] || [ "$prepared_project" = "$NS_DRILL_PROJECT" ] || { echo 'DRILL_PREPARED_PROJECT_CHANGED' >&2; exit 64; }
export NS_DEMO_IMAGE="$NS_DRILL_IMAGE"
compose=(docker compose --project-name "$NS_DRILL_PROJECT" --project-directory "$folder" --env-file "$folder/.env" -f "$folder/compose.yaml")
[ -f "$state/compose.replicas.yaml" ] && compose+=(-f "$state/compose.replicas.yaml")
if [ -n "${NS_DRILL_BACKEND_SUBNET:-}${NS_DRILL_EDGE_SUBNET:-}" ]; then
  cidr='^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$'
  [[ "${NS_DRILL_BACKEND_SUBNET:-}" =~ $cidr && "${NS_DRILL_EDGE_SUBNET:-}" =~ $cidr ]] || { echo 'DRILL_SUBNET_REFUSED' >&2; exit 64; }
  printf 'networks:\n  backend:\n    ipam: {config: [{subnet: "%s"}]}\n  edge:\n    ipam: {config: [{subnet: "%s"}]}\n' \
    "$NS_DRILL_BACKEND_SUBNET" "$NS_DRILL_EDGE_SUBNET" > "$state/drill.networks.yaml"
  compose+=(-f "$state/drill.networks.yaml")
fi
ordinary_profile() {
  # These recovery drills address one fixed ordinary cohort. Partitioned
  # evaluator and realtime profiles need their own drill, never this path.
  if sed -n '/^NS_EVALUATOR_WORKERS=/p; /^NS_REALTIME_WORKERS=/p' "$folder/.env" | read -r selected; then
    echo 'DRILL_SELECTED_PROFILE_UNSUPPORTED' >&2; exit 78
  fi
  replicas=$(sed -n 's/^NS_API_REPLICAS=//p' "$folder/.env")
  [ -z "$replicas" ] || [ "$replicas" = 1 ] || { echo 'DRILL_REPLICA_PROFILE_UNSUPPORTED' >&2; exit 78; }
}
check_image() { (cd "$folder" && node build.js --check-image); }
command=${1:-}; [ $# -gt 0 ] && shift
case "$command" in
  state) echo "$state" ;;
  verify-profile) ordinary_profile; check_image ;;
  compose) exec "${compose[@]}" "$@" ;;
  bootstrap) check_image; exec "${compose[@]}" --profile ops run --rm bootstrap "$@" ;;
  up)
    # Same order as demo.sh up, for one API instance and the base realtime/evaluator services.
    ordinary_profile
    check_image
    "${compose[@]}" --profile ops run --rm bootstrap
    "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 90 admin
    "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 300 api realtime evaluator pgstream tenant-admin ui nginx
    "${compose[@]}" --profile ops run --rm --no-deps primer node deploy/multitenant/prime.js provision
    "${compose[@]}" --profile ops run --rm --no-deps bootstrap node deploy/multitenant/commission-restore.js
    "${compose[@]}" --profile ops run --rm --no-deps primer node deploy/multitenant/prime.js prime
    (cd "$folder" && node publish-primer.js "$state")
    ;;
  roles-up)
    # Restart of an already bootstrapped and primed deployment: unseal, then roles in order.
    ordinary_profile
    check_image
    "${compose[@]}" --profile ops run --rm bootstrap
    "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 90 admin
    "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 300 api
    exec "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 300 realtime evaluator pgstream tenant-admin ui nginx
    ;;
  roles-restart)
    ordinary_profile
    # Every application role gets a new process (after a database or host event); data services stay up.
    "${compose[@]}" stop nginx ui tenant-admin pgstream evaluator realtime api admin
    exec "$0" roles-up
    ;;
  ops)
    # One-shot private operator container (restore.js export|restore, or a mounted drill driver).
    exec "${compose[@]}" --profile ops run --rm --no-deps -T "$@"
    ;;
  ps) exec "${compose[@]}" ps -a --format '{{.Service}}\t{{.State}}\t{{.Health}}' ;;
  stop) exec "${compose[@]}" stop ;;
  down) exec "${compose[@]}" down ;;
  destroy)
    [ "${1:-}" = "--confirm-project" ] && [ "${2:-}" = "$NS_DRILL_PROJECT" ] || { echo 'DRILL_DESTROY_CONFIRMATION_REQUIRED' >&2; exit 64; }
    exec "${compose[@]}" --profile ops down --volumes --remove-orphans
    ;;
  *) echo 'Usage: stack.sh state|verify-profile|compose ...|bootstrap|up|roles-up|roles-restart|ops ...|ps|stop|down|destroy --confirm-project <project>' >&2; exit 64 ;;
esac
