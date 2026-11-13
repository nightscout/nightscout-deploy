'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),A=require('../realtime-recovery-action'),P=require('../realtime-recovery-protocol'),fixture=require('./realtime-recovery-action-fixture');
const hash='1'.repeat(64),binding='2'.repeat(64);
function lab(){const f=fixture(),action=A.normalize(f.value,f.context);return{action,state:P.create(binding)};}
function send(f,kind,result,index){const request={...P.tuple(f.action),sequence:f.state.sequence+1,kind,...(index===undefined?{}:{index})};f.state=P.acknowledge(f.action,P.begin(f.action,f.state,request),{...request,result});return request;}
const running={status:'BOUND',ticketFileSha256:hash,gateFileSha256:hash,claimFileSha256:hash};
const stopped={status:'STOPPED',noFutureDispatch:true,observationSha256:hash};
test('closed restart transcript requires exact stopped proof, released old-key transaction, new physical boot and bounded warm witness',()=>{
 const f=lab();send(f,'running',running);send(f,'confirm-old',stopped,0);send(f,'restart-cleared',{status:'RELEASED',mapSha256:f.action.before.mapSha256,proofSha256:hash});
 const s=f.action.starts[0];send(f,'start-selected',{status:'STARTED',container:{...f.action.oldBindings[0].container,cid:'9'.repeat(64),startedAt:'new-synthetic-birth'},incarnation:'4'.repeat(32),nonce:'5'.repeat(32),ticketFileSha256:hash,configSha256:s.configSha256,environmentSha256:s.effectiveEnvironmentSha256},0);
 assert.throws(()=>P.completed(f.action,f.state),{code:'REALTIME_RECOVERY_PROTOCOL_INCOMPLETE'});send(f,'warm-complete',{status:'READY',witnessSha256:hash});assert.equal(P.validate(f.action,f.state,binding),f.state);assert.equal(P.completed(f.action,f.state),A.semantic(f.state));
 const duplicate={...P.tuple(f.action),sequence:f.state.sequence+1,kind:'start-selected',index:0};assert.throws(()=>P.begin(f.action,f.state,duplicate),{code:'REALTIME_RECOVERY_PROTOCOL_PHASE'});
});
test('tuple coercion/replay/arbitrary fields, unsafe order, missing proofs and tampered persisted events refuse',()=>{
 const f=lab(),first={...P.tuple(f.action),sequence:1,kind:'running'};
 for(const change of [v=>v.nonce=[v.nonce],v=>v.actionSha256='f'.repeat(64),v=>v.sequence=0,v=>v.shell='unsafe',v=>v.index=0]){const bad=structuredClone(first);change(bad);assert.throws(()=>P.begin(f.action,f.state,bad));}
 assert.throws(()=>P.begin(f.action,f.state,{...first,kind:'restart-cleared'}));send(f,'running',running);
 assert.throws(()=>P.begin(f.action,f.state,{...first,sequence:2,kind:'start-selected',index:0}));
 send(f,'confirm-old',{...stopped,status:'RUNNING',noFutureDispatch:false},0);assert.throws(()=>P.begin(f.action,f.state,{...first,sequence:3,kind:'restart-cleared'}));
 send(f,'confirm-old',stopped,0);const bad=structuredClone(f.state);bad.events[1].ack.result.noFutureDispatch=true;assert.throws(()=>P.validate(f.action,bad,binding));
 const pending=P.begin(f.action,f.state,{...first,sequence:4,kind:'restart-cleared'});assert.throws(()=>P.completed(f.action,pending));assert.throws(()=>P.acknowledge(f.action,pending,{...pending.pending,result:{status:'RELEASED',mapSha256:'f'.repeat(64),proofSha256:hash}}));
});
test('same CID or prepared instead of effective environment cannot qualify a started replacement',()=>{
 const f=lab();send(f,'running',running);send(f,'confirm-old',stopped,0);send(f,'restart-cleared',{status:'RELEASED',mapSha256:f.action.before.mapSha256,proofSha256:hash});const request={...P.tuple(f.action),sequence:4,kind:'start-selected',index:0},state=P.begin(f.action,f.state,request),s=f.action.starts[0];
 const result={status:'STARTED',container:f.action.oldBindings[0].container,incarnation:'4'.repeat(32),nonce:'5'.repeat(32),ticketFileSha256:hash,configSha256:s.configSha256,environmentSha256:s.effectiveEnvironmentSha256};assert.throws(()=>P.acknowledge(f.action,state,{...request,result}));
 result.container={...result.container,cid:'9'.repeat(64)};result.environmentSha256='f'.repeat(64);assert.throws(()=>P.acknowledge(f.action,state,{...request,result}));
});
test('publication transcript requires actual authoritative candidate acknowledgment then new assignment start, warm and exact routes',()=>{
 const f=fixture('roster-step'),placement=require('../../../lib/realtime-placement'),candidate={...f.map,generation:2,workers:f.map.workers.map(w=>w.id==='a'?{...w,incarnation:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}:w),owners:['b','a'],transition:{previousGeneration:1,previousOwners:f.map.owners.map(worker=>({worker,incarnation:f.map.workers.find(w=>w.id===worker).incarnation})),stopped:[{worker:'a',incarnation:f.old.assignmentIncarnation}]}};
 f.context.candidateBytes=Buffer.from(JSON.stringify(candidate)+'\n');const parsed=placement.parse(candidate,{internal:f.internal,ownershipVersion:2}),start={...f.start,assignmentIncarnation:candidate.workers[0].incarnation,effectiveEnvironmentSha256:require('../realtime-recovery-worker-view').derive(f.templates[0],candidate.workers[0].incarnation,f.context.workerFiles[f.start.service]).environmentSha256};Object.assign(f.value,{oldBindings:[f.old],starts:[start],candidate:{generation:2,mapSha256:parsed.digest,mapFileSha256:A.rawSha(f.context.candidateBytes)},limits:{maxLogicalMoves:1,maxAssignmentChanges:2,maxAffectedTenants:10}});
 const x={action:A.normalize(f.value,f.context),state:P.create(binding)},matched={status:'MATCHED',generation:2,digest:parsed.digest,mapFileSha256:A.rawSha(f.context.candidateBytes)};send(x,'running',running);send(x,'confirm-old',stopped,0);send(x,'assignment-published',matched);
 assert.throws(()=>P.begin(x.action,x.state,{...P.tuple(x.action),sequence:4,kind:'routes-published'}),{code:'REALTIME_RECOVERY_PROTOCOL_PHASE'});
 send(x,'start-selected',{status:'STARTED',container:{...f.old.container,cid:'9'.repeat(64),startedAt:'new-synthetic-birth'},incarnation:'4'.repeat(32),nonce:'5'.repeat(32),ticketFileSha256:hash,configSha256:start.configSha256,environmentSha256:start.effectiveEnvironmentSha256},0);send(x,'warm-complete',{status:'READY',witnessSha256:hash});assert.throws(()=>P.completed(x.action,x.state),{code:'REALTIME_RECOVERY_PROTOCOL_INCOMPLETE'});
 const r={...P.tuple(x.action),sequence:x.state.sequence+1,kind:'routes-published'},pending=P.begin(x.action,x.state,r);assert.throws(()=>P.acknowledge(x.action,pending,{...r,result:{...matched,digest:'f'.repeat(64)}}));send(x,'routes-published',matched);assert.equal(P.completed(x.action,x.state),A.semantic(x.state));
});
