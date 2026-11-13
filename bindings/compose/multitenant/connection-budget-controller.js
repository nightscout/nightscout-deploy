'use strict';
// Effect ordering is intentional: durable credit precedes ticket and process
// construction. A failed effect never refunds uncertain physical connections.
const fs=require('node:fs');
const {isDeepStrictEqual:equal}=require('node:util');
const B=require('./connection-budget'),F=require('./connection-budget-files'),COUNTS=require('./connection-budget-counts'),O=require('./lifecycle-operator');
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
 function checkedCounts(selector,raw,knownTags){
   const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
   need(exact(raw,['resource','storedCounts','custody','diagnosticFile',...(O.enabled(plan)?['tagRows']:[])])&&/^counts-observation-[a-f0-9]{32}\.json$/.test(raw.diagnosticFile)&&typeof raw.then!=='function','CONNECTION_COUNTS_RESULT');
   B.observedResourceMatches(plan,raw.resource);COUNTS.result(selector,raw.storedCounts);
   const c=raw.custody,p=c?.postgres;
   need(exact(c,['source','project','workingDirectory','imageId','postgres'])&&equal(c.source,plan.source)&&c.project===expected.project
     &&c.workingDirectory===expected.workingDirectory&&c.imageId===expected.imageId
     &&exact(p,['cid','startedAt','imageId'])&&/^[a-f0-9]{64}$/.test(p.cid)&&typeof p.startedAt==='string'&&p.startedAt.length>0&&p.startedAt.length<=100
     &&p.imageId===require('./postgres-profile.json').imageId,'CONNECTION_COUNTS_CUSTODY');
   if(O.enabled(plan))need(Array.isArray(raw.tagRows)&&equal(raw.tagRows.map(t=>t.applicationName).sort(),knownTags)&&raw.tagRows.every(t=>exact(t,['applicationName','count'])&&Number.isSafeInteger(t.count)&&t.count>=0),'LIFECYCLE_OPERATOR_COUNTS_TAGS');
   return raw;
 }
 function locked(fn){return F.locked(directory,fd=>{let book;try{book=F.readAt(fd,'ledger.json');}catch(e){if(e.code!=='ENOENT'&&e.code!=='CONNECTION_BUDGET_PRIVATE_FILE')throw e;need(F.inspect(fd,'ledger.json')===null,'CONNECTION_CONTROLLER_LEDGER');need(!O.enabled(plan),'LIFECYCLE_OPERATOR_MISSING_FRESH_LEDGER');book=O.ledger(plan);}
   const charged=invoke=>{F.writeAt(fd,'observer-claim.json',{kind:'bounded-observer-in-flight',planSha256:plan.sha256},{exclusive:true});const result=invoke();need(result&&typeof result.then!=='function','CONNECTION_CONTROLLER_OBSERVATION_UNKNOWN');fs.unlinkSync(F.location(fd,'observer-claim.json'));fs.fsyncSync(fd);return result;};
   O.validate(plan,book);return fn(book,()=>F.writeAt(fd,'ledger.json',book),(...args)=>charged(()=>ports.observe(...args)),(...args)=>charged(()=>{const raw=ports.storedCounts(...args);try{return checkedCounts(args[1],raw,args[2]);}catch(error){if(/^counts-observation-[a-f0-9]{32}\.json$/.test(raw?.diagnosticFile||''))error.countsDiagnostic=raw.diagnosticFile;error.countsObservation=COUNTS.diagnostic(args[1],raw?.storedCounts);throw error;}}));});}
 function observe(){return locked((book,save,chargedObserve)=>{
   need([1,2].includes(book.version)&&book.planSha256===plan.sha256&&equal(book.resourceEpoch,[plan.resource.systemIdentifier,plan.resource.postmasterStartedAt])
     &&book.slots&&equal(Object.keys(book.slots).sort(),plan.slots.map(s=>s.processInstanceId).sort()),'CONNECTION_ADMISSION_LEDGER_CHANGED');
   const rows=Object.values(book.slots).flat();
   need(rows.length<=4096&&rows.every(r=>r&&['ISSUED','RETIRED'].includes(r.state)&&/^[a-f0-9]{32}$/.test(r.incarnation)&&Array.isArray(r.tags)),'CONNECTION_CONTROLLER_LEDGER');
   const wanted=O.known(plan,book);
   const startedNs=process.hrtime.bigint().toString();
   const raw=chargedObserve(plan,wanted,wanted),resource=wanted.length?raw.resource:raw,tags=wanted.length?raw.tags:[];
   B.observedResourceMatches(plan,resource);
   need(Array.isArray(tags)&&tags.length===wanted.length&&tags.every(t=>t&&typeof t.applicationName==='string'&&wanted.includes(t.applicationName)&&Number.isSafeInteger(t.count)&&t.count>=0&&t.count<=1000000)
     &&equal(tags.map(t=>t.applicationName).sort(),wanted),'CONNECTION_CONTROLLER_OBSERVATION_UNKNOWN');
   const result={version:1,kind:'controlled-connection-observation',planSha256:plan.sha256,source:structuredClone(plan.source),expected:structuredClone(expected),
     ledger:structuredClone(book),resource,tags,occupancy:{workers:tags.filter(t=>!book.controlLeases?.some(r=>r.tags.includes(t.applicationName))).reduce((n,t)=>n+t.count,0),control:tags.filter(t=>book.controlLeases?.some(r=>r.tags.includes(t.applicationName))).reduce((n,t)=>n+t.count,0)},visibility:'PG_STAT_AUTHENTICATED_ONLY',limitations:['PREAUTHENTICATION_NOT_VISIBLE','LEDGER_STATE_IS_NOT_PROCESS_LIVENESS'],
     hostMonotonic:{startedNs,finishedNs:process.hrtime.bigint().toString()}};
   need(Buffer.byteLength(JSON.stringify(result))<=1048576,'CONNECTION_CONTROLLER_OBSERVATION_BOUND');
   return result;
 });}
 function storedCounts(value){
   const selector=COUNTS.selector(value);
   need(plan.source.coreCommit===B.REVIEWED_CORE_COMMIT,'CONNECTION_BUDGET_UNREVIEWED_SOURCE');
   need(plan.resource.allowances.observers===2,'CONNECTION_COUNTS_OBSERVER_CEILING');
   need(typeof ports.storedCounts==='function','CONNECTION_COUNTS_PORT');
   return locked((book,save,observe,chargedCounts)=>{
     need([1,2].includes(book.version)&&book.planSha256===plan.sha256&&equal(book.resourceEpoch,[plan.resource.systemIdentifier,plan.resource.postmasterStartedAt])
       &&book.slots&&equal(Object.keys(book.slots).sort(),plan.slots.map(s=>s.processInstanceId).sort()),'CONNECTION_ADMISSION_LEDGER_CHANGED');
     const generations=Object.values(book.slots).flat();
     need(generations.length<=4096&&generations.every(r=>r&&['ISSUED','RETIRED'].includes(r.state)&&/^[a-f0-9]{32}$/.test(r.incarnation)&&Array.isArray(r.tags)),'CONNECTION_CONTROLLER_LEDGER');
     const tags=O.known(plan,book);
     const startedNs=process.hrtime.bigint().toString();
     const raw=chargedCounts(plan,selector,tags);
     return {version:1,kind:'controlled-native-stored-counts',source:structuredClone(plan.source),planSha256:plan.sha256,
       expected:structuredClone(expected),custody:structuredClone(raw.custody),diagnosticFile:raw.diagnosticFile,selector,selectorSha256:COUNTS.hash(selector),
       resource:structuredClone(raw.resource),...(O.enabled(plan)?{occupancy:{workers:raw.tagRows.filter(t=>!book.controlLeases.some(r=>r.tags.includes(t.applicationName))).reduce((n,t)=>n+t.count,0),control:raw.tagRows.filter(t=>book.controlLeases.some(r=>r.tags.includes(t.applicationName))).reduce((n,t)=>n+t.count,0)}}:{}),counts:COUNTS.result(selector,raw.storedCounts).rows,foreign:COUNTS.result(selector,raw.storedCounts).foreign,
       hostMonotonic:{startedNs,finishedNs:process.hrtime.bigint().toString()},
       scope:'FIXED_SYNTHETIC_COUNTS_ONLY_NOT_NATIVE_ACCEPTANCE'};
   });
 }
 function start(slotId){return locked((book,save,observe)=>{
   need(plan.slots.some(s=>s.processInstanceId===slotId),'CONNECTION_ADMISSION_UNPLANNED_WORKER');
   const observation=observe(plan,[],O.known(plan,book));const ticket=B.generation(plan,book,slotId,observation);save();
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
   const ack=ports.ack(slotId,old.incarnation),observation=observe(plan,old.tags,O.known(plan,book));
   B.observedResourceMatches(plan,observation.resource);
   B.retire(plan,book,slotId,{incarnation:old.incarnation,nonce:old.nonce,planSha256:plan.sha256,source:plan.source,
     oldCid:before.cid,oldStartedAt:before.startedAt,stoppedCid:after.cid,stoppedStartedAt:after.startedAt,stopped:true,ack,
     pgTagRows:observation.tags,resourceEpoch:[observation.resource.systemIdentifier,observation.resource.postmasterStartedAt]});save();
   return {state:'QUIESCED_RETIRED',processInstanceId:slotId,incarnation:old.incarnation};
 });}
 function lifecycleOperator(value){
  const request=O.intent(value);
  for(const name of ['operatorFiles','operatorTicket','operatorStart','operatorGate','operatorWait','operatorReceipt','operatorInspect'])need(typeof ports[name]==='function','LIFECYCLE_OPERATOR_PORT');
  let issued;
  locked((book,save,observe)=>{
   // Check selected resource using an independently charged observer. No control
   // effect exists before the durable ISSUED debit, including credential reads.
   B.observedResourceMatches(plan,observe(plan,[],O.known(plan,book)));
   const row=O.allocate(plan,book,request);save();issued=row.incarnation;
   try{
    const files=ports.operatorFiles(plan),ticket=O.ticket(plan,row,expected,files);
    ports.operatorTicket(ticket);ports.operatorStart(ticket);
    row.container=custody(ports.operatorInspect(ticket),expected,O.NAME);row.state='BOUND';save();
    ports.operatorGate(ticket,row.container); // auth gate opens after durable bind
   }catch(error){row.state='UNKNOWN';row.outcome='OUTCOME_UNCERTAIN';save();throw error;}
  });
  // The synchronous private lock never spans this bounded child wait.
  let waitError;try{ports.operatorWait(issued);}catch(error){waitError=error;}
  return locked((book,save,observe)=>{
   const row=book.controlLeases.find(r=>r.incarnation===issued);
   need(row&&row.state==='BOUND','LIFECYCLE_OPERATOR_CREDIT_HELD');
   try{
    if(waitError)throw waitError;
    const container=custody(ports.operatorInspect({incarnation:issued}),expected,O.NAME,true);
    const receipt=ports.operatorReceipt(issued),observation=observe(plan,row.tags,O.known(plan,book));
    O.close(plan,row,receipt,container,observation);save();
    return {state:'CLOSED',incarnation:issued,outcome:row.outcome,result:receipt.result};
   }catch(error){row.state='UNKNOWN';row.outcome='OUTCOME_UNCERTAIN';save();throw error;}
  });
 }
 return Object.freeze({start,stop,observe,storedCounts,lifecycleOperator});
}
module.exports={create,custody};
