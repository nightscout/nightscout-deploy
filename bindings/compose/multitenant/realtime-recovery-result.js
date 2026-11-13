'use strict';
const {isDeepStrictEqual:equal}=require('node:util'),A=require('./realtime-recovery-action'),P=require('./realtime-recovery-protocol');
const need=(v,c='REALTIME_RECOVERY_RESULT')=>{if(!v)throw Object.assign(Error(c),{code:c});};
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&equal(Object.keys(v).sort(),[...k].sort());
function validate(action,binding,phase,receipt,execution){
 const v=receipt?.result,first=phase.events[0];
 need(exact(v,['version','actionSha256','bindingSha256','transcriptSha256','ticketFileSha256','gateFileSha256','claimFileSha256','status','error','work'])&&v.version===1&&v.actionSha256===A.semantic(action)&&v.bindingSha256===A.semantic(binding)&&v.transcriptSha256===A.semantic(phase)&&first?.request.kind==='running'&&phase.pending===null);
 need(equal(Object.fromEntries(['ticketFileSha256','gateFileSha256','claimFileSha256'].map(k=>[k,v[k]])),execution)&&equal({...execution,status:'BOUND'},first.ack.result));
 need(['COMPLETED','REFUSED'].includes(v.status)&&v.status===receipt.outcome);
 if(v.status==='REFUSED'){
  need(typeof v.error==='string'&&/^[A-Z][A-Z0-9_]{1,100}$/.test(v.error)&&v.work===null&&phase.events.every(e=>['running','confirm-old'].includes(e.request.kind)),'REALTIME_RECOVERY_REFUSAL_AFTER_EFFECT');return v;
 }
 need(v.error===null);P.completed(action,phase);
 if(['inspect','no-op'].includes(action.kind)){need(v.work===null);return v;}
 const w=v.work;
 need(exact(w,['generation','digest','affectedTenants','logicalMoves','assignmentChanges','logicalMovedTenants','retainedWarmTenantUpperBound','warmWorkBasis'])&&w.generation===(action.candidate||action.before).generation&&w.digest===(action.candidate?.mapSha256||action.before.mapSha256)&&w.warmWorkBasis==='affected-registry-tenants-upper-bound');
 for(const k of ['affectedTenants','logicalMoves','assignmentChanges','logicalMovedTenants','retainedWarmTenantUpperBound'])need(Number.isSafeInteger(w[k])&&w[k]>=0&&w[k]<=100000);
 need(w.logicalMoves<=action.limits.maxLogicalMoves&&w.assignmentChanges<=action.limits.maxAssignmentChanges&&w.affectedTenants<=action.limits.maxAffectedTenants&&w.logicalMovedTenants<=w.affectedTenants&&w.retainedWarmTenantUpperBound===w.affectedTenants-w.logicalMovedTenants);
 if(action.kind==='self-restart')need(w.logicalMoves===0&&w.assignmentChanges===0&&w.logicalMovedTenants===0);
 return v;
}
module.exports=Object.freeze({validate});
