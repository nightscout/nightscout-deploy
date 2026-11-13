'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../realtime-recovery-roster'),B=require('../connection-budget');
const placement=require('../../../lib/realtime-placement'),ipc=require('../../../lib/server/internal-api/listener-config');
function fixture(){
 const source={coreCommit:'a'.repeat(40),deployCommit:'b'.repeat(40)};
 const expected={source,project:'synthetic-rt',workingDirectory:'/private/synthetic',imageId:'sha256:'+'c'.repeat(64)};
 const templates=['a','b','c'].map((worker,i)=>({worker,service:'realtime-'+worker,participantId:'rt-'+worker,address:{socket:'/private/rt-'+worker+'.sock'},consumerOrigin:'http://127.0.0.1:'+(19001+i),configSha256:'d'.repeat(64),environmentSha256:'e'.repeat(64)}));
 const participants=[...['api','evaluator','tenant-admin'].map((role,i)=>({id:role,roles:[role],namespaces:['synthetic'],endpoint:{socketPath:'/private/'+role+'.sock',maxBytes:4096,timeoutMs:1000}})),...templates.map(t=>({id:t.participantId,worker:t.worker,roles:['realtime'],namespaces:['synthetic'],endpoint:{socketPath:t.address.socket,maxBytes:4096,timeoutMs:1000}}))];
 const body={version:2,source,workerDatabase:{database:'synthetic',databaseOid:'123'},slots:templates.map(t=>({processInstanceId:t.service,roles:['realtime'],capabilities:{'nightscout-realtime-owner':{kind:'pool',poolMax:1,maxInstances:1}}}))};
 const plan={...body,sha256:B.hash(body)},internal=ipc.observer({});
 const prepared=R.prepare({plan,expected,templates,participants,internal});
 const map={version:2,rule:placement.RULE,shardCount:2,generation:1,owners:['a','a'],workers:templates.slice(0,2).map((t,i)=>({id:t.worker,incarnation:(i?'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),address:t.address,consumerOrigin:t.consumerOrigin}))};
 const platform=map.workers.map((w,i)=>({worker:w.id,assignmentIncarnation:w.incarnation,inspection:'RUNNING',noFutureDispatch:false,container:{...expected,service:templates[i].service,cid:(i?'2':'1').repeat(64),startedAt:'synthetic-birth-'+i,running:true}}));
 return{plan,expected,templates,participants,internal,prepared,map,platform};
}
const select=f=>R.select(f);
test('actual map2 and fixed manifest preserve idle actors independent of desired membership',()=>{
 const f=fixture();assert.deepEqual(R.desired(f.plan,f.prepared,{version:1,workers:['a']},f.internal).workers,['a']);
 const out=select(f);assert.deepEqual(out.participants.filter(p=>p.worker).map(p=>p.worker),['a','b']);assert.equal(out.participants.length,5);assert.equal(out.authority,'PEER_SELECTION_ONLY_NOT_LIVENESS_OR_CREDIT_RETIREMENT');assert(Object.isFrozen(out.participants));
 // Future c template is not manufactured into an admitted platform actor.
 assert(!out.participants.some(p=>p.worker==='c'));
});
test('template/source/slot and typed identity boundaries refuse before peer selection',()=>{
 for(const change of [f=>{f.expected.project=[f.expected.project];},f=>{f.expected.imageId=[f.expected.imageId];},f=>{f.expected.source.extra=true;},f=>{f.templates[1].service=f.templates[0].service;},f=>{f.templates[1].address=f.templates[0].address;},f=>{f.templates[0].address={socket:'/private/not-the-participant.sock'};},f=>{f.plan.slots[0].capabilities['nightscout-realtime-owner'].poolMax=2;const{sha256,...body}=f.plan;f.plan.sha256=B.hash(body);}]){
  const f=fixture();change(f);assert.throws(()=>R.prepare(f));
 }
});
test('self-hash cannot bypass plan/template/manifest validation',()=>{
 const f=fixture();f.prepared=structuredClone(f.prepared);f.prepared.templates[0].service='unplanned';const{sha256,...body}=f.prepared;f.prepared.sha256=B.hash(body);assert.throws(()=>select(f),{code:'REALTIME_RECOVERY_SLOT'});
});
test('unknown/current absence is not invented liveness; unmapped uncertain/live actor refuses',()=>{
 const f=fixture();f.platform=[];assert.equal(select(f).participants.length,5);
 for(const inspection of ['RUNNING','UNKNOWN']){const g=fixture();g.platform.push({worker:'c',assignmentIncarnation:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',inspection,noFutureDispatch:false,container:inspection==='UNKNOWN'?null:{...g.expected,service:'realtime-c',cid:'3'.repeat(64),startedAt:'synthetic-birth-c',running:true}});assert.throws(()=>select(g),{code:'REALTIME_RECOVERY_UNMAPPED_ACTOR'});}
});
test('stopped excluded actor needs exact custody/no-future-dispatch; duplicates and foreign refuse',()=>{
 const f=fixture();const row={worker:'c',assignmentIncarnation:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',inspection:'STOPPED',noFutureDispatch:true,container:{...f.expected,service:'realtime-c',cid:'3'.repeat(64),startedAt:'synthetic-birth-c',running:false}};
 f.platform.push(row);assert.equal(select(f).participants.length,5);
 for(const change of [r=>{r.noFutureDispatch=false;},r=>{r.container.running=true;},r=>{r.container.imageId='sha256:'+'f'.repeat(64);},r=>{r.worker='unplanned';},r=>{r.assignmentIncarnation=[r.assignmentIncarnation];}]){const g=fixture();const bad=structuredClone(row);change(bad);g.platform.push(bad);assert.throws(()=>select(g));}
 f.platform.push(structuredClone(row));assert.throws(()=>select(f),{code:'REALTIME_RECOVERY_PLATFORM_CUSTODY'});
});
test('desired declarations and map cannot bypass prepared roster/profile/endpoints',()=>{
 const f=fixture();for(const workers of [[],['unplanned'],['a','a'],[['a']]])assert.throws(()=>R.desired(f.plan,f.prepared,{version:1,workers},f.internal));
 for(const change of [m=>{m.version=1;},m=>{m.workers[0].address={socket:'/private/other.sock'};},m=>{m.workers[0].id='unplanned';m.owners=['unplanned','unplanned'];}]){const g=fixture();change(g.map);assert.throws(()=>select(g));}
});

test('same assignment crash restart retains old stopped boot and new physical boot without a map revision',()=>{
 const f=fixture(),old=structuredClone(f.platform[0]);old.inspection='STOPPED';old.noFutureDispatch=true;old.container.running=false;
 f.platform[0].container.cid='4'.repeat(64);f.platform[0].container.startedAt='synthetic-new-birth';f.platform.unshift(old);
 const out=select(f);assert.equal(out.mapGeneration,1);assert.equal(out.actorObservations.length,3);assert.deepEqual(out.actorObservations.filter(r=>r.worker==='a').map(r=>[r.inspection,r.container.cid]),[['STOPPED','1'.repeat(64)],['RUNNING','4'.repeat(64)]]);assert.equal(out.participants.filter(p=>p.worker==='a').length,1);
 for(const inspection of ['RUNNING','UNKNOWN']){const g=fixture(),other=structuredClone(g.platform[0]);other.inspection=inspection;other.container.cid='5'.repeat(64);other.container.startedAt='synthetic-other-birth';g.platform.push(other);assert.throws(()=>select(g),{code:'REALTIME_RECOVERY_AMBIGUOUS_BOOT'});}
});
