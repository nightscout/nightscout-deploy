'use strict';
// Test-only observation of durable completion. Never retries a mutation or a
// failed invariant. Final success still requires the unchanged strict verdict.
const assert=require('node:assert/strict'),{verdict}=require('./clinical-effect-oracle.cjs');
const live=new Set(['pending','attempting','uncertain','accepted']);
function sqlBudget(timeout){
 if(timeout===undefined)return{execOptions:[],timeout:undefined};
 assert(Number.isSafeInteger(timeout)&&timeout>=1&&timeout<=20000,'BOUNDED_COMPLETION_SQL_BUDGET_REQUIRED');
 return{execOptions:['-e','PGOPTIONS=-c statement_timeout='+timeout+'ms'],timeout};
}
function observe(input){
 const {a,b,first,after,deadlines,now,fanout}=input;
 assert(after.length<=128,'BOUNDED_EFFECT_ROWS_REQUIRED');
 for(const row of [...first,...after])assert(/^[0-9a-f]{64}$/.test(row.effectDigest||'')&&/^[0-9a-f]{64}$/.test(row.origin||'')&&Number.isSafeInteger(row.created),'TYPED_EFFECT_IDENTITY_REQUIRED');
 const initial=new Map();
 for(const tenant of [a,b]){const rows=first.filter(row=>row.tenant===tenant&&!row.clear&&row.state==='accepted');assert.equal(rows.length,1,'ONE_INITIAL_ACCEPTED_NORMAL_EFFECT');initial.set(tenant,rows[0]);assert(Number.isSafeInteger(deadlines.get(tenant))&&now<deadlines.get(tenant),'PROOF_MUST_FINISH_BEFORE_ORIGINAL_REPEAT_DEADLINE');}
 assert.equal(new Set(after.map(row=>row.request)).size,after.length,'DURABLE_REQUEST_IDS_UNIQUE');
 for(const row of after){assert(initial.has(row.tenant),'EXPECTED_SYNTHETIC_TENANT');assert([...live,'cancelled'].includes(row.state),'KNOWN_DURABLE_STATE');assert.equal(row.configIdentity,initial.get(row.tenant).configIdentity,'CONFIG_IDENTITY_STABLE_DURING_MEMBERSHIP_ONLY_CHANGE');assert.notEqual(row.state,'uncertain','UNEXPECTED_TRANSPORT_UNCERTAINTY');if(row.tenant===b&&row.effectDigest!==initial.get(b).effectDigest)assert.notEqual(row.state,'cancelled','CHANGED_EFFECT_CANCELLED');}
 const active=after.filter(row=>live.has(row.state));assert.equal(active.filter(row=>row.clear).length,0,'UNCHANGED_URGENT_CONDITION_HAS_NO_CONTROL_CLEAR');
 const aa=active.filter(row=>row.tenant===a&&!row.clear),bb=active.filter(row=>row.tenant===b&&!row.clear);
 assert.equal(aa.length,1,'A_IDENTICAL_EFFECT_MUST_NOT_REPEAT_EARLY');for(const key of ['request','effectDigest','origin'])assert.equal(aa[0][key],initial.get(a)[key],'A_INITIAL_IDENTITY_STABLE');assert.equal(aa[0].state,'accepted','A_INITIAL_EFFECT_REMAINS_ACCEPTED');
 assert(bb.length<=2,'B_HAS_ONLY_INITIAL_AND_ONE_INTENTIONAL_CHANGED_EFFECT');
 const old=bb.filter(row=>row.effectDigest===initial.get(b).effectDigest),changed=bb.filter(row=>row.effectDigest!==initial.get(b).effectDigest);assert.equal(old.length,1,'B_INITIAL_EFFECT_NOT_DUPLICATED');for(const key of ['request','origin'])assert.equal(old[0][key],initial.get(b)[key],'B_INITIAL_IDENTITY_STABLE');assert.equal(old[0].state,'accepted','B_INITIAL_EFFECT_REMAINS_ACCEPTED');assert(changed.length<=1,'B_CHANGED_EFFECT_NOT_DUPLICATED');
 if(changed.length){assert.notEqual(changed[0].origin,old[0].origin,'CHANGED_EFFECT_HAS_NEW_CAUSE');assert(changed[0].created>=old[0].created,'CHANGED_EFFECT_FOLLOWS_INITIAL_INPUT');assert(['pending','attempting','accepted'].includes(changed[0].state),'EXPECTED_CHANGED_EFFECT_STATE');}
 for(const tenant of [a,b]){const seen=fanout.get(tenant);assert(Array.isArray(seen),'BOUNDED_FANOUT_REQUIRED');assert(seen.length<=(tenant===a?1:2),'FANOUT_MATCHES_LOGICAL_EFFECT_TRANSITIONS');assert.equal(new Set(seen).size,seen.length,'ONE_FANOUT_PER_EXPECTED_EFFECT');const known=new Set([initial.get(tenant).effectDigest,...(tenant===b?changed.map(row=>row.effectDigest):[])]);for(const hash of seen)assert(known.has(hash),'FANOUT_HAS_COMMITTED_EXPECTED_EFFECT');}
 if(!changed.length||changed[0].state!=='accepted'||fanout.get(a).length!==1||fanout.get(b).length!==2)return{ready:false};
 return{ready:true,verdict:verdict(input)};
}
async function wait({a,b,first,deadlines,deadline,read,fanout,frameReady=()=>true,minObservationMs=1500,now=()=>performance.now(),wallNow=()=>Date.now(),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 const summary={observations:0,history:[],final:null,frameObservedAt:null,minObservationMs};
 try{while(now()<deadline){
  assert(wallNow()<Math.min(...deadlines.values()),'PROOF_MUST_FINISH_BEFORE_ORIGINAL_REPEAT_DEADLINE');
  // Durable intent precedes emission. Copy events first, then read primary SQL;
  // a later event is intentionally considered in the following observation.
  const copiedAt=wallNow(),copied=fanout();for(const tenant of [a,b])assert(copied.get(tenant)?.length<=128,'BOUNDED_FANOUT_REQUIRED');
  const remaining=Math.min(deadline-now(),Math.min(...deadlines.values())-wallNow());assert(remaining>0,'CLINICAL_COMPLETION_DEADLINE');
  summary.observations++;const attempt={observation:summary.observations,fanoutCopiedAt:copiedAt,sqlReadStartedAt:wallNow(),sqlReadEndedAt:null};summary.history.push(attempt);if(summary.history.length>16)summary.history.shift();let result;try{result=await read(Math.max(1,Math.floor(remaining)));}finally{attempt.sqlReadEndedAt=wallNow();}
  assert(result.rows.length<=128,'BOUNDED_EFFECT_ROWS_REQUIRED');
  summary.final={fanoutCopiedAt:copiedAt,sqlReadStartedAt:result.startedAt,sqlReadEndedAt:result.endedAt,rows:result.rows,fanout:[...copied].map(([tenant,digests])=>({tenant,digests}))};
  const entry={observation:summary.observations,fanoutCopiedAt:copiedAt,sqlReadStartedAt:result.startedAt,sqlReadEndedAt:result.endedAt,states:result.rows.map(row=>row.state),fanoutCounts:[...copied.values()].map(rows=>rows.length)};Object.assign(attempt,entry);
  assert(now()<deadline,'CLINICAL_COMPLETION_DEADLINE');assert(wallNow()<Math.min(...deadlines.values()),'PROOF_MUST_FINISH_BEFORE_ORIGINAL_REPEAT_DEADLINE');
  const classified=observe({a,b,first,after:result.rows,deadlines,now:wallNow(),fanout:copied});attempt.ready=classified.ready;
  assert(now()<deadline,'CLINICAL_COMPLETION_DEADLINE');
  if(summary.frameObservedAt===null&&frameReady())summary.frameObservedAt=now();
  if(classified.ready&&summary.frameObservedAt!==null&&now()-summary.frameObservedAt>=minObservationMs){
   // Complete durable rows are now known. Include events received DURING the
   // last SQL read before certifying exact fanout, not only its earlier copy.
   const finalCopiedAt=wallNow(),finalFanout=fanout();for(const tenant of [a,b])assert(finalFanout.get(tenant)?.length<=128,'BOUNDED_FANOUT_REQUIRED');
   summary.final.finalFanoutCopiedAt=finalCopiedAt;summary.final.fanout=[...finalFanout].map(([tenant,digests])=>({tenant,digests}));
   const finalVerdict=verdict({a,b,first,after:result.rows,deadlines,now:wallNow(),fanout:finalFanout});
   assert(now()<deadline,'CLINICAL_COMPLETION_DEADLINE');assert(wallNow()<Math.min(...deadlines.values()),'PROOF_MUST_FINISH_BEFORE_ORIGINAL_REPEAT_DEADLINE');
   summary.final.validatedAt=wallNow();return{ready:true,verdict:finalVerdict,observation:summary};
  }
  await delay(Math.min(50,Math.max(0,deadline-now())));
 }throw new Error('CLINICAL_COMPLETION_DEADLINE');}catch(error){error.observation=summary;throw error;}
}
module.exports={observe,wait,sqlBudget};
