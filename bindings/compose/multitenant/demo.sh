#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

# Identity is prepared explicitly, never inherited from ambient Compose variables.
# Legacy state without NS_DEMO_PROJECT retains the original fixed project.
project=$(node project.js)
compose=(docker compose --project-name "$project" --env-file .env -f compose.yaml)
realtime_services="realtime"
evaluator_services="evaluator"
input_transport=pgstream
stream_services=(pgstream)
if [ -f .env ]; then
  replica_file=$(node -e 'const fs=require("node:fs"),path=require("node:path");const lines=fs.readFileSync(".env","utf8").split("\n");const line=lines.find(x=>x.startsWith("NS_DEMO_STATE="));if(!line)process.exit(1);process.stdout.write(path.join(line.slice(14),"compose.replicas.yaml"));')
  [ -f "$replica_file" ] && compose+=(-f "$replica_file")
  evaluator_file="$(dirname "$replica_file")/compose.evaluator.yaml"
  if [[ "$(<.env)" == *NS_EVALUATOR_WORKERS=* ]]; then
    [ -f "$evaluator_file" ] || { echo 'Selected native evaluator overlay missing' >&2; exit 1; }
    compose+=(-f "$evaluator_file")
  fi
  evaluator_services=$(node -e 'const fs=require("node:fs");const source=Object.fromEntries(fs.readFileSync(".env","utf8").trim().split("\n").map(line=>{const i=line.indexOf("=");return [line.slice(0,i),line.slice(i+1)];}));console.log(require("./evaluator-workers").services(require("./evaluator-workers").selection(source)).join(" "));')
  realtime_services=$(node -e 'const fs=require("node:fs");const source=Object.fromEntries(fs.readFileSync(".env","utf8").trim().split("\n").map(line=>{const i=line.indexOf("=");return [line.slice(0,i),line.slice(i+1)];}));console.log(require("./realtime-workers").services(require("./realtime-workers").selection(source)).join(" "));')
  if [ "$realtime_services" != "realtime" ]; then
    realtime_file="$(dirname "$replica_file")/compose.realtime.yaml"
    [ -f "$realtime_file" ] || { echo 'Selected realtime placement overlay missing' >&2; exit 1; }
    compose+=(-f "$realtime_file")
  fi
  if grep -qx NS_INPUT_TRANSPORT=writer-driven .env; then
    compose+=(-f "$(dirname "$replica_file")/compose.writer.yaml")
    input_transport=writer-driven
    stream_services=()
  fi
fi
case "${1:-}" in
  snapshot)
    [ "$#" -eq 2 ] || exit 64
    "${compose[@]}" stop
    exec node fixture.js snapshot "$2"
    ;;
  restore-fixture)
    shift
    exec node fixture.js restore "$@"
    ;;
  patch)
    shift
    exec node reopen.js "$@"
    ;;
  prepare)
    shift
    exec node prepare.js "$@"
    ;;
  config)
    # Config output contains file references, never generated secret contents.
    exec "${compose[@]}" config --quiet
    ;;
  build)
    shift
    exec node build.js "$@"
    ;;
  bootstrap)
    node build.js --check-image
    NS_INPUT_TRANSPORT="$input_transport" node credentials.js add-owner-settings "$(dirname "$replica_file")/credentials"
    exec "${compose[@]}" run --rm bootstrap
    ;;
  up)
    node build.js --check-image
    [ "$#" -eq 1 ] || exit 64
    NS_INPUT_TRANSPORT="$input_transport" node credentials.js add-owner-settings "$(dirname "$replica_file")/credentials"
    # admin and every role wait for the one-shot bootstrap (render, then provision) to complete.
    "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 90 admin
    replicas=$(node -e 'const fs=require("node:fs"),lines=fs.readFileSync(".env","utf8").split("\n");const n=Number((lines.find(x=>x.startsWith("NS_API_REPLICAS="))||"NS_API_REPLICAS=1").slice(16));if(!Number.isSafeInteger(n)||n<1||n>16)process.exit(1);console.log(Array.from({length:n},(_,i)=>i?"api-"+(i+1):"api").join(" "));')
    "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 900 $replicas $realtime_services $evaluator_services "${stream_services[@]}" tenant-admin ui nginx
    ;;
  prime|demo)
    node build.js --check-image
    # Report a sealed fixture before the first tenant write. Ask Vault directly
    # so this decision does not depend on the timing of the last healthcheck.
    sealed=$("${compose[@]}" exec -T -e VAULT_MAX_RETRIES=0 vault vault read \
      -address=https://vault:8200 -ca-cert=/run/ns-ca/ca.crt -field=sealed sys/health sealedcode=200)
    if [[ "$sealed" == true ]]; then
      echo '{"error":"VAULT_SEALED"}' >&2
      exit 1
    fi
    "${compose[@]}" --profile ops run --rm --no-deps primer node deploy/multitenant/prime.js provision
    "${compose[@]}" --profile ops run --rm --no-deps primer node deploy/multitenant/prime.js prime
    node publish-primer.js "$(dirname "$replica_file")"
    if [[ "$1" = demo ]]; then
      # Only the restore demonstration needs restore authority; ordinary priming never grants it.
      "${compose[@]}" --profile ops run --rm --no-deps -e NS_DEMO_TENANTS="${NS_DEMO_TENANTS:-2}" bootstrap node deploy/multitenant/commission-restore.js
      exec "${compose[@]}" --profile ops run --rm --no-deps demo
    fi
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
    echo 'Usage: demo.sh prepare [--bind 169.254.1.1] | config | build [--image local-tag] | bootstrap | up | prime | snapshot /new/directory | restore-fixture /snapshot --project NAME --state /new/state | patch /absolute/prepared/.env local-image | demo | pgstream-rebootstrap /absolute/private-plan.json | status | stop | down' >&2
    exit 64
    ;;
esac
