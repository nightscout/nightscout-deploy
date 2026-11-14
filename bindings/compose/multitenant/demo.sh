#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

# Identity is prepared explicitly, never inherited from ambient Compose variables.
# Legacy state without NS_DEMO_PROJECT retains the original fixed project.
project=$(node project.js)
compose=(docker compose --project-name "$project" --env-file .env -f compose.yaml)
realtime_services="realtime"
evaluator_services="evaluator"
feed_services="feed-reader"
if [ -f .env ]; then
  if [[ "$(<.env)" == *NS_PGSTREAM=1* ]]; then feed_services=""; fi
  replica_file=$(node -e 'const fs=require("node:fs"),path=require("node:path");const lines=fs.readFileSync(".env","utf8").split("\n");const line=lines.find(x=>x.startsWith("NS_DEMO_STATE="));if(!line)process.exit(1);process.stdout.write(path.join(line.slice(14),"compose.replicas.yaml"));')
  [ -f "$replica_file" ] && compose+=(-f "$replica_file")
  evaluator_file="$(dirname "$replica_file")/compose.evaluator.yaml"
  if [[ "$(<.env)" == *NS_EVALUATOR_WORKERS=* ]]; then
    [ -f "$evaluator_file" ] || { echo 'Selected evaluator pool overlay missing' >&2; exit 1; }
    compose+=(-f "$evaluator_file")
  fi
  evaluator_services=$(node -e 'const fs=require("node:fs");const source=Object.fromEntries(fs.readFileSync(".env","utf8").trim().split("\n").map(line=>{const i=line.indexOf("=");return [line.slice(0,i),line.slice(i+1)];}));console.log(require("./evaluator-workers").services(require("./evaluator-workers").selection(source)).join(" "));')
  realtime_services=$(node -e 'const fs=require("node:fs");const source=Object.fromEntries(fs.readFileSync(".env","utf8").trim().split("\n").map(line=>{const i=line.indexOf("=");return [line.slice(0,i),line.slice(i+1)];}));console.log(require("./realtime-workers").services(require("./realtime-workers").selection(source)).join(" "));')
  if [ "$realtime_services" != "realtime" ]; then
    realtime_file="$(dirname "$replica_file")/compose.realtime.yaml"
    [ -f "$realtime_file" ] || { echo 'Selected realtime placement overlay missing' >&2; exit 1; }
    compose+=(-f "$realtime_file")
  fi
  budget_file="$(dirname "$replica_file")/compose.connection-budget.yaml"
  if [[ "$(<.env)" == *NS_CONNECTION_BUDGET=1* ]]; then
    [ -f "$budget_file" ] || { echo 'Selected connection-budget overlay missing' >&2; exit 1; }
    compose+=(-f "$budget_file")
  fi
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
  admission)
    shift
    exec node connection-budget-cli.js "$(dirname "$replica_file")" "$@"
    ;;
  up)
    if [[ "$(<.env)" == *NS_CONNECTION_BUDGET=1* ]]; then
      echo 'Selected connection-budget profile requires explicit admission bind/start per process; ordinary up refuses uncontrolled worker startup' >&2
      exit 78
    fi
    node build.js --check-image
    "${compose[@]}" --profile ops run --rm bootstrap
    "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 90 admin $feed_services
    "${compose[@]}" --profile ops run --rm primer node deploy/multitenant/prime.js provision
    "${compose[@]}" --profile ops run --rm --no-deps bootstrap node deploy/multitenant/commission-restore.js
    "${compose[@]}" --profile ops run --rm --no-deps primer node deploy/multitenant/evaluator-pool.js initialize
    replicas=$(node -e 'const fs=require("node:fs"),lines=fs.readFileSync(".env","utf8").split("\n");const n=Number((lines.find(x=>x.startsWith("NS_API_REPLICAS="))||"NS_API_REPLICAS=1").slice(16));if(!Number.isSafeInteger(n)||n<1||n>16)process.exit(1);console.log(Array.from({length:n},(_,i)=>i?"api-"+(i+1):"api").join(" "));')
    "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 900 $replicas
    "${compose[@]}" --profile ops run --rm --no-deps primer node deploy/multitenant/prime.js prime
    node publish-primer.js "$(dirname "$replica_file")"
    exec "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 900 $realtime_services $evaluator_services tenant-admin ui nginx
    ;;
  demo)
    if [[ "$(<.env)" == *NS_CONNECTION_BUDGET=1* ]]; then
      echo 'Selected connection budget refuses undeclared restore/demo/operator SQL processes' >&2
      exit 78
    fi
    node build.js --check-image
    exec "${compose[@]}" --profile ops run --rm --no-deps demo
    ;;
  pgstream-rebootstrap)
    [ "$#" -eq 2 ] || { echo "Usage: demo.sh pgstream-rebootstrap /absolute/private-plan.json" >&2; exit 64; }
    exec node pgstream-rebootstrap.js "$2"
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
    echo 'Usage: demo.sh prepare [--bind 169.254.1.1] | config | build | bootstrap | up | demo | pgstream-rebootstrap /absolute/private-plan.json | status | stop | down' >&2
    exit 64
    ;;
esac
