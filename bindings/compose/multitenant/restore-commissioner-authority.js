'use strict';
// Source-fixed setup-only privilege exception. Inspect effective APPLICATION
// access on the admitted backend; baseline catalog metadata/TEMP is reported
// separately. This module creates no privilege, function, policy or connection.
const {isDeepStrictEqual:equal}=require('node:util'),C=require('./control-recovery');
const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
const SQL=`SELECT
 (SELECT row_to_json(r) FROM (SELECT oid::text AS oid,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolinherit FROM pg_catalog.pg_roles WHERE rolname=current_user) r) AS role,
 (SELECT count(*)::int FROM pg_catalog.pg_auth_members WHERE member=current_user::regrole::oid) AS memberships,
 (SELECT count(*)::int FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=current_user::regrole::oid AND deptype='o') AS ownerships,
 coalesce((SELECT json_agg(json_build_object('namespace',nspname,'usage',has_schema_privilege(oid,'USAGE'),'create',has_schema_privilege(oid,'CREATE')) ORDER BY nspname) FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'),'[]'::json) AS schemas,
 coalesce((SELECT json_agg(json_build_object('namespace',n.nspname,'relation',c.relname,'select',has_table_privilege(c.oid,'SELECT'),'insert',has_table_privilege(c.oid,'INSERT'),'update',has_table_privilege(c.oid,'UPDATE'),'delete',has_table_privilege(c.oid,'DELETE'),'truncate',has_table_privilege(c.oid,'TRUNCATE'),'references',has_table_privilege(c.oid,'REFERENCES'),'trigger',has_table_privilege(c.oid,'TRIGGER'),'columnSelect',has_any_column_privilege(c.oid,'SELECT'),'columnInsert',has_any_column_privilege(c.oid,'INSERT'),'columnUpdate',has_any_column_privilege(c.oid,'UPDATE'),'columnReferences',has_any_column_privilege(c.oid,'REFERENCES')) ORDER BY n.nspname,c.relname) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'),'[]'::json) AS relations,
 (SELECT count(*)::int FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_function_privilege(p.oid,'EXECUTE')) AS "applicationFunctions",
 (SELECT count(*)::int FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname !~ '^pg_' AND has_sequence_privilege(c.oid,'USAGE,SELECT,UPDATE')) AS sequences,
 (SELECT count(*)::int FROM pg_catalog.pg_database d,LATERAL aclexplode(d.datacl) a WHERE d.datname<>current_database() AND a.grantee=current_user::regrole::oid) AS "explicitCrossDatabase",
 (SELECT count(*)::int FROM pg_catalog.pg_default_acl d,LATERAL aclexplode(d.defaclacl) a WHERE a.grantee IN (0,current_user::regrole::oid)) AS "defaultApplicationGrants",
 has_database_privilege(current_database(),'CREATE') AS "permanentDatabaseDdl",
 EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('pg_monitor','pg_read_all_stats','pg_read_all_data','pg_write_all_data','pg_read_server_files','pg_write_server_files','pg_execute_server_program','pg_signal_backend') AND pg_has_role(current_user,oid,'MEMBER')) OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace,LATERAL aclexplode(p.proacl) a WHERE n.nspname='pg_catalog' AND a.grantee=current_user::regrole::oid) AS observer,
 json_build_object('temporaryDatabasePrivilege',has_database_privilege(current_database(),'TEMP'),'publicSchemaUsage',has_schema_privilege('public','USAGE'),'catalogMetadata','BASELINE_NOT_APPLICATION_AUTHORITY') AS baseline`;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&equal(Object.keys(v).sort(),[...keys].sort());
const PRIV=['select','insert','update','delete','truncate','references','trigger','columnSelect','columnInsert','columnUpdate','columnReferences'];
function expected(config){return [{namespace:config.registryNamespace,relation:'tenant_registry',insert:false},{namespace:config.namespace,relation:'tenant_lifecycle_windows',insert:false},{namespace:config.namespace,relation:'tenant_lifecycle_restore_authority',insert:true}];}
function validate(raw,config,principal){
 C.principal(principal);need(exact(raw,['role','memberships','ownerships','schemas','relations','applicationFunctions','sequences','explicitCrossDatabase','defaultApplicationGrants','permanentDatabaseDdl','observer','baseline']),'RESTORE_COMMISSION_PRIVILEGES');
 const r=raw.role;need(exact(r,['oid','rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','rolinherit'])&&r.oid===principal.roleOid&&r.rolbypassrls===true&&['rolsuper','rolcreaterole','rolcreatedb','rolreplication','rolinherit'].every(k=>r[k]===false),'RESTORE_COMMISSION_PRIVILEGES');
 for(const key of ['memberships','ownerships','applicationFunctions','sequences','explicitCrossDatabase','defaultApplicationGrants'])need(raw[key]===0,'RESTORE_COMMISSION_PRIVILEGES');need(raw.permanentDatabaseDdl===false&&raw.observer===false,'RESTORE_COMMISSION_PRIVILEGES');
 need(Array.isArray(raw.schemas)&&raw.schemas.length<=4096&&new Set(raw.schemas.map(s=>s?.namespace)).size===raw.schemas.length,'RESTORE_COMMISSION_PRIVILEGES');
 const namespaces=[config.namespace,config.registryNamespace];
 for(const s of raw.schemas)need(exact(s,['namespace','usage','create'])&&typeof s.namespace==='string'&&s.create===false&&typeof s.usage==='boolean'&&(namespaces.includes(s.namespace)?s.usage===true:s.namespace==='public'||s.usage===false),'RESTORE_COMMISSION_PRIVILEGES');
 need(namespaces.every(n=>raw.schemas.some(s=>s.namespace===n)),'RESTORE_COMMISSION_PRIVILEGES');
 const allowed=expected(config),seen=new Set();need(Array.isArray(raw.relations)&&raw.relations.length<=32768,'RESTORE_COMMISSION_PRIVILEGES');
 for(const row of raw.relations){need(exact(row,['namespace','relation',...PRIV])&&typeof row.namespace==='string'&&typeof row.relation==='string'&&PRIV.every(k=>typeof row[k]==='boolean'),'RESTORE_COMMISSION_PRIVILEGES');const key=row.namespace+'.'+row.relation;need(!seen.has(key),'RESTORE_COMMISSION_PRIVILEGES');seen.add(key);const item=allowed.find(a=>a.namespace===row.namespace&&a.relation===row.relation);
  need(PRIV.every(k=>row[k]===(item?(k==='select'||k==='columnSelect'?true:k==='insert'||k==='columnInsert'?item.insert:false):false)),'RESTORE_COMMISSION_PRIVILEGES');
 }
 need(allowed.every(a=>seen.has(a.namespace+'.'+a.relation)),'RESTORE_COMMISSION_PRIVILEGES');
 need(exact(raw.baseline,['temporaryDatabasePrivilege','publicSchemaUsage','catalogMetadata'])&&typeof raw.baseline.temporaryDatabasePrivilege==='boolean'&&typeof raw.baseline.publicSchemaUsage==='boolean'&&raw.baseline.catalogMetadata==='BASELINE_NOT_APPLICATION_AUTHORITY','RESTORE_COMMISSION_PRIVILEGES');
 return {policy:'fixed-commissioner-allowlist-v1',principal:structuredClone(principal),bypassRls:true,applicationRelations:allowed,baseline:structuredClone(raw.baseline)};
}
function proof(value,config,principal){
 C.principal(principal);need(exact(value,['policy','principal','bypassRls','applicationRelations','baseline'])&&value.policy==='fixed-commissioner-allowlist-v1'&&equal(value.principal,principal)&&value.bypassRls===true&&equal(value.applicationRelations,expected(config)),'RESTORE_COMMISSION_PRIVILEGES');
 const b=value.baseline;need(exact(b,['temporaryDatabasePrivilege','publicSchemaUsage','catalogMetadata'])&&typeof b.temporaryDatabasePrivilege==='boolean'&&typeof b.publicSchemaUsage==='boolean'&&b.catalogMetadata==='BASELINE_NOT_APPLICATION_AUTHORITY','RESTORE_COMMISSION_PRIVILEGES');return value;
}
async function verify(client,config,principal){const result=await client.query(SQL);need(result.rows.length===1,'RESTORE_COMMISSION_PRIVILEGES');return validate(result.rows[0],config,principal);}
module.exports={SQL,PRIV,expected,validate,proof,verify};
