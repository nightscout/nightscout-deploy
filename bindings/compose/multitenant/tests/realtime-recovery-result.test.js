'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),A=require('../realtime-recovery-action'),J=require('../realtime-recovery-journal'),F=require('../connection-budget-files'),P=require('../realtime-recovery-protocol'),Proof=require('../realtime-recovery-proof'),{lab,selected}=require('./realtime-recovery-control-fixture'),{execution,bytes}=require('./realtime-recovery-execution-fixture');
function ready(f,fd){
 f.value.kind='no-op';f.value.oldBindings=[];f.value.starts=[];f.value.limits={maxLogicalMoves:0,maxAssignmentChanges:0,maxAffectedTenants:0};f.fd=fd;const fresh=selected(f);F.writeAt(fd,'ledger.json',f.book);const e=execution(f,fd,fresh),proof=Proof.verify(e.input,e.view.action,e.view.binding),claimBytes=bytes(proof.claim),hashes=Proof.claim(claimBytes,proof);
 const message={...P.tuple(e.view.action),sequence:1,kind:'running'},start=J.beginMessage(fd,f.plan,f.book,fresh.row,f.context,message);J.acknowledge(fd,start.permit,f.plan,f.book,fresh.row,f.context,{...message,result:{status:'BOUND',...hashes}},{execution:e.input,claimBytes});
 const view=J.load(fd,f.plan,fresh.row,f.context),result={version:1,actionSha256:A.semantic(view.action),bindingSha256:A.semantic(view.binding),transcriptSha256:A.semantic(view.phase),...hashes,status:'COMPLETED',error:null,work:null};
 const receipt={version:2,kind:'controlled-operation-complete',class:fresh.row.class,incarnation:fresh.row.incarnation,nonce:fresh.row.nonce,planSha256:f.plan.sha256,source:f.plan.source,intentSha256:fresh.row.intentSha256,container:fresh.row.container,outcome:'COMPLETED',result,quiescence:{processInstanceId:fresh.row.class,incarnation:fresh.row.incarnation,nonce:fresh.row.nonce,planSha256:f.plan.sha256,source:f.plan.source,constructorsFrozen:true,pendingConnects:0,liveConnections:0,unconfirmedCleanup:false,cleanShutdown:true,tags:fresh.row.tags}};
 const observation={resource:{pgResourceId:'synthetic-pg',systemIdentifier:'123',postmasterStartedAt:'synthetic-epoch',serverMaximum:20,superuserReserved:3,otherReserved:0,unmanagedClients:0,bootstrapClosed:true},tags:fresh.row.tags.map(applicationName=>({applicationName,count:0}))};
 return{fresh,e,view,receipt,args:{receiptBytes:bytes(receipt),execution:e.input,claimBytes,actual:fresh.row.container,observation}};
}
test('fixed semantic close checks current journal/actual common execution/raw claim/result BEFORE generic credit close',()=>{
 const f=lab();try{F.locked(f.root,fd=>{const r=ready(f,fd);J.close(fd,f.plan,f.book,r.fresh.row,f.context,r.args);assert.equal(r.fresh.row.state,'CLOSED');assert.equal(F.readAt(fd,'ledger.json').controlLeases[0].state,'CLOSED');});}finally{f.close();}
});
test('swapped action/claim/transcript, unproved physical EOF, nonzero own tag or changed PG epoch cannot close',()=>{
 for(const mode of ['action','claim','transcript','receipt-claim','uncertain','tag','epoch']){const f=lab();try{F.locked(f.root,fd=>{const r=ready(f,fd);
  if(mode==='action')r.receipt.result.actionSha256='f'.repeat(64);if(mode==='transcript')r.receipt.result.transcriptSha256='f'.repeat(64);if(mode==='receipt-claim')r.receipt.result.claimFileSha256='f'.repeat(64);if(mode==='claim')r.args.claimBytes=bytes({...JSON.parse(r.args.claimBytes),nonce:'f'.repeat(32)});if(mode==='uncertain')r.receipt.quiescence.unconfirmedCleanup=true;if(mode==='tag')r.args.observation.tags[0].count=1;if(mode==='epoch')r.args.observation.resource.postmasterStartedAt='different';r.args.receiptBytes=bytes(r.receipt);
  assert.throws(()=>J.close(fd,f.plan,f.book,r.fresh.row,f.context,r.args));assert.equal(r.fresh.row.state,'UNKNOWN');assert.equal(F.readAt(fd,'ledger.json').controlLeases[0].state,'UNKNOWN');
 });}finally{f.close();}}
});
test('pending milestone is durable before dispatch; mismatched ack poisons lease and cannot be replayed',()=>{
 const f=lab();try{F.locked(f.root,fd=>{f.fd=fd;const fresh=selected(f);F.writeAt(fd,'ledger.json',f.book);const e=execution(f,fd,fresh),message={...P.tuple(e.view.action),sequence:1,kind:'running'},start=J.beginMessage(fd,f.plan,f.book,fresh.row,f.context,message);
 const phase=F.read(require('node:path').join(f.root,'realtime-recovery-journal',fresh.row.incarnation,'phase.json'));assert.deepEqual(phase.pending,message);assert.equal(phase.events.length,0);
 assert.throws(()=>J.acknowledge(fd,start.permit,f.plan,f.book,fresh.row,f.context,{...message,nonce:'f'.repeat(32),result:{status:'BOUND',ticketFileSha256:'1'.repeat(64),gateFileSha256:'2'.repeat(64),claimFileSha256:'3'.repeat(64)}}),{code:'REALTIME_RECOVERY_PROTOCOL_ACK'});assert.equal(fresh.row.state,'UNKNOWN');assert.throws(()=>J.beginMessage(fd,f.plan,f.book,fresh.row,f.context,message));
 });}finally{f.close();}
});
test('expired real monotonic channel refuses before a milestone effect and keeps charged UNKNOWN, never rearm',()=>{
 const f=lab();try{F.locked(f.root,fd=>{f.context.execution.timeoutMs=1;f.fd=fd;const fresh=selected(f);F.writeAt(fd,'ledger.json',f.book);const e=execution(f,fd,fresh),end=process.hrtime.bigint()+3000000n;while(process.hrtime.bigint()<end){}let effects=0;
 assert.throws(()=>{J.beginMessage(fd,f.plan,f.book,fresh.row,f.context,{...P.tuple(e.view.action),sequence:1,kind:'running'});effects++;},{code:'REALTIME_RECOVERY_DEADLINE'});assert.equal(effects,0);assert.equal(fresh.row.state,'UNKNOWN');assert.equal(F.readAt(fd,'ledger.json').controlLeases[0].state,'UNKNOWN');
 });}finally{f.close();}
});
test('rollback to an otherwise valid earlier journal phase cannot replay a milestone in the same execution',()=>{
 const f=lab();try{F.locked(f.root,fd=>{const r=ready(f,fd),target=require('node:path').join(f.root,'realtime-recovery-journal',r.fresh.row.incarnation,'phase.json');F.write(target,P.create(A.semantic(r.view.binding)));
 assert.throws(()=>J.beginMessage(fd,f.plan,f.book,r.fresh.row,f.context,{...P.tuple(r.view.action),sequence:1,kind:'running'}),{code:'REALTIME_RECOVERY_JOURNAL_REPLAY'});assert.equal(r.fresh.row.state,'UNKNOWN');
 });}finally{f.close();}
});
test('uncertainty stays sticky in-process even when persisting UNKNOWN fails and caller reloads old BOUND ledger',()=>{
 const f=lab();try{F.locked(f.root,fd=>{const r=ready(f,fd),write=F.writeAt;r.receipt.result.actionSha256='f'.repeat(64);r.args.receiptBytes=bytes(r.receipt);F.writeAt=function(n,name){if(name==='ledger.json')throw Object.assign(Error('controlled disk failure'),{code:'EIO'});return write.apply(this,arguments);};
 try{assert.throws(()=>J.close(fd,f.plan,f.book,r.fresh.row,f.context,r.args),error=>error.code==='REALTIME_RECOVERY_RESULT'&&error.uncertaintyPersistenceError?.code==='EIO');}finally{F.writeAt=write;}
 const reloaded=F.readAt(fd,'ledger.json'),row=reloaded.controlLeases[0];assert.equal(row.state,'BOUND');assert.throws(()=>J.close(fd,f.plan,reloaded,row,f.context,r.args),{code:'REALTIME_RECOVERY_CHANNEL_LOST'});assert.equal(row.state,'UNKNOWN');assert.equal(F.readAt(fd,'ledger.json').controlLeases[0].state,'UNKNOWN');
 });}finally{f.close();}
});
test('start acknowledgment must match the actual saved worker generation AND exact current raw physical2 ticket',()=>{
 const B=require('../connection-budget'),fs=require('node:fs'),path=require('node:path');
 for(const mode of ['missing-generation','wrong-nonce','wrong-ticket','matched']){const f=lab();try{F.locked(f.root,fd=>{f.fd=fd;const fresh=selected(f);F.writeAt(fd,'ledger.json',f.book);const e=execution(f,fd,fresh),proof=Proof.verify(e.input,e.view.action,e.view.binding),claimBytes=bytes(proof.claim),hashes=Proof.claim(claimBytes,proof);let seq=0;
 const send=(kind,result,index)=>{const request={...P.tuple(e.view.action),sequence:++seq,kind,...(index===undefined?{}:{index})},permit=J.beginMessage(fd,f.plan,f.book,fresh.row,f.context,request).permit;J.acknowledge(fd,permit,f.plan,f.book,fresh.row,f.context,{...request,result},kind==='running'?{execution:e.input,claimBytes}:undefined);};
 send('running',{status:'BOUND',...hashes});send('confirm-old',{status:'STOPPED',noFutureDispatch:true,observationSha256:'1'.repeat(64)},0);send('restart-cleared',{status:'RELEASED',mapSha256:e.view.action.before.mapSha256,proofSha256:'2'.repeat(64)});
 const start=e.view.action.starts[0],container={...f.old.container,cid:'8'.repeat(64),startedAt:'new-worker-birth'},request={...P.tuple(e.view.action),sequence:++seq,kind:'start-selected',index:0},permit=J.beginMessage(fd,f.plan,f.book,fresh.row,f.context,request).permit;
 let ticket={incarnation:'4'.repeat(32),nonce:'5'.repeat(32)};
 if(mode!=='missing-generation'){ticket=B.generation(f.plan,f.book,start.slotId,{pgResourceId:'synthetic-pg',systemIdentifier:'123',postmasterStartedAt:'synthetic-epoch',serverMaximum:20,superuserReserved:3,otherReserved:0,unmanagedClients:0,bootstrapClosed:true});B.recordStarted(f.plan,f.book,start.slotId,ticket.incarnation,container);F.write(path.join(f.root,start.slotId,'ticket.json'),mode==='wrong-ticket'?{...ticket,nonce:'f'.repeat(32)}:ticket);F.writeAt(fd,'ledger.json',f.book);}
 const result={status:'STARTED',container,incarnation:ticket.incarnation,nonce:mode==='wrong-nonce'?'f'.repeat(32):ticket.nonce,ticketFileSha256:A.rawSha(fs.readFileSync(path.join(f.root,start.slotId,'ticket.json'))),configSha256:start.configSha256,environmentSha256:start.effectiveEnvironmentSha256};
 const ack=()=>J.acknowledge(fd,permit,f.plan,f.book,fresh.row,f.context,{...request,result});
 if(mode==='matched'){ack();assert.equal(J.load(fd,f.plan,fresh.row,f.context).phase.phase,'RESTART_STARTED');assert.equal(fresh.row.state,'BOUND');assert.equal(f.book.slots[start.slotId].filter(r=>r.state==='ISSUED').length,2);}
 else{assert.throws(ack,{code:mode==='wrong-ticket'?'REALTIME_RECOVERY_START_TICKET':'REALTIME_RECOVERY_START_NOT_ADMITTED'});assert.equal(fresh.row.state,'UNKNOWN');}
 });}finally{f.close();}}
});
test('running cannot be acknowledged from plausible child hashes without the actual sealed common ticket/gate/RT claim proof',()=>{
 const f=lab();try{F.locked(f.root,fd=>{f.fd=fd;const fresh=selected(f);F.writeAt(fd,'ledger.json',f.book);const e=execution(f,fd,fresh),message={...P.tuple(e.view.action),sequence:1,kind:'running'},permit=J.beginMessage(fd,f.plan,f.book,fresh.row,f.context,message).permit;assert.throws(()=>J.acknowledge(fd,permit,f.plan,f.book,fresh.row,f.context,{...message,result:{status:'BOUND',ticketFileSha256:'1'.repeat(64),gateFileSha256:'2'.repeat(64),claimFileSha256:'3'.repeat(64)}}),{code:'REALTIME_RECOVERY_RUNNING_EVIDENCE'});assert.equal(fresh.row.state,'UNKNOWN');});}finally{f.close();}
});
