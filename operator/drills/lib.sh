# Shared helpers for the recovery drills. Source it; it defines functions only.
# Every drill prints one JSON object per step on stdout and exits non-zero when an
# observation differs from the runbook's stated outcome.
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
stack="$here/stack.sh"
state=$("$stack" state)
drill_state="$state/drill"
mkdir -p -m 0700 "$drill_state"

# One-shot private operator container running the mounted driver. $1 = container name suffix.
driver() {
  local suffix=$1; shift
  "$stack" ops --name "$NS_DRILL_PROJECT-$suffix" -v "$here/container:/run/ns-drill:ro" -v "$drill_state:/run/ns-drill-state" \
    demo node -r ./deploy/multitenant/load-env.js /run/ns-drill/drill.cjs "$@"
}
# The shipping operator command line (restore.js export|restore), exactly as the runbook gives it.
operator_cli() {
  local suffix=$1; shift
  "$stack" ops --name "$NS_DRILL_PROJECT-$suffix" demo node -r ./deploy/multitenant/load-env.js deploy/multitenant/restore.js "$@" 2>&1
}
# Operator inspection: the bootstrap administrator inside the database container, read-only use.
sql() { "$stack" compose exec -T postgres psql -U postgres -d nightscout_compose_test -X -A -t -v ON_ERROR_STOP=1 -c "$1"; }
window() { sql "SELECT phase||'|'||(claim_id IS NOT NULL)||'|'||(artifact_digest IS NOT NULL) FROM nsdemo_control.tenant_lifecycle_windows WHERE tenant_id='$1'"; }
audit() { sql "SELECT COALESCE((SELECT state FROM nsdemo_control.tenant_lifecycle_restore_audit WHERE tenant_id='$1' ORDER BY started_at DESC LIMIT 1),'none')"; }
unfinished() { sql "SELECT count(*) FROM nsdemo_control.tenant_lifecycle_operations WHERE tenant_id='$1' AND NOT finished"; }
rows_digest() { sql "SELECT COALESCE(md5(string_agg(md5(t::text),'' ORDER BY md5(t::text))),'empty') FROM nsdemo_entries.entries t WHERE tenant_id='$1'"; }
# Tenants that have stored rows (a write clock) and no registry entry: roles cannot resolve them.
unregistered() { sql "SELECT count(*) FROM nsdemo_clock.tenant_write_clock c WHERE NOT EXISTS (SELECT 1 FROM nsdemo_registry.tenant_registry r WHERE r.tenant_id=c.tenant_id)"; }
registered() { sql "SELECT count(*) FROM nsdemo_registry.tenant_registry WHERE state='active'"; }
container() { "$stack" compose ps -q "$1"; }
wait_file() { # path, seconds
  local n=0; while [ ! -e "$1" ]; do n=$((n+1)); [ "$n" -gt $(( $2 * 10 )) ] && return 1; sleep 0.1; done
}
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const line=s.trim().split("\n").filter(Boolean).pop()||"{}";let v;try{v=JSON.parse(line)}catch{v={}};const out=v[process.argv[1]];process.stdout.write(out===undefined?"":typeof out==="object"?JSON.stringify(out):String(out))})' "$1"; }
step() { [ -n "$2" ] || set -- "$1" null "$3"; printf '{"drill":"%s","step":"%s","observed":%s,"expected":%s,"pass":%s}\n' "$drill" "$1" "$2" "$3" "$([ "$2" = "$3" ] && echo true || echo false)"; [ "$2" = "$3" ] || failed=1; }
finish() { printf '{"drill":"%s","result":"%s"}\n' "$drill" "$([ "${failed:-0}" = 0 ] && echo pass || echo fail)"; exit "${failed:-0}"; }
fresh() { rm -f "$drill_state/$1".*; }
# One-shot private lab-client container (root custody of the synthetic tenants) running a mounted driver.
client() {
  local suffix=$1; shift
  "$stack" ops --name "$NS_DRILL_PROJECT-$suffix" -v "$here/container:/run/ns-drill:ro" -v "$drill_state:/run/ns-drill-state" primer node "$@"
}
registry_count() { sql "SELECT count(*) FROM nsdemo_registry.tenant_registry WHERE tenant_id::text LIKE '$1%'"; }
