'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {precondition,observer,traffic}=require('./fixtures/api-readiness-observation.cjs');
const targets=['api','api-2'].flatMap(service=>[0,1].map(tenantOrdinal=>({service,tenantOrdinal,credential:'private synthetic credential',host:'synthetic.example'})));
test('every exact API/tenant tuple must initialize; only typed warming is retried before the barrier',async()=>{
 const calls=new Map(),trace=observer();
 const result=await precondition({targets,trace,delay:async()=>{},read:async t=>{const key=t.service+t.tenantOrdinal,n=(calls.get(key)||0)+1;calls.set(key,n);return key==='api-21'&&n===1?{status:503,code:'TENANT_WARMING'}:{status:200,code:null};}});
 assert.equal(result.passed,true);assert.equal(result.matrix.length,4);assert.equal(result.matrix[3].warming,1);assert.equal(calls.get('api-21'),2);assert(!JSON.stringify(result).includes('private synthetic credential'));assert(!JSON.stringify(result).includes('synthetic.example'));
});
test('cold exact replica fails despite other tuples being hot; late200 cannot cross the shared bound',async()=>{
 let clock=0;const result=await precondition({targets,timeoutMs:100,now:()=>clock,delay:async ms=>{clock+=ms;},read:async t=>t.service==='api-2'&&t.tenantOrdinal===1?{status:503,code:'TENANT_WARMING'}:{status:200}});
 assert.equal(result.passed,false);assert.equal(result.failure.code,'API_READINESS_DEADLINE');assert.equal(result.matrix[3].ready,false);
 clock=0;const late=await precondition({targets:[targets[0]],timeoutMs:100,now:()=>clock,read:async()=>{clock=101;return{status:200};}});assert.equal(late.passed,false);
});
for(const response of [{status:401,code:'CREDENTIAL_REFUSED'},{status:503,code:'AUTHORITY_UNAVAILABLE'},{status:503,code:null},{status:200,code:'API_READINESS_RESPONSE_INVALID'},{status:423,code:'TENANT_SUSPENDED'}])test('other precondition refusal is terminal '+response.status+'/'+response.code,async()=>{let calls=0;const result=await precondition({targets:[targets[0]],read:async()=>{calls++;return response;}});assert.equal(result.passed,false);assert.equal(calls,1);assert.equal(result.failure.code,'API_READINESS_REFUSED');});
test('hung/transport requests fail closed and abort outstanding reads',async()=>{
 let signal;const result=await precondition({targets:[targets[0]],timeoutMs:10,read:async(t,options)=>{signal=options.signal;await new Promise(()=>{});}});assert.equal(result.failure.code,'API_READINESS_DEADLINE');assert.equal(signal.aborted,true);
 const failed=await precondition({targets:[targets[0]],read:async()=>{throw new Error('secret');}});assert.equal(failed.failure.code,'API_READINESS_TRANSPORT_REFUSED');assert(!JSON.stringify(failed).includes('secret'));
});
test('all four measured edge workers need first success and any during-restore warming remains a strict failure',async()=>{
 const resolvers=[],trace=observer();const workload=traffic({trace,read:worker=>new Promise(resolve=>resolvers.push({worker,resolve}))});
 assert.equal(workload.ready(),false);for(const row of resolvers.splice(0))row.resolve({status:200,body:{}});await new Promise(setImmediate);assert.equal(workload.ready(),true);assert.equal(workload.reads,4);
 resolvers.find(row=>row.worker===2).resolve({status:503,body:{error:'TENANT_WARMING'}});await new Promise(setImmediate);assert.throws(()=>workload.ready(),/B settings traffic remains healthy/);
 const stop=workload.stop();for(const row of resolvers)row.resolve({status:200,body:{}});await stop;assert.equal(workload.errors.length,1);const bad=trace.snapshot().failures[0];assert.equal(bad.stage,'measured');assert.equal(bad.upstreamUnknown,true);assert.equal(bad.service,'public-edge');assert.equal(bad.errorCode,'TENANT_WARMING');assert.equal(bad.workerOrdinal,2);
});
test('one fast worker cannot satisfy four-worker precondition and chronology is bounded/sanitized',async()=>{
 const waits=[],trace=observer();const workload=traffic({trace,read:worker=>new Promise(resolve=>waits.push({worker,resolve}))});waits[0].resolve({status:200,body:{}});await new Promise(setImmediate);assert.equal(workload.ready(),false);const stop=workload.stop();for(const row of waits)row.resolve({status:200,body:{}});await stop;
 for(let i=0;i<300;i++)trace.request({stage:'measured',service:'public-edge',tenantOrdinal:1,status:503,errorCode:'secret-url/token',credential:'secret'});const view=trace.snapshot();assert.equal(view.requests.length,256);assert.equal(view.requestsTruncated,true);assert.equal(view.failures.length,16);assert(!JSON.stringify(view).includes('secret'));
});
test('measured transport and HTTP refusals each retain one sanitized attempt per worker',async()=>{
 for(const transport of [true,false]){const trace=observer();const workload=traffic({trace,read:async()=>{if(transport)throw Object.assign(new Error('private credential URL/body'),{code:'ECONNRESET'});return{status:503,body:{error:'TENANT_WARMING'}};}});await workload.stop();assert.equal(workload.errors.length,4);const view=trace.snapshot();assert.equal(view.requestsTotal,4,'MISSING_TYPED_MEASURED_REQUEST');assert.equal(view.failures.length,4);assert.deepEqual(view.requests.map(row=>row.workerOrdinal),[0,1,2,3]);assert(view.requests.every(row=>row.stage==='measured'&&row.service==='public-edge'&&row.upstreamUnknown&&row.endedAt>=row.startedAt&&row.durationMs>=0));assert(view.requests.every(row=>row.status===(transport?null:503)&&row.errorCode===(transport?'ECONNRESET':'TENANT_WARMING')));assert(!JSON.stringify(view).includes('private credential'));}
});
