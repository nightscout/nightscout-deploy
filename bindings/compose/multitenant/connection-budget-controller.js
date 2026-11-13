'use strict';
// Effect ordering is intentional: durable credit precedes ticket and process
// construction. A failed effect never refunds uncertain physical connections.
const fs=require('node:fs');
const {isDeepStrictEqual:equal}=require('node:util');
const B=require('./connection-budget'),F=require('./connection-budget-files');
const need=(v,c)=>{if(!v)throw Object.assign(new Error(c),{code:c});};
function custody(actual, expected, service, stopped=false){
 need(actual && actual.project===expected.project && actual.workingDirectory===expected.workingDirectory && actual.service===service
   && actual.imageId===expected.imageId && equal(actual.source,expected.source) && /^[a-f0-9]{64}$/.test(actual.cid)
   && typeof actual.startedAt==='string' && actual.startedAt.length>0 && (stopped?actual.running===false&&actual.exitCode===0&&actual.oomKilled===false&&actual.runtimeError==='':actual.running===true),'CONNECTION_CONTROLLER_CUSTODY');
 return {cid:actual.cid,startedAt:actual.startedAt,project:actual.project,workingDirectory:actual.workingDirectory,service,imageId:actual.imageId,source:actual.source};
}
function create({directory,plan,expected,ports}){
 need(B.hash((({sha256,...body})=>body)(plan))===plan.sha256 && equal(expected.source,plan.source)
   && /^[a-z][a-z0-9-]{0,62}$/.test(expected.project) && expected.workingDirectory.startsWith('/')
   && /^sha256:[a-f0-9]{64}$/.test(expected.imageId),'CONNECTION_CONTROLLER_PLAN');
 // Observer and effect implementation are fixed by the host adapter, never read
 // from the profile, ticket, private environment or a module-path field.
 for(const name of ['observe','inspect','start','stop','ticket','ack'])need(typeof ports[name]==='function','CONNECTION_CONTROLLER_PORT');
 function locked(fn){return F.locked(directory,fd=>{let book;try{book=F.readAt(fd,'ledger.json');}catch(e){if(e.code!=='ENOENT'&&e.code!=='CONNECTION_BUDGET_PRIVATE_FILE')throw e;need(F.inspect(fd,'ledger.json')===null,'CONNECTION_CONTROLLER_LEDGER');book=B.ledger(plan);}
   const observe=(...args)=>{F.writeAt(fd,'observer-claim.json',{kind:'bounded-observer-in-flight',planSha256:plan.sha256},{exclusive:true});const result=ports.observe(...args);need(result&&typeof result.then!=='function','CONNECTION_CONTROLLER_OBSERVATION_UNKNOWN');fs.unlinkSync(F.location(fd,'observer-claim.json'));fs.fsyncSync(fd);return result;};
   return fn(book,()=>F.writeAt(fd,'ledger.json',book),observe);});}
 function observe(){return locked((book,save,chargedObserve)=>{
   need(book.version===1&&book.planSha256===plan.sha256&&equal(book.resourceEpoch,[plan.resource.systemIdentifier,plan.resource.postmasterStartedAt])
     &&book.slots&&equal(Object.keys(book.slots).sort(),plan.slots.map(s=>s.processInstanceId).sort()),'CONNECTION_ADMISSION_LEDGER_CHANGED');
   const rows=Object.values(book.slots).flat();
   need(rows.length<=4096&&rows.every(r=>r&&['ISSUED','RETIRED'].includes(r.state)&&/^[a-f0-9]{32}$/.test(r.incarnation)&&Array.isArray(r.tags)),'CONNECTION_CONTROLLER_LEDGER');
   const wanted=[...new Set(rows.filter(r=>r.state!=='RETIRED').flatMap(r=>r.tags))].sort();
   const startedNs=process.hrtime.bigint().toString();
   const raw=chargedObserve(plan,wanted,wanted),resource=wanted.length?raw.resource:raw,tags=wanted.length?raw.tags:[];
   B.observedResourceMatches(plan,resource);
   need(Array.isArray(tags)&&tags.length===wanted.length&&tags.every(t=>t&&typeof t.applicationName==='string'&&wanted.includes(t.applicationName)&&Number.isSafeInteger(t.count)&&t.count>=0&&t.count<=1000000)
     &&equal(tags.map(t=>t.applicationName).sort(),wanted),'CONNECTION_CONTROLLER_OBSERVATION_UNKNOWN');
   const result={version:1,kind:'controlled-connection-observation',planSha256:plan.sha256,source:structuredClone(plan.source),expected:structuredClone(expected),
     ledger:structuredClone(book),resource,tags,visibility:'PG_STAT_AUTHENTICATED_ONLY',limitations:['PREAUTHENTICATION_NOT_VISIBLE','LEDGER_STATE_IS_NOT_PROCESS_LIVENESS'],
     hostMonotonic:{startedNs,finishedNs:process.hrtime.bigint().toString()}};
   need(Buffer.byteLength(JSON.stringify(result))<=1048576,'CONNECTION_CONTROLLER_OBSERVATION_BOUND');
   return result;
 });}
 function start(slotId){return locked((book,save,observe)=>{
   need(plan.slots.some(s=>s.processInstanceId===slotId),'CONNECTION_ADMISSION_UNPLANNED_WORKER');
   const observation=observe(plan,[],Object.values(book.slots).flat().filter(x=>x.state!=='RETIRED').flatMap(x=>x.tags));const ticket=B.generation(plan,book,slotId,observation);save();
   // Any crash after this point consumes the full outstanding generation.
   ports.ticket(slotId,ticket);ports.start(slotId);
   const actual=custody(ports.inspect(slotId),expected,slotId);
   B.recordStarted(plan,book,slotId,ticket.incarnation,actual);save();
   return {state:'STARTED',processInstanceId:slotId,incarnation:ticket.incarnation};
 });}
 function stop(slotId){return locked((book,save,observe)=>{
   const rows=book.slots[slotId];need(rows,'CONNECTION_ADMISSION_UNPLANNED_WORKER');
   const old=rows.filter(x=>x.state!=='RETIRED').at(-1);need(old?.container,'CONNECTION_CONTROLLER_NO_BOUND_PROCESS');
   const before=custody(ports.inspect(slotId),expected,slotId);need(equal(before,old.container),'CONNECTION_CONTROLLER_INCARNATION_CHANGED');
   ports.stop(old.container.cid); // exact CID only; force/timeout alone is no proof
   const after=custody(ports.inspect(slotId),expected,slotId,true);need(equal(after,old.container),'CONNECTION_CONTROLLER_INCARNATION_CHANGED');
   const ack=ports.ack(slotId,old.incarnation),observation=observe(plan,old.tags,Object.values(book.slots).flat().filter(x=>x.state!=='RETIRED').flatMap(x=>x.tags));
   B.observedResourceMatches(plan,observation.resource);
   B.retire(plan,book,slotId,{incarnation:old.incarnation,nonce:old.nonce,planSha256:plan.sha256,source:plan.source,
     oldCid:before.cid,oldStartedAt:before.startedAt,stoppedCid:after.cid,stoppedStartedAt:after.startedAt,stopped:true,ack,
     pgTagRows:observation.tags,resourceEpoch:[observation.resource.systemIdentifier,observation.resource.postmasterStartedAt]});save();
   return {state:'QUIESCED_RETIRED',processInstanceId:slotId,incarnation:old.incarnation};
 });}
 return Object.freeze({start,stop,observe});
}
module.exports={create,custody};
