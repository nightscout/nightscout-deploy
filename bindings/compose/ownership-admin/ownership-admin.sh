#!/usr/bin/env bash
# Runs the imported one-host Compose tree with the ownership-operations overlay.
#   ownership-admin.sh <core-tree> <command>
# <core-tree> is a core checkout carrying deploy/multitenant (see tools/compose-overlay.sh), already
# prepared with `./demo.sh prepare [--port N --state DIR]` and built. Own project name, so a plain
# demo.sh project on the same host is untouched.
set -euo pipefail
tree=${1:?core tree}; command=${2:?command}; shift 2
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
multitenant="$tree/deploy/multitenant"
[ -f "$multitenant/.env" ] || { echo "run ./demo.sh prepare in $multitenant first" >&2; exit 64; }
export NS_OWNERSHIP_ADMIN_DIR="$here"
compose=(docker compose --project-name "${NS_OWNERSHIP_ADMIN_PROJECT:-nightscout-multitenant-ownership-admin}" --project-directory "$multitenant"
  --env-file "$multitenant/.env" -f "$multitenant/compose.yaml" -f "$here/compose.ownership-admin.yaml")
case "$command" in
  config)   exec "${compose[@]}" config --quiet ;;
  build)    exec node "$multitenant/build.js" ;;
  bootstrap)
    node "$multitenant/build.js" --check-image
    "${compose[@]}" --profile ops run --rm bootstrap
    exec "${compose[@]}" --profile ops run --rm ownership-grants node /run/ns-overlay/ownership-grants.js provision ;;
  up)
    node "$multitenant/build.js" --check-image
    "${compose[@]}" --profile ops run --rm bootstrap
    "${compose[@]}" --profile ops run --rm ownership-grants node /run/ns-overlay/ownership-grants.js provision
    exec "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 120 api realtime evaluator tenant-admin ui nginx admin ;;
  admin)    exec "${compose[@]}" "${1:?up|stop|logs}" admin ;;
  status)   exec "${compose[@]}" ps -a ;;
  stop)     exec "${compose[@]}" stop ;;
  down)     exec "${compose[@]}" down ;;
  destroy)  exec "${compose[@]}" down -v ;;
  *) echo 'Usage: ownership-admin.sh <core-tree> config|build|bootstrap|up|admin up|stop|logs|status|stop|down|destroy' >&2; exit 64 ;;
esac
