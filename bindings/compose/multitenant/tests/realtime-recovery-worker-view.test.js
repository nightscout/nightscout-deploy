'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fixture=require('./realtime-recovery-action-fixture'),V=require('../realtime-recovery-worker-view'),A=require('../realtime-recovery-action');
test('effective env uses exact prepared private bytes with only assignment changed, independently of fresh ticket mounts',()=>{
 const f=fixture(),t=f.templates[0],input=f.context.workerFiles[t.service],assignment='dddddddd-dddd-4ddd-8ddd-dddddddddddd',out=V.derive(t,assignment,input),before=JSON.parse(input.environmentBytes),after=JSON.parse(out.environmentBytes);
 assert.equal(after.REALTIME_WORKER_INCARNATION,assignment);delete before.REALTIME_WORKER_INCARNATION;delete after.REALTIME_WORKER_INCARNATION;assert.deepEqual(after,before);assert.deepEqual(out.configBytes,input.configBytes);assert.equal(out.environmentSha256,A.rawSha(out.environmentBytes));assert.notEqual(out.environmentSha256,t.environmentSha256);
 const action=structuredClone(f.value);action.starts[0].effectiveEnvironmentSha256=t.environmentSha256; // Original bytes are not the effective new assignment view.
 action.starts[0].assignmentIncarnation=assignment;assert.throws(()=>A.normalize(action,f.context));
});
test('changed base files, worker/socket/profile or injected admission/loader fields refuse, never arbitrary overrides',()=>{
 const f=fixture(),t=f.templates[0],input=f.context.workerFiles[t.service];
 for(const mutate of [e=>{e.REALTIME_WORKER_ID='foreign';},e=>{e.NS_SERVE_INTERNAL_SOCKET='/foreign';},e=>{e.NS_REALTIME_OWNERSHIP_CONTRACT='legacy';},e=>{e.NS_CONNECTION_BUDGET_FILE='/ticket';},e=>{e.NODE_OPTIONS='--require foreign';}]){
  const value=JSON.parse(input.environmentBytes);mutate(value);const bytes=Buffer.from(JSON.stringify(value)+'\n');assert.throws(()=>V.derive(t,f.old.assignmentIncarnation,{...input,environmentBytes:bytes}),{code:'REALTIME_RECOVERY_WORKER_FILE_CHANGED'});
  assert.throws(()=>V.derive({...t,environmentSha256:A.rawSha(bytes)},f.old.assignmentIncarnation,{...input,environmentBytes:bytes}),{code:'REALTIME_RECOVERY_WORKER_ENV'});
 }
 assert.throws(()=>V.derive(t,[f.old.assignmentIncarnation],input),{code:'REALTIME_RECOVERY_WORKER_ASSIGNMENT'});
});
