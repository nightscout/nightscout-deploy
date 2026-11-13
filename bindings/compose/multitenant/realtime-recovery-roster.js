'use strict';
// Fixed host-side metadata only. No allocation, process effect, SQL or proof of
// physical termination. All runtime effects still recheck actual host custody.
const {isDeepStrictEqual:equal}=require('node:util');
const B=require('./connection-budget'),placement=require('../../lib/realtime-placement');
const manifests=require('../../lib/server/serve/operation-cohort-manifest');
const ipc=require('../../lib/server/internal-api/listener-config');
const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&equal(Object.keys(v).sort(),[...keys].sort());
const id=v=>typeof v==='string'&&/^[a-z][a-z0-9_-]{0,62}$/.test(v);
const hex=(v,n)=>typeof v==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
function frozen(value){const out=structuredClone(value);function visit(v){if(v&&typeof v==='object'){Object.values(v).forEach(visit);Object.freeze(v);}}visit(out);return out;}
function planIdentity(plan,expected){
 need(plan?.version===2&&exact(expected,['source','project','workingDirectory','imageId'])&&equal(plan.source,expected.source)&&exact(plan.source,['coreCommit','deployCommit'])&&hex(plan.source?.coreCommit,40)&&hex(plan.source?.deployCommit,40)&&typeof expected.project==='string'&&/^[a-z][a-z0-9-]{0,62}$/.test(expected.project)&&typeof expected.workingDirectory==='string'&&expected.workingDirectory.startsWith('/')&&typeof expected.imageId==='string'&&/^sha256:[a-f0-9]{64}$/.test(expected.imageId),'REALTIME_RECOVERY_SOURCE');
 const {sha256,...body}=plan;need(sha256===B.hash(body)&&Array.isArray(plan.slots)&&plan.slots.length<=1024,'REALTIME_RECOVERY_PLAN');
 need(exact(plan.workerDatabase,['database','databaseOid'])&&typeof plan.workerDatabase.database==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(plan.workerDatabase.database)&&typeof plan.workerDatabase.databaseOid==='string'&&/^[1-9][0-9]{0,9}$/.test(plan.workerDatabase.databaseOid)&&Number(plan.workerDatabase.databaseOid)<=4294967295,'REALTIME_RECOVERY_DATABASE');
}
function prepare({plan,expected,templates,participants,internal}){
 planIdentity(plan,expected);
 need(Array.isArray(templates)&&templates.length>=1&&templates.length<=16,'REALTIME_RECOVERY_INVENTORY_BOUND');
 const fixed=manifests.validate(participants),rt=fixed.filter(row=>row.roles.includes('realtime'));
 need(rt.length===templates.length&&rt.every(row=>equal(row.roles,['realtime'])),'REALTIME_RECOVERY_SINGLE_ROLE_REQUIRED');
 const workers=new Set(),services=new Set(),pids=new Set();
 for(const t of templates){
  need(exact(t,['worker','service','participantId','address','consumerOrigin','configSha256','environmentSha256'])&&id(t.worker)&&id(t.service)&&id(t.participantId)&&hex(t.configSha256,64)&&hex(t.environmentSha256,64)&&!workers.has(t.worker)&&!services.has(t.service)&&!pids.has(t.participantId),'REALTIME_RECOVERY_TEMPLATE');
  const slots=plan.slots.filter(row=>row.processInstanceId===t.service),rows=rt.filter(row=>row.id===t.participantId&&row.worker===t.worker);
  need(slots.length===1&&equal(slots[0].roles,['realtime'])&&slots[0].capabilities?.['nightscout-realtime-owner']?.kind==='pool'&&slots[0].capabilities['nightscout-realtime-owner'].poolMax===1&&slots[0].capabilities['nightscout-realtime-owner'].maxInstances===1&&rows.length===1,'REALTIME_RECOVERY_SLOT');
  workers.add(t.worker);services.add(t.service);pids.add(t.participantId);
 }
 // Parse every prepared destination through the actual map2 contract, without
 // claiming that these dummy validation assignments are running or healthy.
 const parsed=placement.parse({version:2,rule:placement.RULE,shardCount:1,generation:1,owners:[null],workers:templates.map(t=>({id:t.worker,incarnation:'00000000-0000-4000-8000-000000000001',address:t.address,consumerOrigin:t.consumerOrigin}))},{internal,ownershipVersion:2});
 for(const t of templates)need(ipc.key(parsed.workers.get(t.worker).endpoint)===ipc.key(rt.find(row=>row.id===t.participantId).endpoint),'REALTIME_RECOVERY_ENDPOINT');
 const body={version:1,ownershipVersion:2,source:plan.source,planSha256:plan.sha256,expected,templates,participants:fixed};
 return frozen({...body,sha256:B.hash(body)});
}
function checked(plan,prepared,internal){
 need(exact(prepared,['version','ownershipVersion','source','planSha256','expected','templates','participants','sha256'])&&prepared.version===1&&prepared.ownershipVersion===2,'REALTIME_RECOVERY_PREPARED');
 planIdentity(plan,prepared.expected);const {sha256,...body}=prepared;
 need(sha256===B.hash(body)&&prepared.planSha256===plan.sha256&&equal(prepared.source,plan.source),'REALTIME_RECOVERY_PREPARED');
 const rebuilt=prepare({plan,expected:prepared.expected,templates:prepared.templates,participants:prepared.participants,internal});
 need(equal(rebuilt,prepared),'REALTIME_RECOVERY_PREPARED');
}
function desired(plan,prepared,value,internal){
 checked(plan,prepared,internal);
 need(exact(value,['version','workers'])&&value.version===1&&Array.isArray(value.workers)&&value.workers.length>=1&&value.workers.length<=16&&value.workers.every(worker=>typeof worker==='string'&&prepared.templates.some(row=>row.worker===worker))&&new Set(value.workers).size===value.workers.length,'REALTIME_RECOVERY_DESIRED');
 return frozen(value);
}
function select({plan,prepared,map,platform,internal}){
 checked(plan,prepared,internal);const parsed=placement.parse(map,{internal,ownershipVersion:2});
 need(Array.isArray(platform)&&platform.length<=256,'REALTIME_RECOVERY_PLATFORM_BOUND');
 const byWorker=new Map(prepared.templates.map(row=>[row.worker,row])),seen=new Set(),possibleBoots=new Set();
 for(const worker of parsed.workers.values()){
  const template=byWorker.get(worker.id),peer=prepared.participants.find(row=>row.id===template?.participantId);
  need(template&&peer&&ipc.key(peer.endpoint)===ipc.key(worker.endpoint)&&new URL(template.consumerOrigin).origin===worker.consumerOrigin,'REALTIME_RECOVERY_UNPREPARED_WORKER');
 }
 for(const row of platform){
  need(exact(row,['worker','assignmentIncarnation','inspection','container','noFutureDispatch'])&&id(row.worker)&&uuid(row.assignmentIncarnation)&&['RUNNING','STOPPED','UNKNOWN'].includes(row.inspection)&&typeof row.noFutureDispatch==='boolean','REALTIME_RECOVERY_PLATFORM');
  const template=byWorker.get(row.worker);need(template,'REALTIME_RECOVERY_UNPLANNED_ACTOR');
  const assignment=row.worker+'\0'+row.assignmentIncarnation;
  if(row.inspection!=='STOPPED'){need(!possibleBoots.has(assignment),'REALTIME_RECOVERY_AMBIGUOUS_BOOT');possibleBoots.add(assignment);}
  const c=row.container;
  if(c!==null){
   need(exact(c,['cid','startedAt','service','project','workingDirectory','imageId','source','running'])&&hex(c.cid,64)&&typeof c.startedAt==='string'&&c.startedAt.length>=1&&c.startedAt.length<=100&&c.service===template.service&&equal(Object.fromEntries(Object.keys(prepared.expected).map(k=>[k,c[k]])),prepared.expected)&&typeof c.running==='boolean'&&!seen.has(c.cid),'REALTIME_RECOVERY_PLATFORM_CUSTODY');seen.add(c.cid);
  }
  need(row.inspection==='UNKNOWN'||c!==null&&(row.inspection==='RUNNING'?c.running===true&&row.noFutureDispatch===false:c.running===false&&row.noFutureDispatch===true),'REALTIME_RECOVERY_PLATFORM_STATE');
  const current=parsed.workers.get(row.worker);
  // Stop/no-future-dispatch is host-produced evidence, NOT supplied by caller
  // intent. Mutation paths must re-observe it; this is only peer selection.
  if(!current||current.incarnation!==row.assignmentIncarnation)need(row.inspection==='STOPPED'&&row.noFutureDispatch===true,'REALTIME_RECOVERY_UNMAPPED_ACTOR');
 }
 const currentIds=new Set(parsed.workers.keys()),rows=prepared.participants.filter(row=>!row.roles.includes('realtime')||currentIds.has(row.worker));
 const selected=manifests.validate(rows);
 need(selected.filter(row=>row.roles.includes('realtime')).length===currentIds.size,'REALTIME_RECOVERY_COVERAGE');
 return frozen({version:1,ownershipVersion:2,planSha256:plan.sha256,inventorySha256:prepared.sha256,mapGeneration:parsed.generation,mapDigest:parsed.digest,participants:selected,actorObservations:platform,authority:'PEER_SELECTION_ONLY_NOT_LIVENESS_OR_CREDIT_RETIREMENT'});
}
module.exports=Object.freeze({prepare,desired,select});
