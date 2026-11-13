'use strict';
// Sealed RT metadata, not admission authority. The fixed host validates its
// canonical physical plan/current ledger and actual prepared files before use.
// No existing plan/map/ledger conversion, provider selector or resource effect.
const {isDeepStrictEqual:equal}=require('node:util');
const B=require('./connection-budget'),C=require('./control-recovery'),W=require('./worker-database'),R=require('./realtime-recovery-roster');
const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&equal(Object.keys(v).sort(),[...keys].sort());
const name=v=>typeof v==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(v)&&!['public','information_schema'].includes(v)&&!v.startsWith('pg_');
const int=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
function normalize(raw,internal){
 raw=structuredClone(raw);
 need(exact(raw,['version','ownershipVersion','consumer','namespaces','plan','roster','desired','policy','execution'])&&raw.version===1&&raw.ownershipVersion===2,'REALTIME_RECOVERY_CONFIG');
 const plan=raw.plan;need(plan?.version===2,'REALTIME_RECOVERY_FRESH_PROFILE_REQUIRED');const{sha256,...body}=plan;need(sha256===B.hash(body),'REALTIME_RECOVERY_CONFIG_PLAN');
 C.ledger(plan);const database=W.identity(plan.workerDatabase),principal=C.principal(plan.controlRecovery?.classes?.['realtime-recovery']?.principal);need(principal.database===database.database&&principal.databaseOid===database.databaseOid,'REALTIME_RECOVERY_CONFIG_DATABASE');
 require('../../lib/realtime-placement/owner').key({worker:'validation',consumer:raw.consumer,ownershipVersion:2,assignmentIncarnation:'00000000-0000-4000-8000-000000000001'});
 need(exact(raw.namespaces,['control','registry'])&&name(raw.namespaces.control)&&name(raw.namespaces.registry)&&raw.namespaces.control!==raw.namespaces.registry,'REALTIME_RECOVERY_CONFIG_NAMESPACES');
 need(raw.roster&&equal(R.prepare({plan,expected:raw.roster.expected,templates:raw.roster.templates,participants:raw.roster.participants,internal}),raw.roster),'REALTIME_RECOVERY_CONFIG_ROSTER');
 R.desired(plan,raw.roster,raw.desired,internal);
 const p=raw.policy;need(exact(p,['version','gracePeriodMs','limits'])&&p.version===1&&int(p.gracePeriodMs,1,300000)&&exact(p.limits,['maxLogicalMoves','maxAssignmentChanges','maxAffectedTenants'])&&int(p.limits.maxLogicalMoves,0,65536)&&int(p.limits.maxAssignmentChanges,0,65536)&&int(p.limits.maxAffectedTenants,1,100000),'REALTIME_RECOVERY_CONFIG_POLICY');
 const e=raw.execution;need(exact(e,['timeoutMs','readinessTimeoutMs','maxRegistryTenants'])&&int(e.timeoutMs,1,900000)&&int(e.readinessTimeoutMs,1,e.timeoutMs)&&int(e.maxRegistryTenants,1,100000)&&p.limits.maxAffectedTenants<=e.maxRegistryTenants,'REALTIME_RECOVERY_CONFIG_BOUNDS');
 return freeze(structuredClone(raw));
}
function context(config,{beforeBytes,routesBytes,candidateBytes=null,intent,configSha256,environmentSha256,workerFiles,internal}){
 return{plan:config.plan,prepared:config.roster,beforeBytes,routesBytes,candidateBytes,intent,desired:config.desired,policy:config.policy,sealedFiles:{configSha256,environmentSha256},workerFiles,execution:config.execution,internal};
}
function environment(value,config){
 value=structuredClone(value);
 need(exact(value,['NS_SOURCE_COMMIT','NS_REALTIME_RECOVERY_PG'])&&value.NS_SOURCE_COMMIT===config.plan.source.coreCommit&&typeof value.NS_REALTIME_RECOVERY_PG==='string'&&value.NS_REALTIME_RECOVERY_PG.length>0&&Buffer.byteLength(value.NS_REALTIME_RECOVERY_PG)<=16384,'REALTIME_RECOVERY_ENV');
 // Pure installed-driver parsing only; the physical2 gate checks the actual
 // database/OID on the same backend before ordinary queries are exposed.
 need(W.effective(value.NS_REALTIME_RECOVERY_PG)===config.plan.workerDatabase.database,'REALTIME_RECOVERY_ENV_DATABASE');
 const uri=new URL(value.NS_REALTIME_RECOVERY_PG),principal=C.principal(config.plan.controlRecovery.classes['realtime-recovery'].principal);need(['postgres:','postgresql:'].includes(uri.protocol)&&decodeURIComponent(uri.username)===principal.role&&decodeURIComponent(uri.pathname.slice(1))===principal.database,'REALTIME_RECOVERY_ENV_PRINCIPAL');
 return freeze(value);
}
module.exports=Object.freeze({normalize,context,environment});
