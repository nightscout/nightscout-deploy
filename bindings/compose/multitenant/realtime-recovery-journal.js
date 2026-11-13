'use strict';
// Class-owned durable action identity. Common C is the only credit allocator.
// All methods are synchronous under the existing common controller lock. No
// descriptor here performs a Docker/SQL/worker effect or closes physical credit.
const fs=require('node:fs'),path=require('node:path'),{isDeepStrictEqual:equal}=require('node:util');
const F=require('./connection-budget-files'),C=require('./control-recovery'),B=require('./connection-budget'),A=require('./realtime-recovery-action'),P=require('./realtime-recovery-protocol');
const channels=new Map(),permits=new WeakMap(),dispatches=new WeakMap(),NAME='realtime-recovery',ROOT='realtime-recovery-journal';
const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
const frozen=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&equal(Object.keys(v).sort(),[...keys].sort());
function rawAt(fd,name){
 const before=F.inspect(fd,name);need(before,'REALTIME_RECOVERY_JOURNAL_MISSING');const file=fs.openSync(F.location(fd,name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const s=fs.fstatSync(file);need(s.isFile()&&s.nlink===1&&s.size<=1048576&&!(s.mode&0o077)&&[process.getuid(),1000].includes(s.uid)&&s.dev===before[0]&&s.ino===before[1],'REALTIME_RECOVERY_JOURNAL_CUSTODY');const bytes=Buffer.alloc(s.size+1);let used=0;while(used<bytes.length){const n=fs.readSync(file,bytes,used,bytes.length-used,null);if(!n)break;used+=n;}const raw=bytes.subarray(0,used);need(used===s.size&&equal(F.inspect(fd,name),before),'REALTIME_RECOVERY_JOURNAL_CHANGED');return raw;}finally{fs.closeSync(file);}
}
function jsonAt(fd,name){return JSON.parse(rawAt(fd,name).toString('utf8'));}
function session(fd){
 const root=fs.readlinkSync('/proc/self/fd/'+fd),checked=F.directory(root);try{const a=fs.fstatSync(fd),b=fs.fstatSync(checked);need(a.dev===b.dev&&a.ino===b.ino,'REALTIME_RECOVERY_LOCK');}finally{fs.closeSync(checked);}
 need(F.readAt(fd,'controller.lock')===process.pid,'REALTIME_RECOVERY_LOCK');
 const lock=fs.openSync(F.location(fd,'controller.lock'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),s=fs.fstatSync(lock),seen=F.inspect(fd,'controller.lock');
 try{need(s.isFile()&&s.nlink===1&&seen&&s.dev===seen[0]&&s.ino===seen[1],'REALTIME_RECOVERY_LOCK');return{root,lock,dev:s.dev,ino:s.ino};}catch(error){fs.closeSync(lock);throw error;}
}
function sameSession(fd,token){const current=session(fd);try{need(current.root===token.root&&current.dev===token.dev&&current.ino===token.ino,'REALTIME_RECOVERY_LOCK_CHANGED');}finally{fs.closeSync(current.lock);}}
function actualBook(fd,plan,book){need(equal(jsonAt(fd,'plan.json'),plan),'REALTIME_RECOVERY_PLAN_CHANGED');const actual=jsonAt(fd,'ledger.json');C.validate(plan,actual);need(equal(actual,book),'REALTIME_RECOVERY_LEDGER_NOT_SAVED');return actual;}
function allocate(fd,plan,book,value){
 const held=session(fd);try{
  actualBook(fd,plan,book);const intent=C.intent(NAME,value);need(intent.command==='inspect'||!book.controlLeases.some(row=>row.class===NAME&&row.state==='UNKNOWN'),'REALTIME_RECOVERY_PRIOR_UNCERTAIN');const row=C.allocate(plan,book,{class:NAME,intentSha256:B.hash(intent)}),permit=Object.freeze({});
  permits.set(permit,{...held,plan:structuredClone(plan),book:structuredClone(book),row:structuredClone(row),intent});return Object.freeze({row,permit});
 }catch(error){fs.closeSync(held.lock);throw error;}
}
function abandon(permit){const saved=permits.get(permit);need(saved,'REALTIME_RECOVERY_PERMIT');permits.delete(permit);fs.closeSync(saved.lock);}
function openLease(fd,incarnation,create){
 need(typeof incarnation==='string'&&/^[a-f0-9]{32}$/.test(incarnation),'REALTIME_RECOVERY_JOURNAL_LEASE');
 if(create){try{fs.mkdirSync(F.location(fd,ROOT),{mode:0o700});fs.fsyncSync(fd);}catch(error){if(error.code!=='EEXIST')throw error;}}
 const root=F.directory(path.join(fs.readlinkSync('/proc/self/fd/'+fd),ROOT));
 try{if(create){try{fs.mkdirSync(F.location(root,incarnation),{mode:0o700});fs.fsyncSync(root);}catch(error){if(error.code==='EEXIST')throw Object.assign(Error('REALTIME_RECOVERY_ACTION_ALREADY_BOUND'),{code:'REALTIME_RECOVERY_ACTION_ALREADY_BOUND'});throw error;}}
  return F.directory(path.join(fs.readlinkSync('/proc/self/fd/'+root),incarnation));
 }finally{fs.closeSync(root);}
}
function durableIssued(fd,saved){
 const book=actualBook(fd,saved.plan,saved.book),row=book.controlLeases.find(r=>r.incarnation===saved.row.incarnation);
 need(row?.state==='ISSUED'&&equal(row,saved.row),'REALTIME_RECOVERY_LEDGER_NOT_SAVED');
 // Readback alone is not fsync proof. Sync that exact existing inode ourselves,
 // under the same held lock, BEFORE permit consumption can publish any action.
 const before=F.inspect(fd,'ledger.json'),file=fs.openSync(F.location(fd,'ledger.json'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const s=fs.fstatSync(file);need(s.isFile()&&s.nlink===1&&before&&s.dev===before[0]&&s.ino===before[1]&&s.size<=1048576&&equal(jsonAt(fd,'ledger.json'),book),'REALTIME_RECOVERY_LEDGER_CHANGED');fs.fsyncSync(file);fs.fsyncSync(fd);need(equal(F.inspect(fd,'ledger.json'),before),'REALTIME_RECOVERY_LEDGER_CHANGED');}finally{fs.closeSync(file);}
}
function publish(fd,permit,value,context){
 const saved=permits.get(permit);need(saved,'REALTIME_RECOVERY_PERMIT');permits.delete(permit);let journalDirectory=null;
 try{
  sameSession(fd,saved);const action=A.normalize(value,{...context,plan:saved.plan,intent:saved.intent});
  need(action.class===NAME&&action.leaseIncarnation===saved.row.incarnation&&action.nonce===saved.row.nonce&&action.intentSha256===saved.row.intentSha256,'REALTIME_RECOVERY_ACTION_LEASE');
  durableIssued(fd,saved);
  need(action.oldBindings.every(old=>saved.book.slots[old.service]?.some(row=>row.container&&equal(row.container,old.container))),'REALTIME_RECOVERY_OLD_NOT_ADMITTED');
  const encoded=A.envelope(action),binding={version:1,class:NAME,leaseIncarnation:saved.row.incarnation,nonce:saved.row.nonce,source:saved.plan.source,planSha256:saved.plan.sha256,resourceEpoch:[saved.plan.resource.systemIdentifier,saved.plan.resource.postmasterStartedAt],intentSha256:saved.row.intentSha256,actionId:action.actionId,actionSha256:encoded.actionSha256,actionFileSha256:encoded.actionFileSha256};
  const journal=openLease(fd,saved.row.incarnation,true);journalDirectory=fs.readlinkSync('/proc/self/fd/'+journal);
  try{
   F.writeAt(journal,'action-binding.json',binding,{exclusive:true});F.writeAt(journal,'host-action.json',encoded.envelope,{exclusive:true});
   need(A.rawSha(rawAt(journal,'host-action.json'))===binding.actionFileSha256,'REALTIME_RECOVERY_ACTION_FILE');
   const bindingSha256=A.semantic(binding);F.writeAt(journal,'phase.json',{version:1,bindingSha256,phase:'PLANNED',sequence:0,events:[],pending:null},{exclusive:true});
   const dispatchPermit=Object.freeze({});dispatches.set(dispatchPermit,{incarnation:saved.row.incarnation,nonce:saved.row.nonce,bindingSha256,planSha256:saved.plan.sha256});
   return Object.freeze({dispatchPermit,binding:frozen(binding),bindingSha256,files:Object.freeze({'action-binding.json':A.rawSha(rawAt(journal,'action-binding.json')),'host-action.json':binding.actionFileSha256})});
  }finally{fs.closeSync(journal);}
 }catch(error){
  if(journalDirectory){let failed;try{failed=F.directory(journalDirectory);if(F.inspect(failed,'uncertain.json')===null)F.writeAt(failed,'uncertain.json',{version:1,class:NAME,incarnation:saved.row.incarnation,nonce:saved.row.nonce,planSha256:saved.plan.sha256,reason:'ACTION_PUBLICATION_FAILED'},{exclusive:true});}catch(persist){if(Object.isExtensible(error))error.uncertaintyPersistenceError=persist;}finally{if(failed!==undefined)fs.closeSync(failed);}}
  throw error;
 }finally{fs.closeSync(saved.lock);}
}
function load(fd,plan,row,context){
 const held=session(fd);fs.closeSync(held.lock);const book=jsonAt(fd,'ledger.json');C.validate(plan,book);need(equal(jsonAt(fd,'plan.json'),plan)&&row.class===NAME&&book.controlLeases.some(r=>equal(r,row)),'REALTIME_RECOVERY_JOURNAL_LEASE');
 const journal=openLease(fd,row.incarnation,false);
 try{
  need(F.inspect(journal,'uncertain.json')===null,'REALTIME_RECOVERY_ACTION_UNCERTAIN');
  const binding=jsonAt(journal,'action-binding.json');need(exact(binding,['version','class','leaseIncarnation','nonce','source','planSha256','resourceEpoch','intentSha256','actionId','actionSha256','actionFileSha256'])&&binding.version===1&&binding.class===NAME&&binding.leaseIncarnation===row.incarnation&&binding.nonce===row.nonce&&binding.intentSha256===row.intentSha256&&binding.planSha256===plan.sha256&&equal(binding.source,plan.source)&&equal(binding.resourceEpoch,[plan.resource.systemIdentifier,plan.resource.postmasterStartedAt]),'REALTIME_RECOVERY_ACTION_BINDING');
  const read=A.read(rawAt(journal,'host-action.json'),{...context,plan});need(read.actionSha256===binding.actionSha256&&read.actionFileSha256===binding.actionFileSha256&&read.action.actionId===binding.actionId&&read.action.leaseIncarnation===row.incarnation&&read.action.nonce===row.nonce,'REALTIME_RECOVERY_ACTION_BINDING');
  const phase=jsonAt(journal,'phase.json');P.validate(read.action,phase,A.semantic(binding));
  return Object.freeze({binding:frozen(binding),phase:frozen(phase),action:read.action,files:Object.freeze({'action-binding.json':A.rawSha(rawAt(journal,'action-binding.json')),'host-action.json':binding.actionFileSha256})});
 }catch(error){
  try{if(F.inspect(journal,'uncertain.json')===null)F.writeAt(journal,'uncertain.json',{version:1,class:NAME,incarnation:row.incarnation,nonce:row.nonce,planSha256:plan.sha256,reason:'JOURNAL_OR_BINDING_MISMATCH'},{exclusive:true});}
  catch(persist){if(Object.isExtensible(error))error.uncertaintyPersistenceError=persist;}
  throw error;
 }finally{fs.closeSync(journal);}
}
function authorizeStart(fd,permit,plan,book,context){
 const saved=dispatches.get(permit);need(saved,'REALTIME_RECOVERY_DISPATCH_PERMIT');dispatches.delete(permit);
 const held=session(fd);fs.closeSync(held.lock);
 const row=book.controlLeases.find(r=>r.incarnation===saved.incarnation);actualBook(fd,plan,book);
 need(row?.state==='ISSUED'&&row.nonce===saved.nonce&&plan.sha256===saved.planSha256,'REALTIME_RECOVERY_DISPATCH_LEASE');
 const view=load(fd,plan,row,context);need(view.phase.phase==='PLANNED'&&view.phase.sequence===0&&view.phase.events.length===0&&view.phase.pending===null&&A.semantic(view.binding)===saved.bindingSha256,'REALTIME_RECOVERY_DISPATCH_PHASE');
 const journal=openLease(fd,row.incarnation,false);try{F.writeAt(journal,'phase.json',P.create(A.semantic(view.binding)));}finally{fs.closeSync(journal);}
 need(Number.isSafeInteger(context.execution?.timeoutMs)&&context.execution.timeoutMs>=1&&context.execution.timeoutMs<=900000,'REALTIME_RECOVERY_DEADLINE_REQUIRED');channels.set(row.incarnation,{nonce:row.nonce,phaseSha256:A.semantic(P.create(A.semantic(view.binding))),deadline:process.hrtime.bigint()+BigInt(context.execution.timeoutMs)*1000000n});
 return Object.freeze({binding:view.binding,files:view.files,action:view.action});
}

const effects=new WeakMap();
function deadline(row){const channel=channels.get(row.incarnation);need(channel&&channel.nonce===row.nonce,'REALTIME_RECOVERY_CHANNEL_LOST');need(process.hrtime.bigint()<channel.deadline,'REALTIME_RECOVERY_DEADLINE');return channel;}
function currentPhase(row,phase){need(deadline(row).phaseSha256===A.semantic(phase),'REALTIME_RECOVERY_JOURNAL_REPLAY');}
function nextPhase(row,phase){deadline(row).phaseSha256=A.semantic(phase);}
function uncertain(fd,plan,book,row,reason){
 need(['HOST_FAILURE','MESSAGE_FAILURE','DEADLINE','RECEIPT_FAILURE'].includes(reason),'REALTIME_RECOVERY_UNCERTAIN_REASON');channels.delete(row.incarnation);actualBook(fd,plan,book);need(book.controlLeases.includes(row)&&row.class===NAME&&['ISSUED','BOUND','UNKNOWN'].includes(row.state),'REALTIME_RECOVERY_UNCERTAIN_LEASE');
 if(row.state!=='UNKNOWN'){C.uncertain(plan,book,row);F.writeAt(fd,'ledger.json',book);}channels.delete(row.incarnation);
 let journal;try{journal=openLease(fd,row.incarnation,false);if(F.inspect(journal,'uncertain.json')===null)F.writeAt(journal,'uncertain.json',{version:1,class:NAME,incarnation:row.incarnation,nonce:row.nonce,planSha256:plan.sha256,reason},{exclusive:true});}catch(error){if(error.code!=='ENOENT')throw error;}finally{if(journal!==undefined)fs.closeSync(journal);}
}
function guarded(fd,plan,book,row,reason,fn){try{return fn();}catch(error){try{uncertain(fd,plan,book,row,reason);}catch(persist){if(Object.isExtensible(error))error.uncertaintyPersistenceError=persist;}throw error;}}

function beginMessage(fd,plan,book,row,context,message){return guarded(fd,plan,book,row,'MESSAGE_FAILURE',()=>{
 deadline(row);
 actualBook(fd,plan,book);need(row.state==='BOUND'&&book.controlLeases.includes(row),'REALTIME_RECOVERY_MESSAGE_LEASE');
 const view=load(fd,plan,row,context);currentPhase(row,view.phase);const next=P.begin(view.action,view.phase,message),journal=openLease(fd,row.incarnation,false);
 try{nextPhase(row,next);F.writeAt(journal,'phase.json',next);}finally{fs.closeSync(journal);}
 const permit=Object.freeze({});effects.set(permit,{row:structuredClone(row),bindingSha256:A.semantic(view.binding),pending:next.pending});
 deadline(row);return Object.freeze({permit,action:view.action,request:Object.freeze(structuredClone(next.pending))});
 });}
function acknowledge(fd,permit,plan,book,row,context,ack,evidence){return guarded(fd,plan,book,row,'MESSAGE_FAILURE',()=>{
 deadline(row);
 const saved=effects.get(permit);need(saved,'REALTIME_RECOVERY_EFFECT_PERMIT');effects.delete(permit);actualBook(fd,plan,book);
 const view=load(fd,plan,row,context);currentPhase(row,view.phase);need(row.state==='BOUND'&&equal(saved.row,row)&&saved.bindingSha256===A.semantic(view.binding)&&equal(view.phase.pending,saved.pending),'REALTIME_RECOVERY_EFFECT_CHANGED');
 const next=P.acknowledge(view.action,view.phase,ack);
 if(ack.kind==='running'){
  need(evidence&&exact(evidence,['execution','claimBytes']),'REALTIME_RECOVERY_RUNNING_EVIDENCE');const proof=require('./realtime-recovery-proof').verify(evidence.execution,view.action,view.binding);
  need(equal(proof.ticket.workerDatabase,plan.workerDatabase)&&equal(proof.ticket.control.principal,row.principal)&&equal(proof.gate.container,row.container),'REALTIME_RECOVERY_RUNNING_EXECUTION');const hashes=require('./realtime-recovery-proof').claim(evidence.claimBytes,proof);need(equal({...hashes,status:'BOUND'},ack.result),'REALTIME_RECOVERY_RUNNING_CLAIM');
 }
 if(ack.kind==='start-selected'){
  const start=view.action.starts[ack.index],result=ack.result,generation=book.slots[start.slotId]?.find(r=>r.incarnation===result.incarnation);need(generation&&generation.state==='ISSUED'&&generation.retired===false&&generation.nonce===result.nonce&&equal(generation.container,result.container),'REALTIME_RECOVERY_START_NOT_ADMITTED');
  const worker=F.directory(path.join(fs.readlinkSync('/proc/self/fd/'+fd),start.slotId));try{const raw=rawAt(worker,'ticket.json'),ticket=JSON.parse(raw.toString('utf8')),slot=plan.slots.find(s=>s.processInstanceId===start.slotId);require('./physical-ticket-receiver').ticket(ticket);need(A.rawSha(raw)===result.ticketFileSha256&&equal(ticket,{version:2,workerDatabase:plan.workerDatabase,planSha256:plan.sha256,processInstanceId:start.slotId,incarnation:generation.incarnation,nonce:generation.nonce,source:plan.source,pgResourceId:plan.resource.pgResourceId,resourceAliases:plan.resource.aliases,capabilities:slot.capabilities,directGroups:slot.directGroups,cold:slot.cold}),'REALTIME_RECOVERY_START_TICKET');}finally{fs.closeSync(worker);}
 }
 const journal=openLease(fd,row.incarnation,false);try{nextPhase(row,next);F.writeAt(journal,'phase.json',next);}finally{fs.closeSync(journal);}deadline(row);return Object.freeze(structuredClone(next));
 });}

function close(fd,plan,book,row,context,{receiptBytes,execution,claimBytes,actual,observation}){return guarded(fd,plan,book,row,'RECEIPT_FAILURE',()=>{
 deadline(row);
 actualBook(fd,plan,book);need(row.state==='BOUND'&&book.controlLeases.includes(row),'REALTIME_RECOVERY_CLOSE_LEASE');
 const view=load(fd,plan,row,context);currentPhase(row,view.phase);const proof=require('./realtime-recovery-proof').verify(execution,view.action,view.binding);
 need(equal(proof.ticket.workerDatabase,plan.workerDatabase)&&equal(proof.ticket.control.principal,row.principal)&&equal(proof.gate.container,row.container),'REALTIME_RECOVERY_CLOSE_EXECUTION');
 const claim=require('./realtime-recovery-proof').claim(claimBytes,proof);
 need(Buffer.isBuffer(receiptBytes)&&receiptBytes.length>0&&receiptBytes.length<=65536,'REALTIME_RECOVERY_RECEIPT_BOUND');const receipt=JSON.parse(receiptBytes.toString('utf8'));
 require('./realtime-recovery-result').validate(view.action,view.binding,view.phase,receipt,claim);
 // No class caller may bypass the semantic proof above with generic C.close.
 // Common still checks actual quiescence/current resource and zero own tags.
 deadline(row);C.close(plan,book,row,receipt,actual,observation);F.writeAt(fd,'ledger.json',book);channels.delete(row.incarnation);return receipt;
 });}
module.exports=Object.freeze({allocate,abandon,publish,authorizeStart,load,beginMessage,acknowledge,close,uncertain});
