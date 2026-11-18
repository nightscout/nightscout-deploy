'use strict';
// Common private accounting only. This module has no process, SQL or action dispatcher.
const crypto=require('node:crypto'),{isDeepStrictEqual:equal}=require('node:util');
const B=require('./connection-budget'),W=require('./worker-database');
const need=(v,c)=>{if(!v)throw Object.assign(new Error(c),{code:c});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&equal(Object.keys(v).sort(),[...keys].sort());
const CLASSES=Object.freeze(['lifecycle-operator','restore-commissioner','realtime-recovery']);
const HEX32=/^[a-f0-9]{32}$/,HEX64=/^[a-f0-9]{64}$/;
const matches=(pattern,value)=>typeof value==='string'&&pattern.test(value);
function principal(p){need(exact(p,['role','roleOid','database','databaseOid'])&&['role','database'].every(k=>matches(/^[a-z][a-z0-9_]{0,62}$/,p[k]))&&['roleOid','databaseOid'].every(k=>typeof p[k]==='string'&&/^[1-9][0-9]{0,9}$/.test(p[k])&&Number(p[k])<=4294967295),'CONTROL_RECOVERY_PRINCIPAL');return p;}
function intent(className,value){
 need(CLASSES.includes(className),'CONTROL_RECOVERY_CLASS');
 if(className==='realtime-recovery')need(exact(value,['version','command'])&&value.version===1&&['inspect','reconcile-step'].includes(value.command),'CONTROL_RECOVERY_INTENT');
 else if(className==='restore-commissioner')need(exact(value,['version','command'])&&value.version===2&&value.command==='commission','CONTROL_RECOVERY_INTENT');
 else {
  const extras=value?.command==='resume'?['claimId']:value?.command==='restore'?['artifactDigest']:[];
  const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)&&v!=='00000000-0000-0000-0000-000000000000';
  need(exact(value,['version','command','tenant',...extras])&&value.version===2&&['inspect','resume','capture','restore'].includes(value.command)&&uuid(value.tenant)&&(value.command!=='resume'||uuid(value.claimId))&&(value.command!=='restore'||typeof value.artifactDigest==='string'&&matches(HEX64,value.artifactDigest)),'CONTROL_RECOVERY_INTENT');
 }
 return structuredClone(value);
}
function epoch(plan){return [plan.resource.systemIdentifier,plan.resource.postmasterStartedAt];}
function tag(className,incarnation){need(CLASSES.includes(className)&&matches(HEX32,incarnation),'CONTROL_RECOVERY_CLASS');return 'nscb:'+incarnation+':'+crypto.createHash('sha256').update(className).digest('hex').slice(0,16);}
function planCheck(plan){
 need(plan&&typeof plan==='object'&&!Array.isArray(plan)&&exact(plan.source,['coreCommit','deployCommit'])&&Object.values(plan.source).every(v=>matches(/^[a-f0-9]{40}$/,v))&&matches(HEX64,plan.sha256),'CONTROL_RECOVERY_PLAN');
 need(plan.resource&&typeof plan.resource==='object'&&!Array.isArray(plan.resource)&&matches(/^[0-9]{1,24}$/,plan.resource.systemIdentifier)&&typeof plan.resource.postmasterStartedAt==='string'&&plan.resource.postmasterStartedAt.length>0&&plan.resource.postmasterStartedAt.length<=64,'CONTROL_RECOVERY_RESOURCE');
 need(Array.isArray(plan.slots)&&plan.slots.length<=128&&new Set(plan.slots.map(s=>s?.processInstanceId)).size===plan.slots.length&&plan.slots.every(s=>s&&typeof s==='object'&&!Array.isArray(s)&&matches(/^[a-z][a-z0-9-]{0,62}$/,s.processInstanceId)&&s.capabilities&&typeof s.capabilities==='object'&&!Array.isArray(s.capabilities)&&Object.keys(s.capabilities).length>0&&Object.keys(s.capabilities).length<=1024&&Number.isSafeInteger(s.maximumOutstandingGenerations)&&s.maximumOutstandingGenerations>=1&&s.maximumOutstandingGenerations<=16),'CONTROL_RECOVERY_PLAN');
 need(plan.version===2&&plan.lifecycleOperator?.version===2&&plan.resource.allowances.controlRecovery===2&&exact(plan.controlRecovery,['version','classes'])&&plan.controlRecovery.version===1&&exact(plan.controlRecovery.classes,CLASSES),'CONTROL_RECOVERY_VERSION');
 const {sha256,...body}=plan;need(B.hash(body)===sha256,'CONTROL_RECOVERY_PLAN');
 for(const c of CLASSES){need(exact(plan.controlRecovery.classes[c],['principal']),'CONTROL_RECOVERY_CLASS');principal(plan.controlRecovery.classes[c].principal);}
 const workerDatabase=W.identity(plan.workerDatabase);
 for(const c of CLASSES){const p=plan.controlRecovery.classes[c].principal;need(p.database===workerDatabase.database&&p.databaseOid===workerDatabase.databaseOid,'CONTROL_RECOVERY_WORKER_DATABASE');}
 const op=plan.controlRecovery.classes['lifecycle-operator'].principal,commission=plan.controlRecovery.classes['restore-commissioner'].principal;
 need(op.role!==commission.role&&op.roleOid!==commission.roleOid&&op.database===commission.database&&op.databaseOid===commission.databaseOid,'CONTROL_RECOVERY_COMMISSION_PRINCIPAL');
}
function container(plan,c,v){need(exact(v,['cid','startedAt','project','workingDirectory','service','imageId','source'])&&matches(HEX64,v.cid)&&typeof v.startedAt==='string'&&v.startedAt.length>0&&v.startedAt.length<=100&&matches(/^[a-z][a-z0-9-]{0,62}$/,v.project)&&typeof v.workingDirectory==='string'&&v.workingDirectory.startsWith('/')&&v.service===c&&matches(/^sha256:[a-f0-9]{64}$/,v.imageId)&&equal(v.source,plan.source),'CONTROL_RECOVERY_CONTAINER');return v;}
function validate(plan,book){
 planCheck(plan);
 need(exact(book,['version','planSha256','resourceEpoch','slots','controlLeases'])&&book.version===3&&book.planSha256===plan.sha256&&equal(book.resourceEpoch,epoch(plan))&&exact(book.slots,plan.slots.map(s=>s.processInstanceId))&&Array.isArray(book.controlLeases)&&book.controlLeases.length<=4096,'CONTROL_RECOVERY_LEDGER');
 const ids=new Set(),nonces=new Set();let workerRows=0;
 for(const slot of plan.slots){const rows=book.slots[slot.processInstanceId];need(Array.isArray(rows)&&rows.length<=4096,'CONTROL_RECOVERY_WORKER_ROW');workerRows+=rows.length;need(workerRows<=4096,'CONTROL_RECOVERY_WORKER_ROW');
  for(const r of rows){
   const wanted=Object.keys(slot.capabilities).map(c=>'nscb:'+r?.incarnation+':'+crypto.createHash('sha256').update(c).digest('hex').slice(0,16)).sort();
   need(exact(r,['incarnation','nonce','tags','container','state','retired'])&&matches(HEX32,r.incarnation)&&matches(HEX32,r.nonce)&&r.incarnation!==r.nonce&&!ids.has(r.incarnation)&&!nonces.has(r.nonce)&&['ISSUED','RETIRED'].includes(r.state)&&r.retired===(r.state==='RETIRED')&&Array.isArray(r.tags)&&equal([...r.tags].sort(),wanted)&&new Set(wanted).size===wanted.length,'CONTROL_RECOVERY_WORKER_ROW');
   if(r.container!==null)container(plan,slot.processInstanceId,r.container);
   need(r.state!=='RETIRED'||r.container!==null,'CONTROL_RECOVERY_WORKER_ROW');ids.add(r.incarnation);nonces.add(r.nonce);
  }
  need(rows.filter(r=>r.state!=='RETIRED').length<=slot.maximumOutstandingGenerations,'CONTROL_RECOVERY_WORKER_GENERATIONS');
 }

 for(const r of book.controlLeases){
  need(exact(r,['state','class','credits','incarnation','nonce','tags','intentSha256','planSha256','source','principal','container','stopped'])&&CLASSES.includes(r.class)&&['ISSUED','BOUND','UNKNOWN','CLOSED'].includes(r.state)&&r.credits===1&&matches(HEX32,r.incarnation)&&matches(HEX32,r.nonce)&&r.incarnation!==r.nonce&&!ids.has(r.incarnation)&&!nonces.has(r.nonce)&&matches(HEX64,r.intentSha256)&&equal(r.tags,[tag(r.class,r.incarnation)])&&r.planSha256===plan.sha256&&equal(r.source,plan.source)&&equal(r.principal,plan.controlRecovery.classes[r.class].principal),'CONTROL_RECOVERY_ROW');
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
 validate(plan,book);need(exact(descriptor,['class','intentSha256'])&&CLASSES.includes(descriptor.class)&&matches(HEX64,descriptor.intentSha256),'CONTROL_RECOVERY_DESCRIPTOR');
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
// Physical admission is core version2; control metadata remains private to the
// fixed entry. The action is sealed separately, never embedded caller launch data.
function capability(className){
 need(CLASSES.includes(className),'CONTROL_RECOVERY_CLASS');
 return {[className]:{kind:'pool',poolMax:1,maxInstances:1,metadata:{requestedMaximum:1,source:'deploy/multitenant/'+className+'-entry.js',configurationSource:'fixed-controller-control'}}};
}
function ticket(plan,book,row,expected,files){
 validate(plan,book);need(book.controlLeases.includes(row)&&row.state==='ISSUED','CONTROL_RECOVERY_TICKET');
 need(exact(expected,['source','project','workingDirectory','imageId'])&&equal(expected.source,plan.source)&&matches(/^[a-z][a-z0-9-]{0,62}$/,expected.project)&&typeof expected.workingDirectory==='string'&&expected.workingDirectory.startsWith('/')&&matches(/^sha256:[a-f0-9]{64}$/,expected.imageId),'CONTROL_RECOVERY_CUSTODY');
 need(files&&typeof files==='object'&&!Array.isArray(files)&&Object.keys(files).length>0&&Object.keys(files).length<=8&&Object.entries(files).every(([name,hash])=>/^[a-z][a-z0-9-]*\.json$/.test(name)&&typeof hash==='string'&&matches(HEX64,hash)),'CONTROL_RECOVERY_FILES');
 return {version:2,workerDatabase:structuredClone(plan.workerDatabase),processInstanceId:row.class,incarnation:row.incarnation,nonce:row.nonce,planSha256:plan.sha256,source:structuredClone(plan.source),pgResourceId:plan.resource.pgResourceId,resourceAliases:structuredClone(plan.resource.aliases),capabilities:capability(row.class),directGroups:{},cold:{activeLimit:1,pendingLimit:1,minDelayMs:0,maxDelayMs:0},control:{version:2,class:row.class,intentSha256:row.intentSha256,resourceEpoch:epoch(plan),expected:structuredClone(expected),principal:structuredClone(row.principal),files:structuredClone(files)}};
}
function gate(plan,book,row){validate(plan,book);need(book.controlLeases.includes(row)&&row.state==='BOUND','CONTROL_RECOVERY_BINDING');return {version:2,class:row.class,incarnation:row.incarnation,nonce:row.nonce,intentSha256:row.intentSha256,container:structuredClone(row.container)};}
function close(plan,book,row,receipt,actual,observation){
 validate(plan,book);need(book.controlLeases.includes(row)&&row.state==='BOUND'&&equal(actual,row.container),'CONTROL_RECOVERY_CLOSURE');
 need(exact(receipt,['version','kind','class','incarnation','nonce','planSha256','source','intentSha256','container','outcome','result','quiescence'])&&receipt.version===2&&receipt.kind==='controlled-operation-complete'&&receipt.class===row.class&&receipt.incarnation===row.incarnation&&receipt.nonce===row.nonce&&receipt.planSha256===plan.sha256&&equal(receipt.source,plan.source)&&receipt.intentSha256===row.intentSha256&&equal(receipt.container,row.container)&&['COMPLETED','REFUSED'].includes(receipt.outcome),'CONTROL_RECOVERY_RECEIPT');
 const a=receipt.quiescence;
 need(a&&a.processInstanceId===row.class&&a.incarnation===row.incarnation&&a.nonce===row.nonce&&a.planSha256===plan.sha256&&equal(a.source,plan.source)&&a.constructorsFrozen===true&&a.pendingConnects===0&&a.liveConnections===0&&a.unconfirmedCleanup===false&&a.cleanShutdown===true&&equal(a.tags,row.tags),'CONTROL_RECOVERY_QUIESCENCE');
 B.observedResourceMatches(plan,observation.resource);
 need(equal(observation.tags,row.tags.map(applicationName=>({applicationName,count:0}))),'CONTROL_RECOVERY_BACKENDS');
 row.state='CLOSED'; // Outcome belongs to the immutable receipt, never the exact ledger row.
}
module.exports=Object.freeze({CLASSES,principal,intent,tag,validate,ledger,allocate,bound,uncertain,stopped,known,occupancy,capability,ticket,gate,close});
