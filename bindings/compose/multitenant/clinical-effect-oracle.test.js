'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{verdict}=require('./fixtures/clinical-effect-oracle.cjs');
const a='tenant-a',b='tenant-b',hash=n=>String(n).repeat(64);
function row(tenant,id,effect,extra={}){return{tenant,request:id,effectDigest:hash(effect),origin:hash(id.charCodeAt(0)%10),configIdentity:hash(9),clear:false,state:'accepted',created:0,...extra};}
function fixture(){const first=[row(a,'a',1),row(b,'b',2)],after=[...first,row(b,'c',3,{created:1000})];return{a,b,first,after,deadlines:new Map([[a,60000],[b,60000]]),now:5000,fanout:new Map([[a,[hash(1)]],[b,[hash(2),hash(3)]]])};}
test('allows one intentional B payload transition and classifies cancelled superseded rows',()=>{const f=fixture();f.after.push(row(b,'x',2,{state:'cancelled'}));const result=verdict(f);assert.equal(result.acceptedNormals,3);assert.equal(result.cancelled,1);});
test('rejects an accepted identical early A effect even with changed B input',()=>{const f=fixture();f.after.push(row(a,'d',1,{created:4438}));assert.throws(()=>verdict(f),/A_IDENTICAL_EFFECT_MUST_NOT_REPEAT_EARLY/);});
test('rejects a second accepted identical B401 effect',()=>{const f=fixture();f.after.push(row(b,'d',3,{created:1543}));assert.throws(()=>verdict(f),/B_HAS_ONLY_INITIAL_AND_ONE_INTENTIONAL_CHANGED_EFFECT/);});
test('rejects extra pending identical effects before they can be handed off',()=>{const f=fixture();f.after.push(row(a,'d',1,{state:'pending'}));assert.throws(()=>verdict(f),/A_IDENTICAL_EFFECT_MUST_NOT_REPEAT_EARLY/);});
test('rejects fabricated clear, duplicate socket fanout, and a proof crossing the real repeat deadline',()=>{let f=fixture();f.after.push(row(a,'d',4,{clear:true}));assert.throws(()=>verdict(f),/NO_CONTROL_CLEAR/);f=fixture();f.fanout.get(a).push(hash(1));assert.throws(()=>verdict(f),/FANOUT_MATCHES/);f=fixture();f.now=60000;assert.throws(()=>verdict(f),/ORIGINAL_REPEAT_DEADLINE/);});
