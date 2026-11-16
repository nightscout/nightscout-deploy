// Synthetic gateway fixtures only. Real flock/CAS tests use temporary files.
// No authoritative ledger, provider, key, guard, SSH or export is accessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {rootAdapter,fileLedger} from './pgstream-batch-root.mjs';
import {batchDigest} from './pgstream-caller.mjs';
const H='a'.repeat(64),J='b'.repeat(64),N='c'.repeat(32);
const baseline=()=>({maximumAggregateHourlyUSD:2,maximumTotalUSD:16,currentAggregateHourlyUSD:0,reservedAggregateHourlyUSD:0,totalReservedUpperUSD:7,uncommittedUpperBudgetUSD:9,hardAllPaidResourcesAbsentUTC:new Date(5000*1000).toISOString(),plans:[{id:'preserve-peer-history'}]});
async function fixture({ledger,initial=baseline(),id='synthetic-batch',suffix='0'}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pgcal-root-'));const file=path.join(dir,'ledger.json');await fs.writeFile(file,JSON.stringify(initial));ledger??=fileLedger(file);
  const target={kind:'remote',provider:'synthetic',region:'test1',size:'test4',namePrefix:'owned-'+suffix,maxResources:2};
  const resources={hourlyMicrousd:1000000,totalMicrousd:3500000,millicpus:8000,memoryBytes:16000000000,heapMiB:1024,liveResources:2};
  const cell={id:'cell-one',namespace:'owned-cell-'+suffix,nonce:suffix.repeat(32),target,resources,creationNotBefore:1000,creationNotAfter:1100,cleanupAt:4600,cost:{computeUpperMicrousd:1500000,feesEgressCleanupUpperMicrousd:2000000}};
  const payload={source:{core:'d'.repeat(40),deploy:'e'.repeat(40)},image:'sha256:'+H,helper:H,files:[{path:'cell-one/spec.json',sha256:J}]};
  const envelope={hourlyMicrousd:1000000,totalMicrousd:3500000,cleanupAt:4600};const intent={version:1,id,payload,envelope,cells:[cell]};
  const approval={source:{kind:'direct-user-message',chatId:'synthetic-source',messageId:'synthetic-message'},receiptSha256:H,intentSha256:batchDigest(intent),intent};
  const hostIds=['synthetic-app-'+suffix,'synthetic-driver-'+suffix];
  const fullCell={...cell,config:{lastNewPointAt:3000,expiresAt:4500,hosts:{sut:{providerId:hostIds[0]},driver:{providerId:hostIds[1]}}}};
  const plan={version:1,id,sha256:J,specSha256:J,payload,envelope,cells:[{...cell,cellSha256:batchDigest(fullCell),hosts:fullCell.config.hosts,expiresAt:4500}]};
  const bound={planSha256:J,projectionSha256:batchDigest(plan),intentSha256:approval.intentSha256,receiptSha256:H,cells:{'cell-one':{cellSha256:batchDigest(fullCell),providerIds:hostIds,sourceHostBindingSha256:J}}};
  const mutable={clock:1000,approval,bound,guard:{status:'ARMED',namespace:cell.namespace,nonce:cell.nonce,observedAt:1000,pid:321,startTicks:'12345',sameBirth:true,keyCustody:true,cleanupAt:4500,receiptSha256:H,providerIds:[]},observation:null,absence:null,cleaned:[]};
  const observation=()=>mutable.observation??{namespace:cell.namespace,nonce:cell.nonce,targetMatches:true,sourceHostBindingVerified:true,sourceHostBindingSha256:J,providerIds:hostIds,guard:{...mutable.guard,providerIds:hostIds}};
  const absence=record=>mutable.absence??{namespace:cell.namespace,nonce:cell.nonce,observedAt:mutable.clock,receiptSha256:H,providerAbsent:true,providerKeyAbsent:true,localKeyFilesAbsent:true,guardSameBirthAbsent:true,guardGroupAbsent:true,guardPid:321,guardStartTicks:'12345',providerIds:record.providerIds};
  const options={ledger,authority:{reviewedIntent:async()=>mutable.approval,boundPlan:async()=>mutable.bound},custody:{beforeAllocation:async()=>structuredClone(mutable.guard),observe:async()=>structuredClone(observation()),absence:async({record})=>structuredClone(absence(record))},cleanupOwned:async r=>{mutable.cleaned.push(r);},now:()=>mutable.clock};
  const adapter=rootAdapter(options);const read=()=>ledger.transaction(v=>structuredClone(v));
  const reserve=()=>adapter.reserveBeforeAllocation(id,cell.id);
  async function bind(){const r=await reserve();await adapter.markCreateAttempt(id,cell.id,r.token);await adapter.bindAllocation(id,cell.id,r.token);return r;}
  async function enter(){const r=await bind();await adapter.dispatch('admit-batch',plan);const claim=await adapter.dispatch('reserve-cell',{batchId:id,planSha256:J,cell:fullCell});assert.equal(claim.token,r.token);return r;}
  const release=token=>adapter.dispatch('release-cell',{batchId:id,planSha256:J,cellId:cell.id,token,providerIds:hostIds});
  return {adapter,options,mutable,cell,fullCell,plan,bound,hostIds,approval,reserve,bind,enter,release,read,file,dir,ledger,absence};
}

test('actual file ledger serializes duplicate reservations and one upper survives partial/release/replay',async t=>{
  const f=await fixture();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));
  const replies=await Promise.all(Array.from({length:6},()=>f.reserve()));assert.equal(new Set(replies.map(x=>x.token)).size,1);
  let v=await f.read();assert.equal(v.totalReservedUpperUSD,10.5);assert.equal(v.reservedAggregateHourlyUSD,1);assert.equal(v.currentAggregateHourlyUSD,0);assert.deepEqual(v.plans,[{id:'preserve-peer-history'}]);
  const r=await f.enter();v=await f.read();assert.equal(v.totalReservedUpperUSD,10.5);assert.equal(v.currentAggregateHourlyUSD,1);
  await f.release(r.token);await f.release(r.token);v=await f.read();assert.equal(v.currentAggregateHourlyUSD,0);assert.equal(v.reservedAggregateHourlyUSD,0);assert.equal(v.totalReservedUpperUSD,10.5);assert.equal(v.uncommittedUpperBudgetUSD,5.5);
});

test('global overcommit/race uses real shared flock across independent adapters',async t=>{
  const initial=baseline();initial.maximumTotalUSD=10.5;initial.uncommittedUpperBudgetUSD=3.5;
  const f=await fixture({initial});const g=await fixture({ledger:fileLedger(f.file),id:'other-batch',suffix:'1'});t.after(()=>Promise.all([f.dir,g.dir].map(d=>fs.rm(d,{recursive:true,force:true}))));
  const results=await Promise.allSettled([f.reserve(),g.reserve()]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/GLOBAL_TOTAL_OVERCOMMIT/);const v=await f.read();assert.equal(v.totalReservedUpperUSD,10.5);assert.equal(v.reservedAggregateHourlyUSD,1);
});

test('real ledger CAS refuses a writer that ignores the lock; restored transaction passes',async t=>{
  const f=await fixture();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));
  await assert.rejects(f.ledger.transaction(async v=>{await fs.writeFile(f.file,JSON.stringify({...v,peerFact:'changed'}));v.totalReservedUpperUSD=9;}),/LEDGER_CAS/);
  assert.equal((await f.read()).peerFact,'changed');assert.equal((await f.read()).totalReservedUpperUSD,7);await f.reserve();assert.equal((await f.read()).totalReservedUpperUSD,10.5);
});

test('no request/fixture grants authority; payload/envelope mutation and expiry refuse before reservation',async t=>{
  const f=await fixture();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));
  f.mutable.approval=null;await assert.rejects(f.adapter.dispatch('admit-batch',{...f.plan,approved:true}),/DIRECT_AUTHORITY/);assert.equal((await f.read()).totalReservedUpperUSD,7);
  f.mutable.approval=structuredClone(f.approval);f.mutable.approval.intent.payload.files[0].sha256=H;await assert.rejects(f.reserve(),/INTENT_CHANGED/);
  f.mutable.approval=structuredClone(f.approval);f.mutable.clock=4600;await assert.rejects(f.reserve(),/AUTHORITY_EXPIRED/);f.mutable.clock=1000;await f.reserve();
});

test('hourly overcommit, foreign nonce, stale birth and uncovered provider IDs go red/restored',async t=>{
  const f=await fixture();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));
  await f.ledger.transaction(v=>{v.maximumAggregateHourlyUSD=.5;});await assert.rejects(f.reserve(),/GLOBAL_HOURLY_OVERCOMMIT/);await f.ledger.transaction(v=>{v.maximumAggregateHourlyUSD=2;});
  const old=f.mutable.guard.nonce;f.mutable.guard.nonce=N;await assert.rejects(f.reserve(),/GUARD_CUSTODY/);f.mutable.guard.nonce=old;const r=await f.reserve();
  f.mutable.guard.startTicks='foreign';await assert.rejects(f.adapter.markCreateAttempt(f.plan.id,f.cell.id,r.token),/STALE_GUARD_BIRTH/);f.mutable.guard.startTicks='12345';await f.adapter.markCreateAttempt(f.plan.id,f.cell.id,r.token);
  f.mutable.observation={namespace:f.cell.namespace,nonce:old,targetMatches:true,sourceHostBindingVerified:true,sourceHostBindingSha256:J,providerIds:f.hostIds,guard:{...f.mutable.guard,providerIds:[]}};
  await assert.rejects(f.adapter.bindAllocation(f.plan.id,f.cell.id,r.token),/ALLOCATION_BINDING/);f.mutable.observation=null;await f.adapter.bindAllocation(f.plan.id,f.cell.id,r.token);
});

test('a trusted but underpriced intent or missed creation window does not become permission',async t=>{
  const f=await fixture();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));
  const bad=structuredClone(f.approval);bad.intent.cells[0].cost.computeUpperMicrousd=1;bad.intentSha256=batchDigest(bad.intent);f.mutable.approval=bad;await assert.rejects(f.reserve(),/COST_OR_CREATION_WINDOW/);
  f.mutable.approval=f.approval;const r=await f.reserve();f.mutable.clock=1100;f.mutable.guard.observedAt=1100;await assert.rejects(f.adapter.markCreateAttempt(f.plan.id,f.cell.id,r.token),/CREATE_WINDOW/);f.mutable.clock=1000;f.mutable.guard.observedAt=1000;await f.adapter.markCreateAttempt(f.plan.id,f.cell.id,r.token);
  await assert.rejects(f.adapter.markCreateAttempt(f.plan.id,f.cell.id,r.token),/CREATE_ALREADY_ATTEMPTED/);assert.equal((await f.read()).currentAggregateHourlyUSD,1);
});

test('full bound projection and actual full cell digest prevent changed destinations/source replay',async t=>{
  const f=await fixture();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));await f.bind();
  const altered=structuredClone(f.plan);altered.cells[0].ports=[9999];await assert.rejects(f.adapter.dispatch('admit-batch',altered),/BOUND_PLAN_AUTHORITY/);
  await f.adapter.dispatch('admit-batch',f.plan);const changed=structuredClone(f.fullCell);changed.config.imageId='sha256:'+H;
  await assert.rejects(f.adapter.dispatch('reserve-cell',{batchId:f.plan.id,planSha256:J,cell:changed}),/CELL_CHANGED_OR_CANCELLED/);await f.adapter.dispatch('reserve-cell',{batchId:f.plan.id,planSha256:J,cell:f.fullCell});assert.equal((await f.read()).totalReservedUpperUSD,10.5);
  f.mutable.clock=3000;f.mutable.guard.observedAt=3000;await assert.rejects(f.adapter.dispatch('reserve-cell',{batchId:f.plan.id,planSha256:J,cell:f.fullCell}),/CELL_DEADLINE/);
});

test('caller deleted IDs are insufficient; missing key/group/provider absence keeps reservation',async t=>{
  const f=await fixture();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));const r=await f.enter();
  f.mutable.absence={};await assert.rejects(f.release(r.token),/INDEPENDENT_ABSENCE_REQUIRED/);assert.equal((await f.read()).reservedAggregateHourlyUSD,1);
  f.mutable.absence=null;const good=f.absence({providerIds:f.hostIds});
  for(const key of ['providerAbsent','providerKeyAbsent','localKeyFilesAbsent','guardSameBirthAbsent','guardGroupAbsent']){f.mutable.absence={...good,[key]:false};await assert.rejects(f.release(r.token),/INDEPENDENT_ABSENCE_REQUIRED/);}
  for(const [key,value]of [['guardPid',999],['guardStartTicks','foreign'],['nonce',N],['observedAt',900]]){f.mutable.absence={...good,[key]:value};await assert.rejects(f.release(r.token),/INDEPENDENT_ABSENCE_REQUIRED/);}
  f.mutable.absence=null;await assert.rejects(f.adapter.dispatch('release-cell',{batchId:f.plan.id,planSha256:J,cellId:f.cell.id,token:r.token,providerIds:['foreign']}),/DELETION_IDS_CHANGED/);await f.release(r.token);assert.equal((await f.read()).reservedAggregateHourlyUSD,0);
});

test('uncertain create retains upper, cancellation recovers exact IDs and blocks new claims',async t=>{
  const f=await fixture();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));const r=await f.reserve();await f.adapter.markCreateAttempt(f.plan.id,f.cell.id,r.token);
  f.mutable.absence={namespace:f.cell.namespace,nonce:f.cell.nonce,observedAt:1000,receiptSha256:H,providerAbsent:false,providerKeyAbsent:true,localKeyFilesAbsent:true,guardSameBirthAbsent:true,guardGroupAbsent:true,guardPid:321,guardStartTicks:'12345',providerIds:f.hostIds,recoveryVerified:true};
  const pending=await f.adapter.cancelBatch(f.plan.id);assert.equal(pending.status,'CANCELLED_CLEANUP_PENDING');assert.equal((await f.read()).reservedAggregateHourlyUSD,1);assert.equal((await f.read()).currentAggregateHourlyUSD,1);assert.equal(f.mutable.cleaned.length,1);assert.equal(f.mutable.cleaned[0].record.nonce,f.cell.nonce);await assert.rejects(f.reserve(),/BATCH_CANCELLED/);
  f.mutable.absence.providerAbsent=true;const done=await f.adapter.cancelBatch(f.plan.id);assert.equal(done.status,'CANCELLED_CLEAN');const v=await f.read();assert.equal(v.totalReservedUpperUSD,10.5);assert.equal(v.uncommittedUpperBudgetUSD,5.5);assert.equal(v.reservedAggregateHourlyUSD,0);assert.deepEqual(v.pgstreamBatchRoot[f.plan.id].cells[f.cell.id].recoveredDeletedProviderIds,f.hostIds);
});

test('unused preallocation cancellation returns unused upper; cleanup still works after authority expiry',async t=>{
  const f=await fixture();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));await f.reserve();f.mutable.clock=6000;f.mutable.approval=null;
  const r=await f.adapter.cancelBatch(f.plan.id);assert.equal(r.status,'CANCELLED_CLEAN');const v=await f.read();assert.equal(v.totalReservedUpperUSD,7);assert.equal(v.uncommittedUpperBudgetUSD,9);assert.equal(v.reservedAggregateHourlyUSD,0);
});
