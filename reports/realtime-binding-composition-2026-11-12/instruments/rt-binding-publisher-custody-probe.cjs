'use strict';
require('/opt/app/deploy/multitenant/load-env');
const fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 assert.deepEqual(fs.readdirSync('/run/ns-config'),['env.json']);for(const file of ['/run/ns-warm-config','/run/ns-ipc','/run/ns-artifacts'])assert.equal(fs.existsSync(file),false);
 for(const key of ['NS_OPERATOR_PG','NS_REALTIME_PG','NS_EVALUATOR_PG','VAULT_TOKEN'])assert.equal(process.env[key],undefined);
 const authority=require('/opt/app/deploy/multitenant/placement-authority').read('/run/ns-config/env.json',process.env.NS_SOURCE_COMMIT);const client=new(require('/opt/app/node_modules/pg').Client)({connectionString:authority.values.NS_PLACEMENT_PG});
 try{await client.connect();await require('/opt/app/lib/tenant-lifecycle/operation-window-readiness').admit(client,'nsdemo_control');const role=(await client.query('SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname=current_user')).rows[0];assert.ok(Object.values(role).every(value=>value===false));const extra=(await client.query("SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'nsdemo_%' AND c.relkind IN ('r','p') AND n.nspname NOT IN ('nsdemo_control','nsdemo_registry') AND (has_table_privilege(c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))")).rows[0];assert.equal(extra.count,0);console.log('PUBLISHER_CUSTODY_PROOF onlyScopedEnv onlyPlacementRW noServingRestoreTokensOrIPC readonlyAdmission noClinicalCounterAuthority');}finally{await client.end();}
})().catch(error=>{console.error('PUBLISHER_CUSTODY_REFUSED '+String(error.code||error.name));process.exitCode=1;});
