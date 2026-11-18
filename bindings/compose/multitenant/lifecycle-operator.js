'use strict';
// Controller-private typed lease. No credentials, arbitrary SQL or caller tags.
const crypto=require('node:crypto'),{isDeepStrictEqual:equal}=require('node:util');
const B=require('./connection-budget');
const need=(v,c)=>{if(!v)throw Object.assign(new Error(c),{code:c});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&equal(Object.keys(v).sort(),[...keys].sort());
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NAME='lifecycle-operator';
function intent(v){need(exact(v,['version','command','tenant',...(v?.command==='resume'?['claimId']:[])])&&v.version===1&&['inspect','resume'].includes(v.command)&&UUID.test(v.tenant)&&v.tenant!=='00000000-0000-0000-0000-000000000000'&&(v.command!=='resume'||UUID.test(v.claimId)),'LIFECYCLE_OPERATOR_INTENT');return structuredClone(v);}
function tag(incarnation){return 'nscb:'+incarnation+':'+crypto.createHash('sha256').update(NAME).digest('hex').slice(0,16);}
function enabled(plan){return plan.lifecycleOperator?.version===1;}
function validate(plan,book){
 need(book&&(book.version===1||book.version===2)&&book.planSha256===plan.sha256&&equal(book.resourceEpoch,[plan.resource.systemIdentifier,plan.resource.postmasterStartedAt])&&book.slots&&equal(Object.keys(book.slots).sort(),plan.slots.map(s=>s.processInstanceId).sort()),'CONNECTION_ADMISSION_LEDGER_CHANGED');
 need(enabled(plan)?book.version===2&&Array.isArray(book.controlLeases):book.version===1&&!Object.hasOwn(book,'controlLeases'),'LIFECYCLE_OPERATOR_LEDGER_VERSION');
 if(book.version===2){
  need(book.controlLeases.length<=4096,'LIFECYCLE_OPERATOR_LEDGER');
  const ids=new Set();
  for(const r of book.controlLeases){
   need(r&&['ISSUED','BOUND','UNKNOWN','CLOSED'].includes(r.state)&&/^[a-f0-9]{32}$/.test(r.incarnation)&&/^[a-f0-9]{32}$/.test(r.nonce)&&!ids.has(r.incarnation)&&equal(r.tags,[tag(r.incarnation)])&&r.intentSha256===B.hash(intent(r.intent))&&r.planSha256===plan.sha256&&equal(r.source,plan.source)&&r.credits===1,'LIFECYCLE_OPERATOR_LEDGER');
   need((r.state==='ISSUED'&&r.container===null)||r.state==='UNKNOWN'||r.container&&r.container.service===NAME&&equal(r.container.source,plan.source),'LIFECYCLE_OPERATOR_LEDGER');ids.add(r.incarnation);
  }
  need(book.controlLeases.filter(r=>r.state!=='CLOSED').length<=1,'LIFECYCLE_OPERATOR_LEDGER');
 }
 return book;
}
function known(plan,book){validate(plan,book);return [...new Set([...Object.values(book.slots).flat().filter(r=>r.state!=='RETIRED').flatMap(r=>r.tags),...(book.controlLeases||[]).filter(r=>r.state!=='CLOSED').flatMap(r=>r.tags)])].sort();}
function ledger(plan){const book=B.ledger(plan);if(enabled(plan)){book.version=2;book.controlLeases=[];}return book;}
function allocate(plan,book,value){validate(plan,book);const request=intent(value);
 need(enabled(plan)&&plan.resource.allowances.controlRecovery>=1,'LIFECYCLE_OPERATOR_DISABLED');
 need(!book.controlLeases.some(r=>r.state!=='CLOSED'),'LIFECYCLE_OPERATOR_CREDIT_HELD');
 need(book.controlLeases.length<4096,'LIFECYCLE_OPERATOR_HISTORY_EXHAUSTED');
 need(plan.lifecycleOperator.tenants.includes(request.tenant),'LIFECYCLE_OPERATOR_TENANT');
 const incarnation=crypto.randomBytes(16).toString('hex'),nonce=crypto.randomBytes(16).toString('hex');
 need(![...book.controlLeases,...Object.values(book.slots).flat()].some(r=>r.incarnation===incarnation),'LIFECYCLE_OPERATOR_INCARNATION');
 const row={state:'ISSUED',credits:1,incarnation,nonce,tags:[tag(incarnation)],intent:request,intentSha256:B.hash(request),planSha256:plan.sha256,source:structuredClone(plan.source),container:null};
 book.controlLeases.push(row);return row;
}
function ticket(plan,row,expected,files){return {version:1,processInstanceId:NAME,incarnation:row.incarnation,nonce:row.nonce,planSha256:plan.sha256,source:plan.source,pgResourceId:plan.resource.pgResourceId,resourceAliases:plan.resource.aliases,
 capabilities:{[NAME]:{kind:'pool',poolMax:1,maxInstances:1,metadata:{requestedMaximum:1,source:'deploy/multitenant/lifecycle-operator-entry.js',configurationSource:'fixed-controller-operator'}}},directGroups:{},cold:{activeLimit:1,pendingLimit:1,minDelayMs:0,maxDelayMs:0},
 operator:{intent:row.intent,intentSha256:row.intentSha256,resourceEpoch:[plan.resource.systemIdentifier,plan.resource.postmasterStartedAt],expected,principal:plan.lifecycleOperator.principal,files}};}
function close(plan,row,receipt,container,observation){
 need(row.state==='BOUND'&&row.container&&equal(container,row.container),'LIFECYCLE_OPERATOR_CLOSURE');
 need(exact(receipt,['version','kind','incarnation','nonce','planSha256','source','intentSha256','container','outcome','result','quiescence'])&&receipt.version===1&&receipt.kind==='lifecycle-operator-complete'&&receipt.incarnation===row.incarnation&&receipt.nonce===row.nonce&&receipt.planSha256===plan.sha256&&equal(receipt.source,plan.source)&&receipt.intentSha256===row.intentSha256&&equal(receipt.container,row.container)&&['COMPLETED','REFUSED'].includes(receipt.outcome),'LIFECYCLE_OPERATOR_RECEIPT');
 const a=receipt.quiescence;
 need(a&&a.processInstanceId===NAME&&a.incarnation===row.incarnation&&a.nonce===row.nonce&&a.planSha256===plan.sha256&&equal(a.source,plan.source)&&a.constructorsFrozen===true&&a.pendingConnects===0&&a.liveConnections===0&&a.unconfirmedCleanup===false&&a.cleanShutdown===true&&equal(a.tags,row.tags),'LIFECYCLE_OPERATOR_QUIESCENCE');
 B.observedResourceMatches(plan,observation.resource);
 need(equal(observation.tags,row.tags.map(applicationName=>({applicationName,count:0}))),'LIFECYCLE_OPERATOR_BACKENDS');
 row.state='CLOSED';row.outcome=receipt.outcome;
}
module.exports={NAME,intent,enabled,validate,known,ledger,allocate,ticket,close,tag};
