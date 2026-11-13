#!/usr/bin/env bash
# Drill: a process dies, or its reply is lost, in the middle of an operator operation.
# Runbooks: ../runbooks/role-death-mid-operation.md and ../runbooks/lost-acknowledgement.md
#   drill-operation-death.sh export | provision-admin-death | provision-lost-acknowledgement |
#                            ownership-admin-death | ownership-lost-acknowledgement
# The drill inspects persisted state after the fault and retries only what the runbook allows.
set -euo pipefail
mode=${1:?mode}; drill="operation-death:$mode"
source "$(dirname "$0")/lib.sh"
batch() { # prefix, count -> private add.json for the lab client
  node -e 'const [p,n]=process.argv.slice(1);process.stdout.write(JSON.stringify({version:1,tenants:Array.from({length:Number(n)},(_,i)=>({id:p+"-0000-4000-8000-"+String(i).padStart(12,"0"),hosts:["drill-"+p+"-"+i+".example.test"],issueRootSecret:true}))})+"\n")' "$1" "$2" > "$state/primer/add.json"
  chmod 0600 "$state/primer/add.json"
}
custody() { node -e 'const fs=require("node:fs");const rows=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(rows.filter(r=>r.id.startsWith(process.argv[2])&&r.rootSecret).length))' "$state/primer/provisioned.json" "$1"; }
incomplete() { sql "SELECT count(*) FROM nsdemo_registry.tenant_registry r WHERE r.tenant_id::text LIKE '$1%' AND (r.state<>'active'
  OR NOT EXISTS (SELECT 1 FROM nsdemo_registry.tenant_registry_hosts h WHERE h.tenant_id=r.tenant_id)
  OR NOT EXISTS (SELECT 1 FROM nsdemo_registry.tenant_registry_keys k WHERE k.tenant_id=r.tenant_id)
  OR NOT EXISTS (SELECT 1 FROM nsdemo_control.tenant_lifecycle_windows w WHERE w.tenant_id=r.tenant_id AND w.phase='active')
  OR NOT EXISTS (SELECT 1 FROM nsdemo_clock.tenant_write_clock c WHERE c.tenant_id=r.tenant_id))"; }
settle() { local last=-1 now; while now=$(registry_count "$1"); [ "$now" != "$last" ]; do last=$now; sleep 2; done; echo "$now"; }
admin_up() { "$stack" compose up -d --no-build --pull never --wait --wait-timeout 90 admin >/dev/null 2>&1; }

case "$mode" in
export)
  name=ex; fresh $name; driver ex-seed seed $name >/dev/null
  tenant=$(field tenant < "$drill_state/$name.expect.json")
  before=$(ls "$state/artifacts" | wc -l)
  ( driver ex-op export $name --hold captured --hold-ms 60000 > "$drill_state/$name.out" 2>&1 || true ) &
  wait_file "$drill_state/$name.hold-captured" 60 || { step hold-reached '"no"' '"yes"'; finish; }
  docker kill "$NS_DRILL_PROJECT-ex-op" >/dev/null; wait || true
  step no-artifact-published "$(ls "$state/artifacts" | wc -l)" "$before"
  step no-partial-directory "$(ls -A "$state/artifacts" | grep -c '^\.tenant-partial-' || true)" 0
  step tenant-still-open "\"$(window "$tenant")\"" '"active|false|false"'
  step tenant-admitted "$(driver ex-p probe $name --tenant a | field admitted)" true
  step retry-publishes "\"$( [ -n "$(driver ex-op2 export $name | field digest)" ] && echo yes || echo no)\"" '"yes"'
  step one-more-artifact "$(ls "$state/artifacts" | wc -l)" $((before + 1))
  ;;
provision-lost-acknowledgement|provision-admin-death)
  prefix="d$(openssl rand -hex 4 | cut -c1-7)"; count=${NS_DRILL_BATCH:-40}; batch "$prefix" "$count"
  ( client pv-op deploy/multitenant/prime.js add > "$drill_state/pv.out" 2>&1 || true ) &
  n=0; until [ "$(registry_count "$prefix")" -ge 1 ]; do n=$((n+1)); [ $n -gt 300 ] && break; sleep 0.1; done
  if [ "$mode" = provision-lost-acknowledgement ]; then
    # The client dies after sending; the admin service keeps its own work. No reply reaches custody.
    docker kill "$NS_DRILL_PROJECT-pv-op" >/dev/null 2>&1 || true; wait || true
    committed=$(settle "$prefix")
  else
    docker kill "$(container admin)" >/dev/null; wait || true
    committed=$(registry_count "$prefix")
    printf '{"drill":"%s","step":"committed-at-death","observed":%s,"of":%s}\n' "$drill" "$committed" "$count"
    [ "$committed" -gt 0 ] && [ "$committed" -lt "$count" ] || { printf '{"drill":"%s","result":"inconclusive","reason":"the fault did not land inside the batch"}\n' "$drill"; exit 2; }
    admin_up
  fi
  step no-half-admitted-tenant "$(incomplete "$prefix")" 0
  step root-custody-received "$(custody "$prefix")" 0
  printf '{"drill":"%s","step":"admitted-without-custody","observed":%s}\n' "$drill" "$committed"
  # The allowed retry: the same request, same ids. It must not issue a second root secret.
  retry=$(client pv-op2 deploy/multitenant/prime.js add 2>&1 | field error || true)
  step retry-refuses-missing-custody "\"$retry\"" '"PRIMER_PROVISION_REFUSED_OR_CUSTODY_MISSING"'
  step all-requested-admitted-after-retry "$(registry_count "$prefix")" "$count"
  step no-half-admitted-tenant-after-retry "$(incomplete "$prefix")" 0
  step custody-only-for-tenants-created-by-retry "$(custody "$prefix")" $((count - committed))
  step seed-tenant-unaffected "$(sql "SELECT count(*) FROM nsdemo_registry.tenant_registry WHERE state='active' AND tenant_id::text NOT LIKE '$prefix%'")" "${NS_DRILL_OTHER_TENANTS:-2}"
  rm -f "$state/primer/add.json"
  # Observation, not pass/fail (it depends on timing): a tenant-local restore attempted straight
  # after provisioning activity. What matters is that a refusal here leaves the tenant open.
  fresh pv; seed_tenant=$(driver pv-seed seed pv | field tenant)
  attempt=$(driver pv-r restore pv || true)
  printf '{"drill":"%s","observe":"restore-straight-after-provisioning","value":"%s"}\n' "$drill" "$(echo "$attempt" | field error)$(echo "$attempt" | field state)"
  step seed-tenant-open-after-that-attempt "\"$(window "$seed_tenant")\"" '"active|false|false"'
  printf '{"drill":"%s","stop":"%s tenant(s) are admitted with a root secret nobody holds; operator decision required"}\n' "$drill" "$committed"
  ;;
ownership-admin-death)
  name=ow; fresh $name; before=$(client ow-prep /run/ns-drill/ownership.cjs prepare $name | field owners)
  docker kill "$(container admin)" >/dev/null
  step request-fails-while-admin-is-down "\"$( [ -n "$(client ow-add1 /run/ns-drill/ownership.cjs add $name | field error)" ] && echo failed || echo answered)\"" '"failed"'
  admin_up
  step owners-unchanged "$(client ow-l1 /run/ns-drill/ownership.cjs list $name | field owners)" "$before"
  step retry-applies "\"$(client ow-add2 /run/ns-drill/ownership.cjs add $name | field outcome)\"" '"applied"'
  step owners-after-retry "$(client ow-l2 /run/ns-drill/ownership.cjs list $name | field owners)" $((before + 1))
  ;;
ownership-lost-acknowledgement)
  name=ol; fresh $name; client ol-prep /run/ns-drill/ownership.cjs prepare $name >/dev/null
  before=$(client ol-l0 /run/ns-drill/ownership.cjs list $name | field owners)
  # The reply is discarded: the caller does not know whether the change was applied.
  client ol-add1 /run/ns-drill/ownership.cjs add $name >/dev/null 2>&1 || true
  # Inspect first. Then a replay of the identical request must be refused, not applied twice.
  step inspection-shows-applied "$(client ol-l1 /run/ns-drill/ownership.cjs list $name | field owners)" $((before + 1))
  step identical-replay-refused "\"$(client ol-add2 /run/ns-drill/ownership.cjs add $name | field code)\"" '"OWNERSHIP_CONFLICT"'
  step owners-after-replay "$(client ol-l2 /run/ns-drill/ownership.cjs list $name | field owners)" $((before + 1))
  ;;
*) echo 'DRILL_USAGE' >&2; exit 64 ;;
esac
finish
