'use strict';
// Private filesystem/common-ledger source protocol. No Docker/PG/credentials.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const F=require('../connection-budget-files'),C=require('../control-recovery'),B=require('../connection-budget'),R=require('../realtime-recovery-roster'),A=require('../realtime-recovery-action'),J=require('../realtime-recovery-journal'),fixture=require('./realtime-recovery-action-fixture');
const{lab,selected}=require('./realtime-recovery-control-fixture');
function newModule(){const file=require.resolve('../realtime-recovery-journal'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(file,'utf8'),file);return m.exports;}
test('same actual lock + durable ISSUED readback/fsync precede exclusive per-lease action files; launch authorization is one-use',()=>{
 const f=lab();let issued,published;try{
  F.locked(f.root,fd=>{f.fd=fd;issued=selected(f);F.writeAt(fd,'ledger.json',f.book);
   const events=[],sync=fs.fsyncSync,mkdir=fs.mkdirSync;fs.fsyncSync=function(n){events.push('sync:'+fs.readlinkSync('/proc/self/fd/'+n));return sync.apply(this,arguments);};fs.mkdirSync=function(p){events.push('mkdir:'+p);return mkdir.apply(this,arguments);};
   try{published=J.publish(fd,issued.permit,f.value,f.context);}finally{fs.fsyncSync=sync;fs.mkdirSync=mkdir;}
   assert(events.findIndex(x=>x.endsWith('/ledger.json'))>=0);assert(events.findIndex(x=>x.endsWith('/ledger.json'))<events.findIndex(x=>x.startsWith('mkdir:')),'ISSUED_LEDGER_FSYNC_BEFORE_ACTION_PUBLICATION');
   const loaded=J.load(fd,f.plan,issued.row,f.context);assert.equal(loaded.phase.phase,'PLANNED');assert.equal(loaded.binding.actionSha256,A.semantic(loaded.action));assert(Object.isFrozen(loaded.binding.source));assert.throws(()=>J.publish(fd,issued.permit,f.value,f.context),{code:'REALTIME_RECOVERY_PERMIT'});
  });
  F.locked(f.root,fd=>{const ready=J.authorizeStart(fd,published.dispatchPermit,f.plan,f.book,f.context);assert.equal(ready.binding.actionSha256,published.binding.actionSha256);assert.equal(J.load(fd,f.plan,issued.row,f.context).phase.phase,'LAUNCH_AUTHORIZED');assert.throws(()=>J.authorizeStart(fd,published.dispatchPermit,f.plan,f.book,f.context),{code:'REALTIME_RECOVERY_DISPATCH_PERMIT'});});
 }finally{f.close();}
});
test('omitted, failed or reordered ledger save cannot publish an action; consumed permit never becomes retryable',()=>{
 for(const mode of ['omitted','failed','reordered']){const f=lab();try{F.locked(f.root,fd=>{f.fd=fd;const fresh=selected(f);
  if(mode==='failed'){const write=F.writeAt;F.writeAt=function(_fd,name){if(name==='ledger.json')throw Object.assign(Error('controlled I/O'),{code:'EIO'});return write.apply(this,arguments);};try{assert.throws(()=>F.writeAt(fd,'ledger.json',f.book),{code:'EIO'});}finally{F.writeAt=write;}}
  assert.throws(()=>J.publish(fd,fresh.permit,f.value,f.context),{code:'REALTIME_RECOVERY_LEDGER_NOT_SAVED'});assert.equal(fs.existsSync(path.join(f.root,'realtime-recovery-journal')),false);
  F.writeAt(fd,'ledger.json',f.book);assert.throws(()=>J.publish(fd,fresh.permit,f.value,f.context),{code:'REALTIME_RECOVERY_PERMIT'});
 });}finally{f.close();}}
});
test('lost process permit or a new lock session cannot reconstruct an existing ISSUED action',()=>{
 for(const mode of ['lost','new-lock']){const f=lab();let fresh;try{F.locked(f.root,fd=>{f.fd=fd;fresh=selected(f);F.writeAt(fd,'ledger.json',f.book);});
  F.locked(f.root,fd=>{assert.throws(()=> (mode==='lost'?newModule():J).publish(fd,fresh.permit,f.value,f.context),{code:mode==='lost'?'REALTIME_RECOVERY_PERMIT':'REALTIME_RECOVERY_LOCK_CHANGED'});assert.throws(()=>C.allocate(f.plan,f.book,{class:'realtime-recovery',intentSha256:fresh.row.intentSha256}),{code:'CONTROL_RECOVERY_ACTIVE'});});if(mode==='lost')J.abandon(fresh.permit);assert.equal(fs.existsSync(path.join(f.root,'realtime-recovery-journal')),false);
 }finally{f.close();}}
});
test('row mutation after allocation cannot change the private immutable lease snapshot',()=>{
 const f=lab();try{F.locked(f.root,fd=>{f.fd=fd;const fresh=selected(f);fresh.row.nonce='f'.repeat(32);f.value.nonce=fresh.row.nonce;F.writeAt(fd,'ledger.json',f.book);assert.throws(()=>J.publish(fd,fresh.permit,f.value,f.context),{code:'REALTIME_RECOVERY_ACTION_LEASE'});assert.equal(fs.existsSync(path.join(f.root,'realtime-recovery-journal')),false);});}finally{f.close();}
});
test('missing or changed immutable binding/action becomes sticky uncertainty, never a replacement action or launch',()=>{
 for(const file of ['action-binding.json','host-action.json']){const f=lab();try{F.locked(f.root,fd=>{f.fd=fd;const fresh=selected(f);F.writeAt(fd,'ledger.json',f.book);const made=J.publish(fd,fresh.permit,f.value,f.context),dir=path.join(f.root,'realtime-recovery-journal',fresh.row.incarnation),target=path.join(dir,file),raw=fs.readFileSync(target);fs.unlinkSync(target);
  assert.throws(()=>J.load(fd,f.plan,fresh.row,f.context));assert(fs.existsSync(path.join(dir,'uncertain.json')));fs.writeFileSync(target,raw,{mode:0o600});assert.throws(()=>J.load(fd,f.plan,fresh.row,f.context),{code:'REALTIME_RECOVERY_ACTION_UNCERTAIN'});assert.throws(()=>J.authorizeStart(fd,made.dispatchPermit,f.plan,f.book,f.context));assert.throws(()=>J.publish(fd,fresh.permit,f.value,f.context),{code:'REALTIME_RECOVERY_PERMIT'});
 });}finally{f.close();}}
});
test('failed exact ledger fsync blocks every action file; partial action publication retains sticky uncertainty',()=>{
 for(const mode of ['ledger-fsync','partial-publication']){const f=lab();try{F.locked(f.root,fd=>{f.fd=fd;const fresh=selected(f);F.writeAt(fd,'ledger.json',f.book);const sync=fs.fsyncSync,write=F.writeAt;
  if(mode==='ledger-fsync')fs.fsyncSync=function(n){if(fs.readlinkSync('/proc/self/fd/'+n).endsWith('/ledger.json'))throw Object.assign(Error('controlled I/O'),{code:'EIO'});return sync.apply(this,arguments);};
  else F.writeAt=function(n,name){if(name==='host-action.json')throw Object.assign(Error('controlled I/O'),{code:'EIO'});return write.apply(this,arguments);};
  try{assert.throws(()=>J.publish(fd,fresh.permit,f.value,f.context),{code:'EIO'});}finally{fs.fsyncSync=sync;F.writeAt=write;}
  if(mode==='ledger-fsync')assert.equal(fs.existsSync(path.join(f.root,'realtime-recovery-journal')),false);
  else{const dir=path.join(f.root,'realtime-recovery-journal',fresh.row.incarnation);assert.equal(F.read(path.join(dir,'uncertain.json')).reason,'ACTION_PUBLICATION_FAILED');assert.throws(()=>J.load(fd,f.plan,fresh.row,f.context),{code:'REALTIME_RECOVERY_ACTION_UNCERTAIN'});}
  assert.throws(()=>J.publish(fd,fresh.permit,f.value,f.context),{code:'REALTIME_RECOVERY_PERMIT'});
 });}finally{f.close();}}
});
test('unresolved RT action blocks a newly derived mutation while a separately debited inspection remains possible',()=>{
 const f=lab();try{F.locked(f.root,fd=>{f.fd=fd;const fresh=selected(f);J.abandon(fresh.permit);C.bound(f.plan,f.book,fresh.row,{...f.expected,cid:'9'.repeat(64),startedAt:'synthetic-control-birth',service:'realtime-recovery'},f.expected);C.uncertain(f.plan,f.book,fresh.row);C.stopped(f.plan,f.book,fresh.row,{container:fresh.row.container,resourceEpoch:['123','synthetic-epoch'],noFutureDispatch:true});F.writeAt(fd,'ledger.json',f.book);
  assert.throws(()=>J.allocate(fd,f.plan,f.book,f.context.intent),{code:'REALTIME_RECOVERY_PRIOR_UNCERTAIN'});const inspect=J.allocate(fd,f.plan,f.book,{version:1,command:'inspect'});assert.equal(inspect.row.state,'ISSUED');assert.equal(fresh.row.state,'UNKNOWN');J.abandon(inspect.permit);
 });}finally{f.close();}
});
test('a plausible old physical CID not present in the actual admitted worker ledger cannot be action-bound',()=>{
 const f=lab();try{F.locked(f.root,fd=>{f.fd=fd;const fresh=selected(f);F.writeAt(fd,'ledger.json',f.book);f.value.oldBindings[0].container.cid='8'.repeat(64);assert.throws(()=>J.publish(fd,fresh.permit,f.value,f.context),{code:'REALTIME_RECOVERY_OLD_NOT_ADMITTED'});assert.equal(fs.existsSync(path.join(f.root,'realtime-recovery-journal')),false);assert.throws(()=>J.publish(fd,fresh.permit,f.value,f.context),{code:'REALTIME_RECOVERY_PERMIT'});});}finally{f.close();}
});
test('consumed publication permit refuses before any repeated ledger fsync or journal work',()=>{
 const f=lab();try{F.locked(f.root,fd=>{f.fd=fd;const fresh=selected(f);F.writeAt(fd,'ledger.json',f.book);J.publish(fd,fresh.permit,f.value,f.context);const sync=fs.fsyncSync;let repeatedLedgerSyncs=0;fs.fsyncSync=function(n){if(fs.readlinkSync('/proc/self/fd/'+n).endsWith('/ledger.json'))repeatedLedgerSyncs++;return sync.apply(this,arguments);};
 try{assert.throws(()=>J.publish(fd,fresh.permit,f.value,f.context));}finally{fs.fsyncSync=sync;}assert.equal(repeatedLedgerSyncs,0,'CONSUMED_PERMIT_MUST_NOT_REENTER_LEDGER_OR_JOURNAL');
 });}finally{f.close();}
});
