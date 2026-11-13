'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const B=require('../connection-budget'),C=require('../control-recovery');
function fixture(impl=C){const source={coreCommit:'a'.repeat(40),deployCommit:'b'.repeat(40)},principal={role:'synthetic_operator',roleOid:'31',database:'synthetic',databaseOid:'16384'};
 const body={version:2,workerDatabase:{database:'synthetic',databaseOid:'16384'},lifecycleOperator:{version:2},source,slots:[],resource:{systemIdentifier:'123',postmasterStartedAt:'epoch',allowances:{controlRecovery:2}},controlRecovery:{version:1,classes:Object.fromEntries(C.CLASSES.map(c=>[c,{principal:{...principal,...(c==='restore-commissioner'?{role:'synthetic_ddl',roleOid:'32'}:{})}}]))}};
 const plan={...body,sha256:B.hash(body)},book=impl.ledger(plan),expected={source,project:'synthetic',workingDirectory:'/private/synthetic',imageId:'sha256:'+'d'.repeat(64)};
 const allocate=(c='lifecycle-operator')=>impl.allocate(plan,book,{class:c,intentSha256:'e'.repeat(64)});
 const bind=row=>impl.bound(plan,book,row,{...expected,cid:row.incarnation.repeat(2),startedAt:'started',service:row.class},expected);
 const stop=row=>impl.stopped(plan,book,row,{container:row.container,resourceEpoch:book.resourceEpoch,noFutureDispatch:true});
 return {plan,book,allocate,bind,stop};}
test('one shared active execution across fixed classes, not three independent pools',()=>{for(const c of C.CLASSES){const f=fixture();f.allocate(c);for(const other of C.CLASSES)assert.throws(()=>f.allocate(other),/ACTIVE/);}});
test('stopped UNKNOWN remains charged, mixed second execution debits, two UNKNOWN exhaust both credits',()=>{const f=fixture(),r=f.allocate();f.bind(r);C.uncertain(f.plan,f.book,r);assert.throws(()=>f.allocate('realtime-recovery'),/PREDECESSOR_LIVE/);f.stop(r);const next=f.allocate('realtime-recovery');assert.equal(r.state,'UNKNOWN');assert.equal(f.book.controlLeases.length,2);f.bind(next);C.uncertain(f.plan,f.book,next);f.stop(next);assert.throws(()=>f.allocate(),/CREDIT_HELD/);const tags=C.known(f.plan,f.book).map(applicationName=>({applicationName,count:0}));assert.deepEqual(C.occupancy(f.plan,f.book,tags),{physical:{workers:0,control:{'lifecycle-operator':0,'restore-commissioner':0,'realtime-recovery':0}},heldControlCredits:2,activeControlExecutions:0});assert.equal(r.state,'UNKNOWN','TAG_ZERO_NEVER_REFUNDS');});
test('uncertain commissioning terminal even with stopped proof; unbound UNKNOWN has no stop proof',()=>{for(const c of ['restore-commissioner','lifecycle-operator']){const f=fixture(),r=f.allocate(c);if(c==='restore-commissioner')f.bind(r);C.uncertain(f.plan,f.book,r);if(r.container)f.stop(r);else assert.throws(()=>f.stop(r),/STOPPED/);assert.throws(()=>f.allocate(),c==='restore-commissioner'?/SETUP_TERMINAL/:/PREDECESSOR_LIVE/);}});
test('exact class, principal OID, source, epoch, process and image custody; no caller exemption fields',()=>{for(const change of [r=>r.class='other',r=>r.tags=[],r=>r.principal.roleOid='99',r=>r.source.coreCommit='f'.repeat(40),r=>r.intentSha256='bad']){const f=fixture(),r=f.allocate();change(r);assert.throws(()=>C.validate(f.plan,f.book));}for(const change of [p=>p.resourceEpoch=['123','other'],p=>p.container={...p.container,service:'realtime-recovery'},p=>p.noFutureDispatch=false]){const f=fixture(),r=f.allocate();f.bind(r);C.uncertain(f.plan,f.book,r);const p={container:r.container,resourceEpoch:f.book.resourceEpoch,noFutureDispatch:true};change(p);assert.throws(()=>C.stopped(f.plan,f.book,r,p),/STOPPED/);}const f=fixture();assert.throws(()=>C.allocate(f.plan,f.book,{class:'lifecycle-operator',intentSha256:'e'.repeat(64),exemptTags:[]}),/DESCRIPTOR/);const r=f.allocate();assert.throws(()=>C.bound(f.plan,f.book,r,{...f.book,service:r.class},{}),/CONTAINER/);});
test('fresh exact versions only; missing rows never become a new ledger',()=>{for(const version of [1,2,4]){const f=fixture();f.book.version=version;assert.throws(()=>C.validate(f.plan,f.book),/LEDGER/);}const f=fixture();delete f.book.controlLeases;assert.throws(()=>C.validate(f.plan,f.book),/LEDGER/);f.plan.version=1;assert.throws(()=>C.ledger(f.plan),/VERSION/);});
test('complete durable tag census includes UNKNOWN and separates physical class occupancy',()=>{const f=fixture(),r=f.allocate();f.bind(r);C.uncertain(f.plan,f.book,r);f.stop(r);const other=f.allocate('realtime-recovery'),tags=C.known(f.plan,f.book).map(applicationName=>({applicationName,count:1}));const o=C.occupancy(f.plan,f.book,tags);assert.equal(o.heldControlCredits,2);assert.equal(o.activeControlExecutions,1);assert.equal(o.physical.control['lifecycle-operator'],1);assert.equal(o.physical.control['realtime-recovery'],1);for(const bad of [[],tags.slice(1),[...tags,tags[0]],tags.map(t=>({...t,applicationName:'forged'}))])assert.throws(()=>C.occupancy(f.plan,f.book,bad),/TAGS/);assert.equal(other.state,'ISSUED');});
function mutant(from,to){const filename=require.resolve('../control-recovery'),source=fs.readFileSync(filename,'utf8'),changed=source.replace(from,to);assert.notEqual(changed,source,'MUTATION_APPLIED');const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m._compile(changed,filename);return m.exports;}
test('red controls: live predecessor, third credit, and UNKNOWN tag omission fail their own safety oracles; restored passes',()=>{
 const cases=[
  ["need(book.controlLeases.filter(r=>r.state==='UNKNOWN').every(r=>r.stopped!==null),'CONTROL_RECOVERY_PREDECESSOR_LIVE');",'',impl=>{const f=fixture(impl),r=f.allocate();f.bind(r);impl.uncertain(f.plan,f.book,r);assert.throws(()=>f.allocate(),/PREDECESSOR_LIVE/);}],
  ["need(book.controlLeases.filter(r=>r.state!=='CLOSED').length<2,'CONTROL_RECOVERY_CREDIT_HELD');",'',impl=>{const f=fixture(impl);for(let i=0;i<2;i++){const r=f.allocate();f.bind(r);impl.uncertain(f.plan,f.book,r);f.stop(r);}assert.throws(()=>f.allocate(),/CREDIT_HELD/);}],
  ["...book.controlLeases.filter(r=>r.state!=='CLOSED').flatMap(r=>r.tags)","...book.controlLeases.filter(r=>r.state==='BOUND').flatMap(r=>r.tags)",impl=>{const f=fixture(impl),r=f.allocate();f.bind(r);impl.uncertain(f.plan,f.book,r);assert.deepEqual(impl.known(f.plan,f.book),r.tags,'UNKNOWN_TAG_REQUIRED');}]
 ];for(const [from,to,oracle] of cases){assert.throws(()=>oracle(mutant(from,to)));oracle(C);}
});

test('fixed realtime intent and typed lifecycle/commission intent have no selectors or extensible fields',()=>{
 for(const command of ['inspect','reconcile-step'])assert.deepEqual(C.intent('realtime-recovery',{version:1,command}),{version:1,command});
 for(const field of ['worker','tenant','target','cid','source','epoch','grace','lock','sql','module','retry'])assert.throws(()=>C.intent('realtime-recovery',{version:1,command:'reconcile-step',[field]:'caller'}),/INTENT/);
 for(const value of [{version:2,command:'inspect'},{version:1,command:'restart'}])assert.throws(()=>C.intent('realtime-recovery',value),/INTENT/);
 assert.deepEqual(C.intent('restore-commissioner',{version:2,command:'commission'}),{version:2,command:'commission'});
 const tenant='11111111-1111-4111-8111-111111111111';
 for(const command of ['inspect','clear-operations','capture','restore','resume']){const v={version:2,command,tenant,...(command==='restore'?{artifactDigest:'a'.repeat(64)}:command==='resume'?{claimId:tenant}:{})};assert.deepEqual(C.intent('lifecycle-operator',v),v);assert.throws(()=>C.intent('lifecycle-operator',{...v,path:'/caller'}),/INTENT/);}
});

test('all fixed classes bind BOTH worker database name and OID, including coherent class drift and missing identity',()=>{
 for(const c of C.CLASSES)for(const field of ['database','databaseOid']){const f=fixture();f.plan.controlRecovery.classes[c].principal[field]=field==='database'?'other_database':'999';const {sha256,...body}=f.plan;f.plan.sha256=B.hash(body);assert.throws(()=>C.ledger(f.plan),/WORKER_DATABASE/);}
 for(const field of ['database','databaseOid']){const f=fixture();for(const c of C.CLASSES)f.plan.controlRecovery.classes[c].principal[field]=field==='database'?'other_database':'999';const {sha256,...body}=f.plan;f.plan.sha256=B.hash(body);assert.throws(()=>C.ledger(f.plan),/WORKER_DATABASE/);}
 const f=fixture();delete f.plan.workerDatabase;const {sha256,...body}=f.plan;f.plan.sha256=B.hash(body);assert.throws(()=>C.ledger(f.plan),/WORKER_DATABASE_IDENTITY/);
});
function workerFixture(impl=C){const f=fixture(impl);f.plan.slots=[{processInstanceId:'api',capabilities:{'synthetic-pool':{kind:'pool',poolMax:1,maxInstances:1}},maximumOutstandingGenerations:1}];const {sha256,...body}=f.plan;f.plan.sha256=B.hash(body);f.book=impl.ledger(f.plan);const incarnation='1'.repeat(32),row={incarnation,nonce:'2'.repeat(32),tags:['nscb:'+incarnation+':'+require('node:crypto').createHash('sha256').update('synthetic-pool').digest('hex').slice(0,16)],container:null,state:'ISSUED',retired:false};f.book.slots.api.push(row);return {...f,row};}
test('exact worker capability-derived tags only; malformed, duplicate and excess generations never acquire managed authority',()=>{
 const valid=workerFixture();assert.deepEqual(C.known(valid.plan,valid.book),valid.row.tags);
 for(const change of [f=>f.row.tags=['caller-managed-exemption'],f=>f.row.tags=[],f=>f.row.tags.push(f.row.tags[0]),f=>f.row.retired='yes',f=>f.row.state='UNKNOWN',f=>f.book.slots.api.push(structuredClone(f.row)),f=>f.row.container={service:'other'},f=>f.book.slots.api='not-rows']){const f=workerFixture();change(f);assert.throws(()=>C.known(f.plan,f.book),/CONTROL_RECOVERY_/);}
 const f=workerFixture(),second={...structuredClone(f.row),incarnation:'3'.repeat(32),nonce:'4'.repeat(32)};second.tags=['nscb:'+second.incarnation+':'+require('node:crypto').createHash('sha256').update('synthetic-pool').digest('hex').slice(0,16)];f.book.slots.api.push(second);assert.throws(()=>C.known(f.plan,f.book),/WORKER_GENERATIONS/);
});
test('database name and OID binding red/restored controls fail the same database refusal oracle',()=>{
 const from="need(p.database===workerDatabase.database&&p.databaseOid===workerDatabase.databaseOid,'CONTROL_RECOVERY_WORKER_DATABASE');";
 for(const field of ['database','databaseOid']){const to=field==='database'?"need(p.databaseOid===workerDatabase.databaseOid,'CONTROL_RECOVERY_WORKER_DATABASE');":"need(p.database===workerDatabase.database,'CONTROL_RECOVERY_WORKER_DATABASE');";
  function oracle(impl){const f=fixture(impl);f.plan.controlRecovery.classes['realtime-recovery'].principal[field]=field==='database'?'other_database':'999';const {sha256,...body}=f.plan;f.plan.sha256=B.hash(body);assert.throws(()=>impl.ledger(f.plan),/WORKER_DATABASE/);}
  assert.throws(()=>oracle(mutant(from,to)),/Missing expected exception/);oracle(C);
 }
});
test('worker tag and duplicate-generation ablations go red; restored rejects before known authority',()=>{
 for(const [from,to,change] of [["&&equal([...r.tags].sort(),wanted)",'',f=>f.row.tags=['caller-managed-exemption']],["&&!ids.has(r.incarnation)&&!nonces.has(r.nonce)",'',f=>{f.plan.slots[0].maximumOutstandingGenerations=2;const {sha256,...body}=f.plan;f.plan.sha256=B.hash(body);f.book.planSha256=f.plan.sha256;f.book.slots.api.push(structuredClone(f.row));}]]){
  function oracle(impl){const f=workerFixture(impl);change(f);assert.throws(()=>impl.known(f.plan,f.book),/WORKER_ROW/);}
  assert.throws(()=>oracle(mutant(from,to)),/Missing expected exception/);oracle(C);
 }
});
