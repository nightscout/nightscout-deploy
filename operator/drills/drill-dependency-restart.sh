#!/usr/bin/env bash
# Drill: a dependency or one role is replaced under a running deployment, and the operator
# brings service back by the runbook. Runbook: ../runbooks/host-and-dependency-replacement.md
#   drill-dependency-restart.sh api-death | vault-restart | postgres-restart | postgres-outage
# NS_DRILL_SKIP_RECOVERY=1 leaves out the runbook's recovery step (the control: the final
# assertions must then fail). For the two postgres modes the recovery is the roles' own, so the
# control is an image built from a core commit without it (the steps after the restart go red).
# `observe` lines record behaviour the runbook warns about; they
# are not pass/fail.
set -euo pipefail
mode=${1:?mode}; drill="dependency-restart:$mode"
source "$(dirname "$0")/lib.sh"
port=$(sed -n 's/^NS_DEMO_PORT=//p' "$NS_DRILL_CORE/deploy/multitenant/.env")
edge() { curl -s -o /dev/null -m 10 -w '%{http_code}' -H "Host: $1.example.test" "http://127.0.0.1:$port/api/v1/status.json" || true; }
observe() { printf '{"drill":"%s","observe":"%s","value":"%s"}\n' "$drill" "$1" "$2"; }
# The role's own health command, run now (the container health status lags it by interval x retries).
health_exit() { docker exec "$(container "$1")" node deploy/multitenant/health.js "$1" >/dev/null 2>&1; echo $?; }
started() { for role in api realtime evaluator tenant-admin admin feed-reader ui nginx; do docker inspect --format '{{.State.StartedAt}}' "$(container "$role")"; done | tr '\n' ' '; }
health() { docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$(container "$1")" 2>/dev/null || echo absent; }
name=dp; fresh $name; driver dp-seed seed $name >/dev/null
tenant=$(field tenant < "$drill_state/$name.expect.json")
step before-a-admitted "$(driver dp-p0 probe $name --tenant a | field admitted)" true
case "$mode" in
api-death)
  docker kill "$(container api)" >/dev/null
  step a-refused-while-api-is-down "$(driver dp-p1 probe $name --tenant a | field admitted)" false
  observe edge-status-while-down "$(edge one)"
  [ "${NS_DRILL_SKIP_RECOVERY:-}" = 1 ] || "$stack" compose up -d --no-build --pull never --wait --wait-timeout 300 api >/dev/null 2>&1
  ;;
vault-restart)
  "$stack" compose restart vault >/dev/null 2>&1
  step vault-sealed-after-restart "$("$stack" compose exec -T vault vault status -address=https://vault:8200 -ca-cert=/run/ns-ca/ca.crt -format=json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).sealed)))')" true
  step a-refused-while-sealed "$(driver dp-p1 probe $name --tenant a | field admitted)" false
  observe api-container-health-while-sealed "$(health api)"
  # Recovery: the unseal step only. No role is restarted.
  [ "${NS_DRILL_SKIP_RECOVERY:-}" = 1 ] || step unseal "\"$("$stack" bootstrap 2>/dev/null | field state)\"" '"existing-demo-unsealed"'
  ;;
postgres-restart|postgres-outage)
  # Core decision datastore-loss-recover-in-place: every role reports itself unhealthy while it
  # cannot admit a tenant operation, re-admits the restarted database and serves again in the
  # same process. No role is restarted here; the started-at times prove it.
  started_before=$(started)
  if [ "$mode" = postgres-outage ]; then
    "$stack" compose stop postgres >/dev/null 2>&1
    sleep "${NS_DRILL_OUTAGE_SECONDS:-12}"
    step api-health-check-fails-while-database-is-down "$(health_exit api)" 1
    step realtime-health-check-fails-while-database-is-down "$(health_exit realtime)" 1
    step evaluator-health-check-fails-while-database-is-down "$(health_exit evaluator)" 1
    step tenant-admin-health-check-fails-while-database-is-down "$(health_exit tenant-admin)" 1
    observe edge-status-while-down "$(edge one)"
    "$stack" compose start postgres >/dev/null 2>&1
  else
    "$stack" compose restart postgres >/dev/null 2>&1
  fi
  "$stack" compose up -d --no-build --pull never --wait --wait-timeout 90 postgres >/dev/null 2>&1
  back=$(date +%s)
  # Recovery is the roles' own: wait for it, bounded. NS_DRILL_SKIP_RECOVERY=1 does not wait.
  if [ "${NS_DRILL_SKIP_RECOVERY:-}" != 1 ]; then
    for _ in $(seq 1 "${NS_DRILL_RECOVERY_WAIT_SECONDS:-60}"); do
      [ "$(health_exit api)$(health_exit realtime)$(health_exit evaluator)$(health_exit tenant-admin)" = 0000 ] && [ "$(edge one)" != 503 ] && break
      sleep 1
    done
  fi
  observe seconds-until-roles-healthy-and-edge-answers "$(( $(date +%s) - back ))"
  step no-role-restarted "\"$( [ "$(started)" = "$started_before" ] && echo same-processes || echo restarted)\"" '"same-processes"'
  step api-health-check-passes "$(health_exit api)" 0
  observe edge-status "$(edge one)"
  observe api-container-health "$(health api)"
  observe tenant-admin-container "$(health tenant-admin)"
  ;;
*) echo 'DRILL_USAGE' >&2; exit 64 ;;
esac
step roles-healthy "$("$stack" ps | grep -c 'running.healthy' || true)" 8
step a-admitted "$(driver dp-p3 probe $name --tenant a | field admitted)" true
step b-writes "$(driver dp-p4 progress $name | field pass)" true
step tenant-restore-works "\"$(driver dp-r restore $name | field state)\"" '"activated"'
step state-restored "$(driver dp-v verify-state $name | field pass)" true
step history-converges "$(driver dp-h verify-history $name | field pass)" true
finish
