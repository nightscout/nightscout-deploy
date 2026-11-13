'use strict';
// Fixed host-derived action grammar only. This does not admit a lease, prove
// process termination or execute publication. Journal/entry must bind its exact
// semantic digest AND exclusive raw bytes to the one common execution lease.
const crypto=require('node:crypto'),{isDeepStrictEqual:equal}=require('node:util');
const actions=new WeakSet();
const placement=require('../../lib/realtime-placement'),R=require('./realtime-recovery-roster'),B=require('./connection-budget');
const fail=code=>{throw Object.assign(Error(code),{code});};
const need=(v,c='REALTIME_RECOVERY_ACTION')=>{if(!v)fail(c);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&equal(Object.keys(v).sort(),[...keys].sort());
const hex=(v,n)=>typeof v==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)&&v!=='00000000-0000-0000-0000-000000000000';
const id=v=>typeof v==='string'&&/^[a-z][a-z0-9_-]{0,62}$/.test(v);
const integer=(v,max)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
const rawSha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function canonical(v){return v&&typeof v==='object'?Array.isArray(v)?v.map(canonical):Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;}
function semantic(v){return rawSha(Buffer.from(JSON.stringify(canonical(v))));}
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function map(bytes,internal){need(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=1048576,'REALTIME_RECOVERY_ACTION_MAP');let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{fail('REALTIME_RECOVERY_ACTION_MAP');}return placement.parse(value,{internal,ownershipVersion:2});}
function normalize(value,{plan,prepared,beforeBytes,routesBytes,candidateBytes=null,internal,intent,desired,policy,sealedFiles,workerFiles}){
 const v=structuredClone(value);
 need(exact(v,['version','class','actionId','leaseIncarnation','nonce','intentSha256','source','planSha256','resourceEpoch','expected','inventorySha256','desiredSha256','policySha256','configSha256','environmentSha256','kind','before','candidate','oldBindings','starts','limits'])&&v.version===1&&v.class==='realtime-recovery'&&uuid(v.actionId)&&hex(v.leaseIncarnation,32)&&hex(v.nonce,32)&&v.leaseIncarnation!==v.nonce&&hex(v.intentSha256,64));
 need(equal(v.source,plan.source)&&equal(v.expected,prepared.expected)&&v.planSha256===plan.sha256&&v.inventorySha256===prepared.sha256&&hex(v.desiredSha256,64)&&hex(v.policySha256,64)&&Array.isArray(v.resourceEpoch)&&v.resourceEpoch.length===2&&v.resourceEpoch.every(x=>typeof x==='string'&&x.length>0&&x.length<=128)&&equal(v.resourceEpoch,[plan.resource.systemIdentifier,plan.resource.postmasterStartedAt]));
 need(exact(sealedFiles,['configSha256','environmentSha256'])&&hex(sealedFiles.configSha256,64)&&hex(sealedFiles.environmentSha256,64)&&v.configSha256===sealedFiles.configSha256&&v.environmentSha256===sealedFiles.environmentSha256,'REALTIME_RECOVERY_ACTION_FILES');
 need(exact(intent,['version','command'])&&intent.version===1&&['inspect','reconcile-step'].includes(intent.command)&&v.intentSha256===B.hash(intent)&&(intent.command==='inspect'?v.kind==='inspect':v.kind!=='inspect'),'REALTIME_RECOVERY_ACTION_INTENT');
 need(['inspect','no-op','self-restart','peer-takeover','roster-step'].includes(v.kind)&&Array.isArray(v.oldBindings)&&v.oldBindings.length<=1&&Array.isArray(v.starts)&&v.starts.length<=2);
 need(exact(v.limits,['maxLogicalMoves','maxAssignmentChanges','maxAffectedTenants'])&&integer(v.limits.maxLogicalMoves,65536)&&integer(v.limits.maxAssignmentChanges,65536)&&integer(v.limits.maxAffectedTenants,100000));
 const declared=R.desired(plan,prepared,desired,internal);
 need(exact(policy,['version','gracePeriodMs','limits'])&&policy.version===1&&Number.isSafeInteger(policy.gracePeriodMs)&&policy.gracePeriodMs>=1&&policy.gracePeriodMs<=300000&&exact(policy.limits,['maxLogicalMoves','maxAssignmentChanges','maxAffectedTenants'])&&integer(policy.limits.maxLogicalMoves,65536)&&integer(policy.limits.maxAssignmentChanges,65536)&&integer(policy.limits.maxAffectedTenants,100000),'REALTIME_RECOVERY_ACTION_POLICY');
 need(v.desiredSha256===semantic(declared)&&v.policySha256===semantic(policy)&&Object.keys(v.limits).every(k=>v.limits[k]<=policy.limits[k]),'REALTIME_RECOVERY_ACTION_POLICY');
 const before=map(beforeBytes,internal),routes=map(routesBytes,internal);R.select({plan,prepared,map:JSON.parse(beforeBytes),platform:[],internal});
 need(exact(v.before,['generation','mapSha256','mapFileSha256','routesFileSha256'])&&v.before.generation===before.generation&&v.before.mapSha256===before.digest&&v.before.mapFileSha256===rawSha(beforeBytes)&&v.before.routesFileSha256===rawSha(routesBytes));
 // A new mutation cannot paper over an uncertain earlier backend/route fork.
 need(v.kind==='inspect'||routes.digest===before.digest&&routes.generation===before.generation,'REALTIME_RECOVERY_ACTION_UNCERTAIN_MAP');
 const publication=['peer-takeover','roster-step'].includes(v.kind);let candidate=null;
 if(publication){candidate=map(candidateBytes,internal);R.select({plan,prepared,map:JSON.parse(candidateBytes),platform:[],internal});let selected=before;const continuity=placement.create({read:()=>selected,continuous:true});continuity.current();selected=candidate;continuity.current();
  need(exact(v.candidate,['generation','mapSha256','mapFileSha256'])&&v.candidate.generation===candidate.generation&&v.candidate.mapSha256===candidate.digest&&v.candidate.mapFileSha256===rawSha(candidateBytes)&&candidate.generation===before.generation+1&&v.oldBindings.length===1);
  const logical=before.owners.reduce((n,o,i)=>n+(o?.worker!==candidate.owners[i]?.worker?1:0),0),assignments=before.owners.reduce((n,o,i)=>n+(!placement.sameOwner(o,candidate.owners[i])?1:0),0);
  need(logical<=v.limits.maxLogicalMoves&&assignments<=v.limits.maxAssignmentChanges&&v.limits.maxAffectedTenants>=1,'REALTIME_RECOVERY_ACTION_WORK_BOUND');
 }else need(v.candidate===null&&candidateBytes===null);
 const services=new Set();
 for(const old of v.oldBindings){const t=prepared.templates.find(t=>t.worker===old?.worker),current=before.workers.get(old?.worker),c=old?.container;
  need(exact(old,['worker','assignmentIncarnation','service','container'])&&id(old.worker)&&uuid(old.assignmentIncarnation)&&t&&current&&old.assignmentIncarnation===current.incarnation&&old.service===t.service&&exact(c,['cid','startedAt','service','project','workingDirectory','imageId','source'])&&hex(c.cid,64)&&typeof c.startedAt==='string'&&c.startedAt.length>0&&c.startedAt.length<=100&&c.service===t.service&&equal(Object.fromEntries(Object.keys(prepared.expected).map(k=>[k,c[k]])),prepared.expected),'REALTIME_RECOVERY_ACTION_OLD_IDENTITY');
 }
 for(const start of v.starts){const t=prepared.templates.find(t=>t.worker===start?.worker),target=(candidate||before).workers.get(start?.worker);
  need(exact(start,['worker','assignmentIncarnation','service','slotId','configSha256','environmentSha256','effectiveEnvironmentSha256'])&&id(start.worker)&&uuid(start.assignmentIncarnation)&&t&&target&&start.assignmentIncarnation===target.incarnation&&start.service===t.service&&start.slotId===t.service&&start.configSha256===t.configSha256&&start.environmentSha256===t.environmentSha256&&!services.has(start.service),'REALTIME_RECOVERY_ACTION_START');const view=require('./realtime-recovery-worker-view').derive(t,start.assignmentIncarnation,workerFiles?.[start.service]||{});need(start.effectiveEnvironmentSha256===view.environmentSha256,'REALTIME_RECOVERY_ACTION_START_ENVIRONMENT');services.add(start.service);
 }
 if(publication){need(equal(candidate.stopped.map(o=>({worker:o.worker,incarnation:o.incarnation})),v.oldBindings.map(o=>({worker:o.worker,incarnation:o.assignmentIncarnation}))),'REALTIME_RECOVERY_ACTION_OLD_IDENTITY');
  // Every changed/new target assignment must be started through its sealed slot;
  // removed assignments may only disappear through the one old binding above.
  const changed=[...candidate.workers.values()].filter(w=>before.workers.get(w.id)?.incarnation!==w.incarnation);
  need(equal(changed.map(w=>[w.id,w.incarnation]).sort(),v.starts.map(w=>[w.worker,w.assignmentIncarnation]).sort()),'REALTIME_RECOVERY_ACTION_START');
 }else if(v.kind==='self-restart')need(v.oldBindings.length===1&&v.starts.length===1&&v.starts[0].worker===v.oldBindings[0].worker&&v.starts[0].assignmentIncarnation===v.oldBindings[0].assignmentIncarnation&&v.limits.maxLogicalMoves===0&&v.limits.maxAssignmentChanges===0&&v.limits.maxAffectedTenants>=1);
 else need(v.oldBindings.length===0&&v.starts.length===0&&Object.values(v.limits).every(n=>n===0));
 const normalized=freeze(canonical(v));actions.add(normalized);return normalized;
}
function envelope(action){need(actions.has(action),'REALTIME_RECOVERY_ACTION_UNVALIDATED');const v={version:1,action,actionSha256:semantic(action)},bytes=Buffer.from(JSON.stringify(v)+'\n');need(bytes.length<=65536,'REALTIME_RECOVERY_ACTION_BOUND');return{envelope:freeze(v),bytes,actionSha256:v.actionSha256,actionFileSha256:rawSha(bytes)};}
function read(bytes,context){need(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=65536,'REALTIME_RECOVERY_ACTION_BOUND');let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{fail('REALTIME_RECOVERY_ACTION');}need(exact(value,['version','action','actionSha256'])&&value.version===1&&hex(value.actionSha256,64));const action=normalize(value.action,context);need(value.actionSha256===semantic(action),'REALTIME_RECOVERY_ACTION_DIGEST');return Object.freeze({action,actionSha256:value.actionSha256,actionFileSha256:rawSha(bytes)});}
module.exports=Object.freeze({normalize,envelope,read,semantic,rawSha});
