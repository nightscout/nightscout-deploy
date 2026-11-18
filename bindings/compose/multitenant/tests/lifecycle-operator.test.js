'use strict';
// Synthetic source/host ports only. No Docker, database, network or image build.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const B=require('../connection-budget'),F=require('../connection-budget-files'),O=require('../lifecycle-operator'),C=require('../connection-budget-controller'),E=require('../lifecycle-operator-entry');
const A='11111111-1111-4111-8111-111111111111',CLAIM='33333333-3333-4333-8333-333333333333';
function fixture({version=2,mutate,Controller=C}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'operator-protocol-'));fs.chmodSync(directory,0o700);
 const source={coreCommit:'a'.repeat(40),deployCommit:'b'.repeat(40)},resource={pgResourceId:'synthetic-pg',systemIdentifier:'123',postmasterStartedAt:'epoch',serverMaximum:100,reserved:{superuser:3,other:0},aliases:['postgres:5432'],allowances:{unmanaged:0,observers:2,controlRecovery:1,bootstrapOverlap:0,oldNewRolloutOverlap:0}};
 const body={version:1,kind:'controlled-connection-budget-plan',source,resource,slots:[],bootstrapSchedule:'EXPLICIT_OVERLAP',...(version===2?{lifecycleOperator:{version:1,tenants:[A],principal:{role:'synthetic_operator',roleOid:'31',database:'synthetic',databaseOid:'16384'},files:{},placement:false}}:{})};
 const plan={...body,sha256:B.hash(body)},expected={source,project:'synthetic',workingDirectory:'/private/synthetic',imageId:'sha256:'+'d'.repeat(64)};
 F.write(path.join(directory,'ledger.json'),O.ledger(plan),{exclusive:true});
 const resourceResult={pgResourceId:'synthetic-pg',systemIdentifier:'123',postmasterStartedAt:'epoch',serverMaximum:100,superuserReserved:3,otherReserved:0,unmanagedClients:0,bootstrapClosed:true};
 let ticket,receipt,container,failAt,known=[],trace=[];
 const book=()=>F.read(path.join(directory,'ledger.json'));
 const ports={inspect(){},start(){},stop(){},ticket(){},ack(){},observe(p,tags,managed){known=managed;trace.push('observe');return tags.length?{resource:resourceResult,tags:tags.map(applicationName=>({applicationName,count:0}))}:resourceResult;},
  operatorFiles(){trace.push('files');assert.equal(book().controlLeases.at(-1)?.state,'ISSUED','DEBIT_BEFORE_ANY_EFFECT');if(failAt==='files')throw Error('files');return{};},
  operatorTicket(t){trace.push('ticket');assert.equal(book().controlLeases.at(-1).state,'ISSUED');ticket=t;if(failAt==='ticket')throw Error('ticket');},
  operatorStart(){trace.push('start');if(failAt==='start')throw Error('start');container={...expected,service:O.NAME,cid:'c'.repeat(64),startedAt:'started',running:true};},
  operatorInspect(){return container;},
  operatorGate(t,c){trace.push('gate');assert.equal(book().controlLeases.at(-1).state,'BOUND','BOUND_BEFORE_GATE');assert.deepEqual(book().controlLeases.at(-1).container,c);if(failAt==='gate')throw Error('gate');},
  operatorWait(){trace.push('wait');assert(!fs.existsSync(path.join(directory,'controller.lock')),'NO_LOCK_OVER_WAIT');assert.throws(()=>controller.lifecycleOperator({version:1,command:'inspect',tenant:A}),/CREDIT_HELD/);if(failAt==='wait')throw Error('wait');container={...container,running:false,exitCode:0,oomKilled:false,runtimeError:''};const {running,exitCode,oomKilled,runtimeError,...bound}=container;
   receipt={version:1,kind:'lifecycle-operator-complete',incarnation:ticket.incarnation,nonce:ticket.nonce,planSha256:plan.sha256,source,intentSha256:ticket.operator.intentSha256,container:bound,outcome:'COMPLETED',result:{readOnly:true},quiescence:{processInstanceId:O.NAME,incarnation:ticket.incarnation,nonce:ticket.nonce,planSha256:plan.sha256,source,constructorsFrozen:true,pendingConnects:0,liveConnections:0,unconfirmedCleanup:false,cleanShutdown:true,tags:[O.tag(ticket.incarnation)]}};
   mutate?.({receipt,container,resourceResult,ticket});
  },operatorReceipt(){if(failAt==='receipt')throw Error('receipt');return receipt;}};
 const controller=Controller.create({directory,plan,expected,ports});
 return {directory,controller,plan,expected,ports,book,trace,get known(){return known;},set failAt(v){failAt=v;},request:{version:1,command:'inspect',tenant:A},cleanup(){fs.rmSync(directory,{recursive:true});}};
}
test('fresh v2 durable debit, bound gate, unlocked wait, exact physical retirement and reuse',()=>{const f=fixture();try{assert.equal(f.controller.lifecycleOperator(f.request).state,'CLOSED');assert.equal(f.book().controlLeases[0].state,'CLOSED');assert.deepEqual(f.trace.slice(0,5),['observe','files','ticket','start','gate']);assert.equal(f.controller.lifecycleOperator(f.request).state,'CLOSED');}finally{f.cleanup();}});
test('every publication/start/gate/wait/receipt crash retains UNKNOWN and blocks new dispatch',()=>{for(const boundary of ['files','ticket','start','gate','wait','receipt']){const f=fixture();try{f.failAt=boundary;assert.throws(()=>f.controller.lifecycleOperator(f.request));assert.equal(f.book().controlLeases[0].state,'UNKNOWN');const before=f.trace.filter(t=>t==='files').length;assert.throws(()=>f.controller.lifecycleOperator(f.request),/CREDIT_HELD/);assert.equal(f.trace.filter(t=>t==='files').length,before);}finally{f.cleanup();}}});
test('old ledger is refused; missing fresh ledger never infers zero credit',()=>{for(const mode of ['v1','missing']){const f=fixture();try{if(mode==='v1'){const b=f.book();b.version=1;delete b.controlLeases;F.write(path.join(f.directory,'ledger.json'),b);}else fs.unlinkSync(path.join(f.directory,'ledger.json'));assert.throws(()=>f.controller.lifecycleOperator(f.request),mode==='v1'?/LEDGER_VERSION/:/MISSING_FRESH_LEDGER/);assert(!f.trace.includes('files'));}finally{f.cleanup();}}});
test('strict intents reject arbitrary fields, tenant, malformed claim and worker substitutions before effects',()=>{for(const request of [{version:1,command:'query',tenant:A},{version:1,command:'inspect',tenant:A,sql:'SELECT 1'},{version:1,command:'resume',tenant:A},{version:1,command:'inspect',tenant:CLAIM},{version:1,command:'resume',tenant:A,claimId:'bad'}]){const f=fixture();try{assert.throws(()=>f.controller.lifecycleOperator(request));assert(!f.trace.includes('files'));}finally{f.cleanup();}}});
test('source/image/resource/nonce/intent/EOF/pending/forced-stop mismatch never refunds',()=>{
 for(const mode of ['source','image','system','nonce','intent','eof','pending','epoch','forced','unknown']){const f=fixture({mutate({receipt,container,resourceResult}){if(mode==='image')container.imageId='sha256:'+'e'.repeat(64);if(mode==='system')resourceResult.systemIdentifier='456';if(mode==='source')receipt.source={...receipt.source,coreCommit:'e'.repeat(40)};if(mode==='nonce')receipt.nonce='f'.repeat(32);if(mode==='intent')receipt.intentSha256='f'.repeat(64);if(mode==='eof')receipt.quiescence.unconfirmedCleanup=true;if(mode==='pending')receipt.quiescence.pendingConnects=1;if(mode==='epoch')resourceResult.postmasterStartedAt='new';if(mode==='forced')container.exitCode=137;if(mode==='unknown')receipt.outcome='OUTCOME_UNCERTAIN';}});try{assert.throws(()=>f.controller.lifecycleOperator(f.request));assert.equal(f.book().controlLeases[0].state,'UNKNOWN');}finally{f.cleanup();}}
});
test('observe uses only exact durable active control tag and separates physical occupancy',()=>{const f=fixture();try{f.failAt='wait';assert.throws(()=>f.controller.lifecycleOperator(f.request));const expected=f.book().controlLeases[0].tags;const observed=f.controller.observe();assert.deepEqual(f.known,expected);assert.deepEqual(observed.tags,expected.map(applicationName=>({applicationName,count:0})));assert.deepEqual(observed.occupancy,{workers:0,control:0});for(const tags of [[],['nscb:'+'f'.repeat(32)+':'+'f'.repeat(16)]]){const b=f.book();b.controlLeases[0].tags=tags;F.write(path.join(f.directory,'ledger.json'),b);assert.throws(()=>f.controller.observe(),/LEDGER/);}}finally{f.cleanup();}});
test('single acquisition, every SQL dispatch and late COMMIT reply are fenced',async()=>{let now=0,late=false,connects=0,queries=[];const client={release(){},query(...args){queries.push(args);return Promise.resolve({command:'COMMIT'});}};const pool=E.singlePool({async connect(){connects++;return client;}},{check(){if(now>=30)throw Error('DEADLINE');},late(){late=true;},async verify(){}});const c=await pool.connect();await assert.rejects(pool.connect(),/SECOND_CONNECT/);assert.equal(connects,1);const pending=c.query('COMMIT');now=31;await assert.rejects(pending,/DEADLINE/);assert(late);await assert.rejects(c.query('COMMIT'),/DEADLINE/);assert.equal(queries.length,1);});
test('semantic debit-order red control fails the same durable-before-effects oracle, restored passes',()=>{const filename=require.resolve('../connection-budget-controller'),source=fs.readFileSync(filename,'utf8'),changed=source.replace('const files=ports.operatorFiles(plan),ticket=',"book.controlLeases.pop();save();const files=ports.operatorFiles(plan),ticket=");assert.notEqual(changed,source);const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m._compile(changed,filename);const f=fixture();try{const c=m.exports.create({directory:f.directory,plan:f.plan,expected:f.expected,ports:f.ports});assert.throws(()=>c.lifecycleOperator(f.request),/DEBIT_BEFORE_ANY_EFFECT/);}finally{f.cleanup();}const restored=fixture();try{assert.equal(restored.controller.lifecycleOperator(restored.request).state,'CLOSED');}finally{restored.cleanup();}});

function mutatedModule(relative,transform,operator){const filename=require.resolve(relative),source=fs.readFileSync(filename,'utf8'),changed=transform(source);assert.notEqual(changed,source,'MUTATION_APPLIED');const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));const original=m.require.bind(m);if(operator)m.require=name=>name==='./lifecycle-operator'?operator:original(name);m._compile(changed,filename);return m.exports;}
test('semantic closure and managed-control-tag ablations fail exact safety oracles; restored succeeds',()=>{
 for(const mode of ['closure','tags']){
  const operator=mutatedModule('../lifecycle-operator',s=>mode==='closure'?s.replace('&&a.unconfirmedCleanup===false',''):s.replace("...(book.controlLeases||[]).filter(r=>r.state!=='CLOSED').flatMap(r=>r.tags)",''));
  const Controller=mutatedModule('../connection-budget-controller',s=>s+'\n// independent mutant fixture\n',operator);
  function oracle(implementation){const f=fixture({Controller:implementation,mutate({receipt}){if(mode==='closure')receipt.quiescence.unconfirmedCleanup=true;}});try{if(mode==='closure')assert.throws(()=>f.controller.lifecycleOperator(f.request));else{f.failAt='wait';assert.throws(()=>f.controller.lifecycleOperator(f.request));f.controller.observe();assert.deepEqual(f.known,f.book().controlLeases[0].tags,'EXACT_CONTROL_TAG_CENSUS');}}finally{f.cleanup();}}
  assert.throws(()=>oracle(Controller),mode==='closure'?/Missing expected exception/:/EXACT_CONTROL_TAG_CENSUS/);oracle(C);
 }
});
test('removing dispatch deadline fails no-late-COMMIT oracle, restored refuses before dispatch',async()=>{
 const mutant=mutatedModule('../lifecycle-operator-entry',s=>s.replace('try{check();}catch(error){return Promise.reject(error);}',''));
 async function oracle(entry){let expired=false,calls=0;const client={query(){calls++;return Promise.resolve({command:'COMMIT'});},release(){}};const p=entry.singlePool({async connect(){return client;}},{check(){if(expired)throw Error('DEADLINE');},late(){},async verify(){}});const c=await p.connect();expired=true;await assert.rejects(c.query('COMMIT'),/DEADLINE/);assert.equal(calls,0,'NO_LATE_COMMIT_DISPATCH');}
 await assert.rejects(oracle(mutant),/NO_LATE_COMMIT_DISPATCH/);await oracle(E);
});

test('removing single-connect guard fails no-replacement oracle; restored refuses',async()=>{const mutant=mutatedModule('../lifecycle-operator-entry',s=>s.replace("need(!acquired,'LIFECYCLE_OPERATOR_SECOND_CONNECT');",''));async function oracle(entry){let n=0;const client={query(){},release(){}};const p=entry.singlePool({async connect(){n++;return client;}},{check(){},late(){},async verify(){}});await p.connect();await assert.rejects(p.connect(),/SECOND_CONNECT/);assert.equal(n,1);}await assert.rejects(oracle(mutant),/Missing expected rejection/);await oracle(E);});

test('reads a retained clearance lease while refusing new clearance work',()=>{
 const f=fixture();
 try {
  const book=f.book(),legacy={...f.request,command:'clear-operations'};
  O.allocate(f.plan,book,f.request);
  const row=book.controlLeases[0];
  row.intent=legacy;row.intentSha256=B.hash(legacy);
  assert.equal(O.validate(f.plan,book),book);
  assert.throws(()=>O.allocate(f.plan,book,legacy),/LIFECYCLE_OPERATOR_INTENT/);
  assert.equal(book.controlLeases.length,1);
 } finally {f.cleanup();}
});
