'use strict';
// Common private accounting only. This module has no process, SQL or action dispatcher.
const crypto=require('node:crypto'),{isDeepStrictEqual:equal}=require('node:util');
const B=require('./connection-budget');
const need=(v,c)=>{if(!v)throw Object.assign(new Error(c),{code:c});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&equal(Object.keys(v).sort(),[...keys].sort());
const CLASSES=Object.freeze(['lifecycle-operator','restore-commissioner','realtime-recovery']);
const HEX32=/^[a-f0-9]{32}$/,HEX64=/^[a-f0-9]{64}$/;
function principal(p){need(exact(p,['role','roleOid','database','databaseOid'])&&['role','database'].every(k=>/^[a-z][a-z0-9_]{0,62}$/.test(p[k]))&&['roleOid','databaseOid'].every(k=>typeof p[k]==='string'&&/^[1-9][0-9]{0,9}$/.test(p[k])&&Number(p[k])<=4294967295),'CONTROL_RECOVERY_PRINCIPAL');return p;}
function intent(className,value){
 need(CLASSES.includes(className),'CONTROL_RECOVERY_CLASS');
 if(className==='realtime-recovery')need(exact(value,['version','command'])&&value.version===1&&['inspect','reconcile-step'].includes(value.command),'CONTROL_RECOVERY_INTENT');
 else if(className==='restore-commissioner')need(exact(value,['version','command'])&&value.version===2&&value.command==='commission','CONTROL_RECOVERY_INTENT');
 else {
  const extras=value?.command==='resume'?['claimId']:value?.command==='restore'?['artifactDigest']:[];
  const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)&&v!=='00000000-0000-0000-0000-000000000000';
  need(exact(value,['version','command','tenant',...extras])&&value.version===2&&['inspect','resume','clear-operations','capture','restore'].includes(value.command)&&uuid(value.tenant)&&(value.command!=='resume'||uuid(value.claimId))&&(value.command!=='restore'||typeof value.artifactDigest==='string'&&HEX64.test(value.artifactDigest)),'CONTROL_RECOVERY_INTENT');
 }
 return structuredClone(value);
}
function epoch(plan){return [plan.resource.systemIdentifier,plan.resource.postmasterStartedAt];}
function tag(className,incarnation){need(CLASSES.includes(className)&&HEX32.test(incarnation),'CONTROL_RECOVERY_CLASS');return 'nscb:'+incarnation+':'+crypto.createHash('sha256').update(className).digest('hex').slice(0,16);}
function planCheck(plan){
 need(plan.version===2&&plan.lifecycleOperator?.version===2&&plan.resource.allowances.controlRecovery===2&&exact(plan.controlRecovery,['version','classes'])&&plan.controlRecovery.version===1&&exact(plan.controlRecovery.classes,CLASSES),'CONTROL_RECOVERY_VERSION');
 const {sha256,...body}=plan;need(B.hash(body)===sha256,'CONTROL_RECOVERY_PLAN');
 for(const c of CLASSES){need(exact(plan.controlRecovery.classes[c],['principal']),'CONTROL_RECOVERY_CLASS');principal(plan.controlRecovery.classes[c].principal);}
 const op=plan.controlRecovery.classes['lifecycle-operator'].principal,commission=plan.controlRecovery.classes['restore-commissioner'].principal;
 need(op.role!==commission.role&&op.roleOid!==commission.roleOid&&op.database===commission.database&&op.databaseOid===commission.databaseOid,'CONTROL_RECOVERY_COMMISSION_PRINCIPAL');
}
function container(plan,c,v){need(exact(v,['cid','startedAt','project','workingDirectory','service','imageId','source'])&&HEX64.test(v.cid)&&typeof v.startedAt==='string'&&v.startedAt.length>0&&v.startedAt.length<=100&&/^[a-z][a-z0-9-]{0,62}$/.test(v.project)&&typeof v.workingDirectory==='string'&&v.workingDirectory.startsWith('/')&&v.service===c&&/^sha256:[a-f0-9]{64}$/.test(v.imageId)&&equal(v.source,plan.source),'CONTROL_RECOVERY_CONTAINER');return v;}
function validate(plan,book){
 planCheck(plan);
 need(exact(book,['version','planSha256','resourceEpoch','slots','controlLeases'])&&book.version===3&&book.planSha256===plan.sha256&&equal(book.resourceEpoch,epoch(plan))&&exact(book.slots,plan.slots.map(s=>s.processInstanceId))&&Array.isArray(book.controlLeases)&&book.controlLeases.length<=4096,'CONTROL_RECOVERY_LEDGER');
 const ids=new Set(Object.values(book.slots).flat().map(r=>r.incarnation)),nonces=new Set();
 for(const r of book.controlLeases){
  need(exact(r,['state','class','credits','incarnation','nonce','tags','intentSha256','planSha256','source','principal','container','stopped'])&&CLASSES.includes(r.class)&&['ISSUED','BOUND','UNKNOWN','CLOSED'].includes(r.state)&&r.credits===1&&HEX32.test(r.incarnation)&&HEX32.test(r.nonce)&&r.incarnation!==r.nonce&&!ids.has(r.incarnation)&&!nonces.has(r.nonce)&&HEX64.test(r.intentSha256)&&equal(r.tags,[tag(r.class,r.incarnation)])&&r.planSha256===plan.sha256&&equal(r.source,plan.source)&&equal(r.principal,plan.controlRecovery.classes[r.class].principal),'CONTROL_RECOVERY_ROW');
  ids.add(r.incarnation);nonces.add(r.nonce);
  if(r.container!==null)container(plan,r.class,r.container);
  need(r.state==='UNKNOWN'||(r.state==='ISSUED'?r.container===null:r.container!==null),'CONTROL_RECOVERY_BINDING');
  need(r.stopped===null||(r.state==='UNKNOWN'&&r.container!==null&&exact(r.stopped,['container','resourceEpoch','noFutureDispatch'])&&equal(r.stopped.container,r.container)&&equal(r.stopped.resourceEpoch,epoch(plan))&&r.stopped.noFutureDispatch===true),'CONTROL_RECOVERY_STOPPED');
 }
 const active=book.controlLeases.filter(r=>['ISSUED','BOUND'].includes(r.state));
 need(book.controlLeases.filter(r=>r.state!=='CLOSED').length<=2&&active.length<=1,'CONTROL_RECOVERY_CAPACITY');
 need(active.length===0||book.controlLeases.filter(r=>r.state==='UNKNOWN').every(r=>r.stopped!==null&&r.class!=='restore-commissioner'),'CONTROL_RECOVERY_PREDECESSOR_LIVE');
 return book;
}
function ledger(plan){planCheck(plan);return {...B.ledger(plan),version:3,controlLeases:[]};}
function allocate(plan,book,descriptor){
 validate(plan,book);need(exact(descriptor,['class','intentSha256'])&&CLASSES.includes(descriptor.class)&&HEX64.test(descriptor.intentSha256),'CONTROL_RECOVERY_DESCRIPTOR');
 need(!book.controlLeases.some(r=>r.class==='restore-commissioner'&&r.state==='UNKNOWN'),'CONTROL_RECOVERY_SETUP_TERMINAL');
 need(!book.controlLeases.some(r=>['ISSUED','BOUND'].includes(r.state)),'CONTROL_RECOVERY_ACTIVE');
 need(book.controlLeases.filter(r=>r.state!=='CLOSED').length<2,'CONTROL_RECOVERY_CREDIT_HELD');
 need(book.controlLeases.filter(r=>r.state==='UNKNOWN').every(r=>r.stopped!==null),'CONTROL_RECOVERY_PREDECESSOR_LIVE');
 need(book.controlLeases.length<4096,'CONTROL_RECOVERY_HISTORY_EXHAUSTED');
 const incarnation=crypto.randomBytes(16).toString('hex'),nonce=crypto.randomBytes(16).toString('hex');
 need(incarnation!==nonce&&![...book.controlLeases,...Object.values(book.slots).flat()].some(r=>r.incarnation===incarnation||r.nonce===nonce),'CONTROL_RECOVERY_RANDOM_COLLISION');
 const row={state:'ISSUED',class:descriptor.class,credits:1,incarnation,nonce,tags:[tag(descriptor.class,incarnation)],intentSha256:descriptor.intentSha256,planSha256:plan.sha256,source:structuredClone(plan.source),principal:structuredClone(plan.controlRecovery.classes[descriptor.class].principal),container:null,stopped:null};
 book.controlLeases.push(row);return row;
}
function bound(plan,book,row,actual,expected){validate(plan,book);need(book.controlLeases.includes(row)&&row.state==='ISSUED','CONTROL_RECOVERY_BINDING');container(plan,row.class,actual);need(exact(expected,['source','project','workingDirectory','imageId'])&&equal(Object.fromEntries(Object.keys(expected).map(k=>[k,actual[k]])),expected),'CONTROL_RECOVERY_CUSTODY');row.container=structuredClone(actual);row.state='BOUND';}
function uncertain(plan,book,row){validate(plan,book);need(book.controlLeases.includes(row)&&['ISSUED','BOUND'].includes(row.state),'CONTROL_RECOVERY_UNCERTAIN');row.state='UNKNOWN';}
function stopped(plan,book,row,proof){validate(plan,book);need(book.controlLeases.includes(row)&&row.state==='UNKNOWN'&&row.container!==null&&exact(proof,['container','resourceEpoch','noFutureDispatch'])&&equal(proof.container,row.container)&&equal(proof.resourceEpoch,epoch(plan))&&proof.noFutureDispatch===true,'CONTROL_RECOVERY_STOPPED');row.stopped=structuredClone(proof);}
function known(plan,book){validate(plan,book);return [...new Set([...Object.values(book.slots).flat().filter(r=>r.state!=='RETIRED').flatMap(r=>r.tags),...book.controlLeases.filter(r=>r.state!=='CLOSED').flatMap(r=>r.tags)])].sort();}
function occupancy(plan,book,tags){
 const wanted=known(plan,book);need(Array.isArray(tags)&&equal(tags.map(t=>t.applicationName).sort(),wanted)&&tags.every(t=>exact(t,['applicationName','count'])&&Number.isSafeInteger(t.count)&&t.count>=0&&t.count<=1000000),'CONTROL_RECOVERY_TAGS');
 const physical={workers:0,control:Object.fromEntries(CLASSES.map(c=>[c,0]))};
 for(const t of tags){const row=book.controlLeases.find(r=>r.state!=='CLOSED'&&r.tags.includes(t.applicationName));if(row)physical.control[row.class]+=t.count;else physical.workers+=t.count;}
 return {physical,heldControlCredits:book.controlLeases.filter(r=>r.state!=='CLOSED').length,activeControlExecutions:book.controlLeases.filter(r=>['ISSUED','BOUND'].includes(r.state)).length};
}
module.exports=Object.freeze({CLASSES,principal,intent,tag,validate,ledger,allocate,bound,uncertain,stopped,known,occupancy});
