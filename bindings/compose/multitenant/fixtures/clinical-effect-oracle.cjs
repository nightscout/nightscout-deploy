'use strict';
// Test-only typed-effect verdict; digest values come from the selected source's
// notification contract, not a second payload-normalization implementation.
const assert=require('node:assert/strict');
const live=new Set(['pending','attempting','uncertain','accepted']);
function verdict({a,b,first,after,deadlines,now,fanout}){
 const initial=new Map();
 for(const tenant of [a,b]){
  const rows=first.filter(row=>row.tenant===tenant&&!row.clear&&row.state==='accepted');
  assert.equal(rows.length,1,'ONE_INITIAL_ACCEPTED_NORMAL_EFFECT');initial.set(tenant,rows[0]);
  const deadline=deadlines.get(tenant);assert(Number.isSafeInteger(deadline)&&now<deadline,'PROOF_MUST_FINISH_BEFORE_ORIGINAL_REPEAT_DEADLINE');
 }
 assert.equal(new Set(after.map(row=>row.request)).size,after.length,'DURABLE_REQUEST_IDS_UNIQUE');
 for(const row of after){assert([a,b].includes(row.tenant),'EXPECTED_SYNTHETIC_TENANT');assert([...live,'cancelled'].includes(row.state),'KNOWN_DURABLE_STATE');assert.equal(row.configIdentity,initial.get(row.tenant).configIdentity,'CONFIG_IDENTITY_STABLE_DURING_MEMBERSHIP_ONLY_CHANGE');}
 const active=after.filter(row=>live.has(row.state));
 assert.equal(active.filter(row=>row.clear).length,0,'UNCHANGED_URGENT_CONDITION_HAS_NO_CONTROL_CLEAR');
 const aa=active.filter(row=>row.tenant===a&&!row.clear),bb=active.filter(row=>row.tenant===b&&!row.clear);
 assert.equal(aa.length,1,'A_IDENTICAL_EFFECT_MUST_NOT_REPEAT_EARLY');assert.equal(aa[0].request,initial.get(a).request);assert.equal(aa[0].effectDigest,initial.get(a).effectDigest);assert.equal(aa[0].state,'accepted');
 assert.equal(bb.length,2,'B_HAS_ONLY_INITIAL_AND_ONE_INTENTIONAL_CHANGED_EFFECT');
 const old=bb.filter(row=>row.effectDigest===initial.get(b).effectDigest),changed=bb.filter(row=>row.effectDigest!==initial.get(b).effectDigest);
 assert.equal(old.length,1,'B_INITIAL_EFFECT_NOT_DUPLICATED');assert.equal(old[0].request,initial.get(b).request);
 assert.equal(changed.length,1,'B_CHANGED_EFFECT_NOT_DUPLICATED');assert.equal(changed[0].state,'accepted');assert.notEqual(changed[0].origin,old[0].origin,'CHANGED_EFFECT_HAS_NEW_CAUSE');
 for(const row of changed)assert(row.created>=old[0].created,'CHANGED_EFFECT_FOLLOWS_INITIAL_INPUT');
 if(fanout){
  for(const tenant of [a,b]){
   const expected=tenant===a?aa:bb,seen=fanout.get(tenant);
   assert(Array.isArray(seen));assert.equal(seen.length,expected.length,'FANOUT_MATCHES_LOGICAL_EFFECT_TRANSITIONS');
   for(const row of expected)assert.equal(seen.filter(hash=>hash===row.effectDigest).length,1,'ONE_FANOUT_PER_EXPECTED_EFFECT');
  }
 }
 return{acceptedNormals:active.filter(row=>!row.clear&&row.state==='accepted').length,cancelled:after.filter(row=>row.state==='cancelled').length,acceptedClears:active.filter(row=>row.clear&&row.state==='accepted').length,
  effects:[...initial.keys()].map(tenant=>({tenant,digests:active.filter(row=>row.tenant===tenant&&!row.clear).map(row=>row.effectDigest)}))};
}
module.exports={verdict};
