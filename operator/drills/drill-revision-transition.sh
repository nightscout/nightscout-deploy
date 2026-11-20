#!/usr/bin/env bash
# Populated ordinary revision-transition checks. Own disposable project only.
# Uses its in-container API client for writes and real authorized frames.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
"$here/stack.sh" verify-profile
state=$("$here/stack.sh" state)
mkdir -p -m 0700 "$state/drill"
case "${1:-}" in
  seed|viewer|gap-write)
    exec "$here/stack.sh" ops -v "$(realpath "$NS_DRILL_CORE/node_modules"):/run/ns-client/node_modules:ro" \
      -v "$here/container:/run/ns-drill:ro" -v "$state/drill:/run/ns-drill-state" \
      demo node -r ./deploy/multitenant/load-env.js /run/ns-drill/revision-transition.cjs "$1"
    ;;
  write)
    exec "$here/stack.sh" ops -v "$here/container:/run/ns-drill:ro" -v "$state/drill:/run/ns-drill-state" \
      demo node -r ./deploy/multitenant/load-env.js /run/ns-drill/revision-transition.cjs write
    ;;
  verify) exec node "$here/container/revision-transition.cjs" ;;
  *) echo 'Usage: drill-revision-transition.sh seed|gap-write|write|verify|viewer' >&2; exit 64 ;;
esac
