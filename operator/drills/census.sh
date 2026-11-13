#!/usr/bin/env bash
# Independent state census: every table in the deployment's application schemas, read by the
# database administrator inside the PostgreSQL container, without any application role or API.
# Prints one line per table (schema.table|rows|digest of the rows) in a fixed order. Only
# PostgreSQL needs to be running; take it with the application roles stopped to compare two
# points in time exactly. The output holds counts and digests, never row content.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
prefix=${NS_DRILL_SCHEMA_PREFIX:-nsdemo}
[[ "$prefix" =~ ^[a-z][a-z0-9]{0,20}$ ]] || { echo 'CENSUS_PREFIX_REFUSED' >&2; exit 64; }
"$here/stack.sh" compose exec -T postgres psql -U postgres -d nightscout_compose_test -X -A -t -v ON_ERROR_STOP=1 2>&1 <<SQL | sed -n 's/^INFO:  //p' 
DO \$\$
DECLARE r record; n bigint; d text;
BEGIN
  FOR r IN SELECT schemaname, tablename FROM pg_catalog.pg_tables WHERE schemaname LIKE '${prefix}\_%' ORDER BY 1, 2 LOOP
    EXECUTE format('SELECT count(*), COALESCE(md5(string_agg(md5(t::text), '''' ORDER BY md5(t::text))), ''empty'') FROM %I.%I t', r.schemaname, r.tablename) INTO n, d;
    RAISE INFO '%.%|%|%', r.schemaname, r.tablename, n, d;
  END LOOP;
END \$\$;
SQL
