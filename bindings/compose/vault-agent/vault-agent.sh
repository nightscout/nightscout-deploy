#!/usr/bin/env bash
# Runs the imported one-host Compose tree with the Vault Agent overlay.
#   vault-agent.sh <core-tree> <command>
# <core-tree> is the directory tools/compose-overlay.sh printed (a core worktree carrying
# deploy/multitenant), already prepared with `./demo.sh prepare [--port N --state DIR]`.
# Own project name and env file, so a plain demo.sh project on the same host is untouched.
set -euo pipefail
tree=${1:?core tree}; command=${2:?command}; shift 2
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
multitenant="$tree/deploy/multitenant"
[ -f "$multitenant/.env" ] || { echo "run ./demo.sh prepare in $multitenant first" >&2; exit 64; }
export NS_VAULT_AGENT_DIR="$here"
compose=(docker compose --project-name "${NS_VAULT_AGENT_PROJECT:-nightscout-multitenant-vault-agent}" --project-directory "$multitenant"
  --env-file "$multitenant/.env" -f "$multitenant/compose.yaml" -f "$here/compose.vault-agent.yaml")
case "$command" in
  config)   exec "${compose[@]}" config --quiet ;;
  build)    exec node "$multitenant/build.js" ;;
  bootstrap)
    node "$multitenant/build.js" --check-image
    "${compose[@]}" --profile ops run --rm bootstrap
    exec "${compose[@]}" --profile ops run --rm vault-agent-bootstrap ;;
  up)
    node "$multitenant/build.js" --check-image
    "${compose[@]}" --profile ops run --rm bootstrap
    "${compose[@]}" --profile ops run --rm vault-agent-bootstrap
    exec "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 120 vault-agent api realtime evaluator tenant-admin ui nginx ;;
  demo)     exec "${compose[@]}" --profile ops run --rm --no-deps demo ;;
  secret-id) exec "${compose[@]}" --profile ops run --rm --no-deps vault-agent-bootstrap node /run/ns-overlay/vault-agent-bootstrap.js secret-id ;;
  agent)    exec "${compose[@]}" "${1:?stop|start|logs}" vault-agent ;;
  status)   exec "${compose[@]}" ps -a ;;
  stop)     exec "${compose[@]}" stop ;;
  down)     exec "${compose[@]}" down ;;
  destroy)  exec "${compose[@]}" down -v ;;
  *) echo 'Usage: vault-agent.sh <core-tree> config|build|bootstrap|up|demo|secret-id|agent stop|start|logs|status|stop|down|destroy' >&2; exit 64 ;;
esac
