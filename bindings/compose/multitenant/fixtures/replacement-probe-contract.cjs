'use strict';
const assert=require('node:assert/strict');
const titles={cold:'Synthetic cold target',alarmA:'Synthetic shipping alarm-a',alarmB:'Synthetic shipping alarm-b'};
function payloads(nonce){assert(/^[a-f0-9]{32}$/.test(nonce||''),'SHIPPING_MOVE_PROBE_NONCE_REQUIRED');return Object.fromEntries(Object.entries(titles).map(([kind,title])=>[kind,{level:1,title,message:'Synthetic placement probe '+nonce}]));}
function expected(nonce,effectIdentity){const bodies=payloads(nonce),digests=Object.fromEntries(Object.entries(bodies).map(([kind,body])=>[kind,effectIdentity(body)]));assert(new Set(Object.values(digests)).size===3&&Object.values(digests).every(v=>/^[a-f0-9]{64}$/.test(v)),'SHIPPING_MOVE_PROBE_DIGESTS_REQUIRED');return{digests,payloads:bodies};}
function discriminator(payload,digests,effectIdentity){const digest=effectIdentity(payload),match=Object.entries(digests).find(([,value])=>value===digest);if(match)return match[0];return Object.values(titles).includes(payload?.title)&&/^Synthetic placement probe [a-f0-9]{32}$/.test(payload?.message||'')?'unexpected-synthetic':null;}
function inspect(clients,digests,effectIdentity,phase){
 const slots=['A/','B/','A/alarm','B/alarm'];assert(Object.keys(clients).length===slots.length&&slots.every(slot=>Array.isArray(clients[slot])),'SHIPPING_MOVE_PROBE_CLIENTS_REQUIRED');
 const counts=Object.fromEntries(Object.keys(clients).map(slot=>[slot,{cold:0,alarmA:0,alarmB:0,unrelatedClinical:0}]));
 for(const[slot,rows]of Object.entries(clients))for(const payload of rows){const kind=discriminator(payload,digests,effectIdentity);assert.notEqual(kind,'unexpected-synthetic','SHIPPING_MOVE_UNEXPECTED_PROBE_IDENTITY');counts[slot][kind||'unrelatedClinical']++;}
 assert(Object.hasOwn(counts,'A/alarm')&&Object.hasOwn(counts,'B/alarm'),'SHIPPING_MOVE_PROBE_CLIENTS_REQUIRED');
 for(const[slot,row]of Object.entries(counts)){assert.equal(row.cold,0,'SHIPPING_MOVE_COLD_PROBE_FORBIDDEN');assert.equal(slot==='B/alarm'?0:row.alarmB,0,'SHIPPING_MOVE_B_PROBE_WRONG_CLIENT');assert.equal(slot==='A/alarm'&&phase==='complete'?0:row.alarmA,0,'SHIPPING_MOVE_A_PROBE_FORBIDDEN');assert(row.alarmB<=1&&row.alarmA<=1,'SHIPPING_MOVE_PROBE_DUPLICATE');}
 const ready=counts['B/alarm'].alarmB===1&&(phase!=='complete'||counts['A/alarm'].alarmA===1);return{ready,counts,expectedDigests:digests};
}
module.exports={payloads,expected,discriminator,held:(clients,digests,effectIdentity)=>inspect(clients,digests,effectIdentity,'held'),complete:(clients,digests,effectIdentity)=>inspect(clients,digests,effectIdentity,'complete')};
