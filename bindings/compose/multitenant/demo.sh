#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

# Deliberately fixed project: commands never search other projects or remove
# volumes implicitly. For another instance, use a separate checkout and invoke
# Compose with its own explicit --project-name.
compose=(docker compose --project-name nightscout-multitenant-demo --env-file .env -f compose.yaml)
if [ -f .env ]; then
  replica_file=$(node -e 'const fs=require("node:fs"),path=require("node:path");const lines=fs.readFileSync(".env","utf8").split("\n");const line=lines.find(x=>x.startsWith("NS_DEMO_STATE="));if(!line)process.exit(1);process.stdout.write(path.join(line.slice(14),"compose.replicas.yaml"));')
  [ -f "$replica_file" ] && compose+=(-f "$replica_file")
fi
case "${1:-}" in
  prepare)
    shift
    exec node prepare.js "$@"
    ;;
  config)
    # Config output contains file references, never generated secret contents.
    exec "${compose[@]}" config --quiet
    ;;
  build)
    exec node build.js
    ;;
  bootstrap)
    node build.js --check-image
    exec "${compose[@]}" --profile ops run --rm bootstrap
    ;;
  up)
    node build.js --check-image
    "${compose[@]}" --profile ops run --rm bootstrap
    "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 90 admin feed-reader
    "${compose[@]}" --profile ops run --rm primer node deploy/multitenant/prime.js provision
    "${compose[@]}" --profile ops run --rm --no-deps bootstrap node deploy/multitenant/commission-restore.js
    replicas=$(node -e 'const fs=require("node:fs"),lines=fs.readFileSync(".env","utf8").split("\n");const n=Number((lines.find(x=>x.startsWith("NS_API_REPLICAS="))||"NS_API_REPLICAS=1").slice(16));if(!Number.isSafeInteger(n)||n<1||n>16)process.exit(1);console.log(Array.from({length:n},(_,i)=>i?"api-"+(i+1):"api").join(" "));')
    "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 900 $replicas
    "${compose[@]}" --profile ops run --rm --no-deps primer node deploy/multitenant/prime.js prime
    node publish-primer.js "$(dirname "$replica_file")"
    exec "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 900 realtime evaluator tenant-admin ui nginx
    ;;
  demo)
    node build.js --check-image
    exec "${compose[@]}" --profile ops run --rm --no-deps demo
    ;;
  status)
    exec "${compose[@]}" ps -a
    ;;
  stop)
    exec "${compose[@]}" stop
    ;;
  down)
    # Keep database/Vault volumes and private state. Destruction is a separately
    # named operator action, not a surprising side effect of stopping the demo.
    exec "${compose[@]}" down
    ;;
  *)
    echo 'Usage: demo.sh prepare [--bind 169.254.1.1] | config | build | bootstrap | up | demo | status | stop | down' >&2
    exit 64
    ;;
esac
