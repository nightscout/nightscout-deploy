'use strict';
// Closed metadata protocol. Only the fixed host derives effect arguments and
// actual proofs; these validators do not turn a caller result into authority.
const {isDeepStrictEqual:equal}=require('node:util'),A=require('./realtime-recovery-action');
const need=(v,c='REALTIME_RECOVERY_PROTOCOL')=>{if(!v)throw Object.assign(Error(c),{code:c});};
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&equal(Object.keys(v).sort(),[...k].sort());
const hex=(v,n=64)=>typeof v==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(v);
const indexed=['confirm-old','stop-old','start-selected'],kinds=['running',...indexed,'restart-cleared','assignment-published','warm-complete','routes-published'];
function tuple(action){return{version:1,class:'realtime-recovery',leaseIncarnation:action.leaseIncarnation,nonce:action.nonce,intentSha256:action.intentSha256,actionSha256:A.semantic(action)};}
function request(action,value,sequence){
 const v=structuredClone(value);need(exact(v,[...Object.keys(tuple(action)),'sequence','kind',...(indexed.includes(v?.kind)?['index']:[])])&&equal(Object.fromEntries(Object.keys(tuple(action)).map(k=>[k,v[k]])),tuple(action))&&Number.isSafeInteger(v.sequence)&&v.sequence===sequence&&sequence>=1&&sequence<=16&&kinds.includes(v.kind)&&Buffer.byteLength(JSON.stringify(v))<=1024);
 if(indexed.includes(v.kind))need(Number.isSafeInteger(v.index)&&v.index>=0&&v.index<(v.kind==='start-selected'?action.starts.length:action.oldBindings.length));return v;
}
function create(bindingSha256){need(hex(bindingSha256));return{version:1,bindingSha256,phase:'LAUNCH_AUTHORIZED',sequence:0,events:[],pending:null};}
const has=(s,k,i)=>s.events.some(e=>e.request.kind===k&&(i===undefined||e.request.index===i));
function before(action,s,r){
 need(!s.pending&&s.phase!=='COMPLETED'&&s.phase!=='REFUSED'&&s.phase!=='OUTCOME_UNCERTAIN','REALTIME_RECOVERY_PROTOCOL_PHASE');
 if(r.kind==='running')need(s.events.length===0,'REALTIME_RECOVERY_PROTOCOL_PHASE');else need(has(s,'running'),'REALTIME_RECOVERY_PROTOCOL_PHASE');
 if(r.kind==='confirm-old')need(s.events.filter(e=>e.request.kind==='confirm-old'&&e.request.index===r.index).length<2&&!has(s,'assignment-published')&&!has(s,'restart-cleared'),'REALTIME_RECOVERY_PROTOCOL_PHASE');
 if(r.kind==='stop-old')need(action.kind==='roster-step'&&!has(s,'stop-old',r.index)&&s.events.filter(e=>e.request.kind==='confirm-old'&&e.request.index===r.index).at(-1)?.ack.result.status==='RUNNING','REALTIME_RECOVERY_PROTOCOL_PHASE');
 if(['assignment-published','restart-cleared'].includes(r.kind)){
  need(!has(s,r.kind)&&action.oldBindings.every((_,i)=>s.events.filter(e=>e.request.kind==='confirm-old'&&e.request.index===i).at(-1)?.ack.result.status==='STOPPED'),'REALTIME_RECOVERY_PROTOCOL_PHASE');
  need(r.kind==='restart-cleared'?action.kind==='self-restart':['peer-takeover','roster-step'].includes(action.kind),'REALTIME_RECOVERY_PROTOCOL_PHASE');
 }
 if(r.kind==='start-selected')need(!has(s,'start-selected',r.index)&&has(s,action.kind==='self-restart'?'restart-cleared':'assignment-published'),'REALTIME_RECOVERY_PROTOCOL_PHASE');
 if(r.kind==='warm-complete')need(!has(s,r.kind)&&!['inspect','no-op'].includes(action.kind)&&action.starts.every((_,i)=>has(s,'start-selected',i))&&has(s,action.kind==='self-restart'?'restart-cleared':'assignment-published'),'REALTIME_RECOVERY_PROTOCOL_PHASE');
 if(r.kind==='routes-published')need(['peer-takeover','roster-step'].includes(action.kind)&&has(s,'warm-complete')&&!has(s,r.kind),'REALTIME_RECOVERY_PROTOCOL_PHASE');
}
function begin(action,state,value){const r=request(action,value,state.sequence+1);before(action,state,r);return{...structuredClone(state),sequence:r.sequence,pending:r};}
function result(action,r,v){
 const old=action.oldBindings[r.index],start=action.starts[r.index];
 if(r.kind==='running')need(exact(v,['status','ticketFileSha256','gateFileSha256','claimFileSha256'])&&v.status==='BOUND'&&['ticketFileSha256','gateFileSha256','claimFileSha256'].every(k=>hex(v[k])));
 if(['confirm-old','stop-old'].includes(r.kind))need(old&&exact(v,['status','noFutureDispatch','observationSha256'])&&['RUNNING','STOPPED'].includes(v.status)&&v.noFutureDispatch===(v.status==='STOPPED')&&hex(v.observationSha256)&&(r.kind!=='stop-old'||v.status==='STOPPED'));
 if(['assignment-published','routes-published'].includes(r.kind))need(exact(v,['status','generation','digest','mapFileSha256'])&&v.status==='MATCHED'&&v.generation===action.candidate.generation&&v.digest===action.candidate.mapSha256&&v.mapFileSha256===action.candidate.mapFileSha256);
 if(r.kind==='restart-cleared')need(exact(v,['status','mapSha256','proofSha256'])&&v.status==='RELEASED'&&v.mapSha256===action.before.mapSha256&&hex(v.proofSha256));
 if(r.kind==='start-selected'){
  const c=v?.container;need(start&&exact(v,['status','container','incarnation','nonce','ticketFileSha256','configSha256','environmentSha256'])&&v.status==='STARTED'&&hex(v.incarnation,32)&&hex(v.nonce,32)&&v.incarnation!==v.nonce&&v.incarnation!==action.leaseIncarnation&&v.nonce!==action.nonce&&hex(v.ticketFileSha256)&&v.configSha256===start.configSha256&&v.environmentSha256===start.effectiveEnvironmentSha256&&exact(c,['cid','startedAt','service','project','workingDirectory','imageId','source'])&&hex(c.cid)&&typeof c.startedAt==='string'&&c.startedAt.length>0&&c.startedAt.length<=100&&c.service===start.service&&equal(Object.fromEntries(Object.keys(action.expected).map(k=>[k,c[k]])),action.expected)&&!action.oldBindings.some(o=>o.container.cid===c.cid));
 }
 if(r.kind==='warm-complete')need(exact(v,['status','witnessSha256'])&&v.status==='READY'&&hex(v.witnessSha256));
 return structuredClone(v);
}
function acknowledge(action,state,value){
 need(Buffer.byteLength(JSON.stringify(value))<=16384,'REALTIME_RECOVERY_PROTOCOL_BOUND');need(state.pending,'REALTIME_RECOVERY_PROTOCOL_PENDING');const r=state.pending;need(exact(value,[...Object.keys(r),'result'])&&equal(Object.fromEntries(Object.keys(r).map(k=>[k,value[k]])),r),'REALTIME_RECOVERY_PROTOCOL_ACK');const ack={...r,result:result(action,r,value.result)};
 return{...structuredClone(state),phase:r.kind==='running'?'RUNNING':r.kind==='restart-cleared'?'RESTART_CLEARED':r.kind==='assignment-published'?'ASSIGNMENT_PUBLISHED':r.kind==='start-selected'?'RESTART_STARTED':r.kind==='warm-complete'?'WARM_OBSERVED':r.kind==='routes-published'?'ROUTES_PUBLISHED':state.phase,events:[...structuredClone(state.events),{request:structuredClone(r),ack}],pending:null};
}
function validate(action,state,bindingSha256){
 need(exact(state,['version','bindingSha256','phase','sequence','events','pending'])&&state.version===1&&state.bindingSha256===bindingSha256&&Array.isArray(state.events)&&state.events.length<=16&&Buffer.byteLength(JSON.stringify(state))<=131072,'REALTIME_RECOVERY_PHASE');
 if(state.phase==='PLANNED'){need(state.sequence===0&&state.events.length===0&&state.pending===null,'REALTIME_RECOVERY_PHASE');return state;}
 let replay=create(bindingSha256);for(const e of state.events){need(exact(e,['request','ack']),'REALTIME_RECOVERY_PHASE');replay=acknowledge(action,begin(action,replay,e.request),e.ack);}
 if(state.pending!==null)replay=begin(action,replay,state.pending);
 need(equal(replay,state),'REALTIME_RECOVERY_PHASE');return state;
}
function completed(action,state){
 need(state.pending===null&&has(state,'running'),'REALTIME_RECOVERY_PROTOCOL_INCOMPLETE');
 if(action.kind==='self-restart')need(has(state,'restart-cleared')&&has(state,'warm-complete'),'REALTIME_RECOVERY_PROTOCOL_INCOMPLETE');
 if(['peer-takeover','roster-step'].includes(action.kind))need(has(state,'assignment-published')&&has(state,'warm-complete')&&has(state,'routes-published'),'REALTIME_RECOVERY_PROTOCOL_INCOMPLETE');
 return A.semantic(state);
}
module.exports=Object.freeze({tuple,create,request,begin,acknowledge,validate,completed});
