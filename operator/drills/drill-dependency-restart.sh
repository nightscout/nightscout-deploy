#!/usr/bin/env bash
# Drill: a dependency or one role is replaced under a running deployment, and the operator
# brings service back by the runbook. Runbook: ../runbooks/host-and-dependency-replacement.md
#   drill-dependency-restart.sh api-death | vault-restart | postgres-restart
# NS_DRILL_SKIP_RECOVERY=1 leaves out the runbook's recovery step (the control: the final
# assertions must then fail). `observe` lines record behaviour the runbook warns about; they
# are not pass/fail.
set -euo pipefail
mode=${1:?mode}; drill="dependency-restart:$mode"
source "$(dirname "$0")/lib.sh"
port=$(sed -n 's/^NS_DEMO_PORT=//p' "$NS_DRILL_CORE/deploy/multitenant/.env")
edge() { curl -s -o /dev/null -m 10 -w '%{http_code}' -H "Host: $1.example.test" "http://127.0.0.1:$port/api/v1/status.json" || true; }
observe() { printf '{"drill":"%s","observe":"%s","value":"%s"}\n' "$drill" "$1" "$2"; }
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
postgres-restart)
  "$stack" compose restart postgres >/dev/null 2>&1
  "$stack" compose up -d --no-build --pull never --wait --wait-timeout 90 postgres >/dev/null 2>&1
  sleep 15
  step a-refused-after-database-restart "$(driver dp-p1 probe $name --tenant a | field admitted)" false
  step b-refused-after-database-restart "$(driver dp-p2 probe $name --tenant b | field admitted)" false
  refusal=$(driver dp-r0 restore $name | field error || true)
  step restore-refused-before-role-restart "\"$( [ -n "$refusal" ] && echo refused || echo accepted)\"" '"refused"'
  observe restore-refusal-code "$refusal"
  step tenant-not-closed-by-refused-restore "\"$(window "$tenant")\"" '"active|false|false"'
  observe edge-status "$(edge one)"
  observe api-container-health "$(health api)"
  observe tenant-admin-container "$(health tenant-admin)"
  # Recovery: every application role gets a new process, in start order.
  [ "${NS_DRILL_SKIP_RECOVERY:-}" = 1 ] || "$stack" roles-restart >/dev/null 2>&1
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
