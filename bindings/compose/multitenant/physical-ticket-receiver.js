'use strict';
// Pure physical2 receiver validation. No claim, credential, module selection,
// constructor or transport effect can precede this check in either entry.
const {isDeepStrictEqual:equal}=require('node:util'),W=require('./worker-database');
const need=(value,code='CONNECTION_BUDGET_PHYSICAL_TICKET')=>{if(!value)throw Object.assign(Error(code),{code});};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&equal(Object.keys(v).sort(),[...keys].sort());
const match=(v,re)=>typeof v==='string'&&re.test(v);
const hex=(v,n)=>match(v,new RegExp('^[a-f0-9]{'+n+'}$'));
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const identifier=v=>match(v,/^[a-z][a-z0-9-]{0,62}$/);
function source(v){need(exact(v,['coreCommit','deployCommit'])&&Object.values(v).every(x=>hex(x,40)));}
function aliases(v){need(Array.isArray(v)&&v.length>0&&v.length<=32&&new Set(v).size===v.length&&v.every(x=>typeof x==='string'&&x===x.toLowerCase()&&x.length<=255&&/^[a-z0-9.\[\]:_-]+:[0-9]+$/.test(x)&&integer(Number(x.slice(x.lastIndexOf(':')+1)),1,65535)));}
function expected(v){need(exact(v,['source','project','workingDirectory','imageId'])&&identifier(v.project)&&typeof v.workingDirectory==='string'&&v.workingDirectory.startsWith('/')&&v.workingDirectory.length<=4096&&match(v.imageId,/^sha256:[a-f0-9]{64}$/));source(v.source);}
function container(v,className){need(exact(v,['cid','startedAt','project','workingDirectory','service','imageId','source'])&&hex(v.cid,64)&&typeof v.startedAt==='string'&&v.startedAt.length>0&&v.startedAt.length<=100&&v.service===className);expected(Object.fromEntries(['source','project','workingDirectory','imageId'].map(k=>[k,v[k]])));}
function files(v){need(object(v)&&Object.keys(v).length>0&&Object.keys(v).length<=8&&Object.entries(v).every(([name,hash])=>/^[a-z][a-z0-9-]*\.json$/.test(name)&&hex(hash,64)));}
function principal(v){need(exact(v,['role','roleOid','database','databaseOid'])&&match(v.role,/^[a-z][a-z0-9_]{0,62}$/)&&match(v.roleOid,/^[1-9][0-9]{0,9}$/)&&Number(v.roleOid)<=4294967295);W.identity({database:v.database,databaseOid:v.databaseOid});}
function cold(v){need(exact(v,['activeLimit','pendingLimit','minDelayMs','maxDelayMs'])&&integer(v.activeLimit,1,1000)&&integer(v.pendingLimit,1,1000000)&&integer(v.minDelayMs,0,60000)&&integer(v.maxDelayMs,v.minDelayMs,60000));}
function capabilities(v,groups){
 need(object(v)&&Object.keys(v).length>0&&Object.keys(v).length<=1024&&object(groups)&&Object.keys(groups).length<=1024&&Object.entries(groups).every(([name,n])=>name.length>0&&Buffer.byteLength(name)<=128&&integer(n,1,1000)));
 for(const [name,c]of Object.entries(v)){
  need(name.length>0&&Buffer.byteLength(name)<=128&&object(c)&&object(c.metadata));const m=c.metadata;
  need(typeof m.source==='string'&&m.source.length>0&&m.source.length<=256&&['explicit-profile','fixed-controller-control'].includes(m.configurationSource));
  if(c.kind==='pool')need(exact(c,['kind','poolMax','maxInstances','metadata'])&&integer(c.poolMax,1,1000)&&integer(c.maxInstances,1,16)&&exact(m,['source','requestedMaximum','configurationSource',...(Object.hasOwn(m,'heldWithinPool')?['heldWithinPool']:[])])&&integer(m.requestedMaximum,c.poolMax,1000)&&(!Object.hasOwn(m,'heldWithinPool')||integer(m.heldWithinPool,0,c.poolMax)));
  else need(c.kind==='client'&&exact(c,['kind','directGroup','metadata'])&&typeof c.directGroup==='string'&&Object.hasOwn(groups,c.directGroup)&&exact(m,['source','configurationSource']));
 }
}
const BASE=['version','workerDatabase','processInstanceId','incarnation','nonce','planSha256','source','pgResourceId','resourceAliases','capabilities','directGroups','cold'];
function ticket(v,className=null){
 need(exact(v,[...BASE,...(className?['control']:[])])&&v.version===2&&identifier(v.processInstanceId)&&(!className||v.processInstanceId===className)&&hex(v.incarnation,32)&&hex(v.nonce,32)&&v.incarnation!==v.nonce&&hex(v.planSha256,64)&&match(v.pgResourceId,/^[A-Za-z0-9_.:-]{1,128}$/));
 source(v.source);W.identity(v.workerDatabase);aliases(v.resourceAliases);cold(v.cold);capabilities(v.capabilities,v.directGroups);
 if(className){
  need(['lifecycle-operator','restore-commissioner','realtime-recovery'].includes(className));
  need(equal(v.capabilities,{[className]:{kind:'pool',poolMax:1,maxInstances:1,metadata:{requestedMaximum:1,source:'deploy/multitenant/'+className+'-entry.js',configurationSource:'fixed-controller-control'}}})&&equal(v.directGroups,{})&&equal(v.cold,{activeLimit:1,pendingLimit:1,minDelayMs:0,maxDelayMs:0}));const c=v.control;
  need(exact(c,['version','class','intentSha256','resourceEpoch','expected','principal','files'])&&c.version===2&&c.class===className&&hex(c.intentSha256,64)&&Array.isArray(c.resourceEpoch)&&c.resourceEpoch.length===2&&match(c.resourceEpoch[0],/^[0-9]{1,24}$/)&&typeof c.resourceEpoch[1]==='string'&&c.resourceEpoch[1].length>0&&c.resourceEpoch[1].length<=64);
  expected(c.expected);need(equal(c.expected.source,v.source));principal(c.principal);need(c.principal.database===v.workerDatabase.database&&c.principal.databaseOid===v.workerDatabase.databaseOid);files(c.files);
 }
 return v;
}
function gate(v,t){ticket(t,t.processInstanceId);need(exact(v,['version','class','incarnation','nonce','intentSha256','container'])&&v.version===2&&v.class===t.control.class&&v.incarnation===t.incarnation&&v.nonce===t.nonce&&v.intentSha256===t.control.intentSha256);container(v.container,v.class);need(equal(Object.fromEntries(Object.keys(t.control.expected).map(k=>[k,v.container[k]])),t.control.expected));return v;}
function workerPlan(v){
 need(object(v)&&v.version===2&&v.kind==='controlled-connection-budget-plan'&&hex(v.sha256,64));source(v.source);W.identity(v.workerDatabase);
 need(object(v.resource)&&match(v.resource.pgResourceId,/^[A-Za-z0-9_.:-]{1,128}$/));aliases(v.resource.aliases);
 need(Array.isArray(v.slots)&&v.slots.length>0&&v.slots.length<=128&&new Set(v.slots.map(s=>s?.processInstanceId)).size===v.slots.length);
 for(const s of v.slots){need(object(s)&&identifier(s.processInstanceId)&&integer(s.startupConcurrency,1,1000));capabilities(s.capabilities,s.directGroups);cold(s.cold);}
 return v;
}
module.exports=Object.freeze({ticket,gate,workerPlan});
