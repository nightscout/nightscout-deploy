'use strict';
// Loaded only after the ordinary private environment reader. No observer,
// constructor, SQL, or file write is added to an already-running tenant path.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{isDeepStrictEqual:equal}=require('node:util');
const files=require('./connection-budget-files'),B=require('./connection-budget');
let selected=null;
const need=(v,c)=>{if(!v)throw Object.assign(new Error(c),{code:c});};
function install(env=process.env){
 need(!env.NS_CONNECTION_BUDGET_UNPLANNED_PROCESS,'CONNECTION_BUDGET_UNPLANNED_PROCESS');
 if(!env.NS_CONNECTION_BUDGET_FILE){need(!env.NS_CONNECTION_BUDGET_PLAN_FILE&&!env.NS_CONNECTION_BUDGET_CLAIM_DIR,'CONNECTION_BUDGET_PARTIAL_SELECTION');return null;}
 need(!selected&&env.NS_CONNECTION_BUDGET_PLAN_FILE&&env.NS_CONNECTION_BUDGET_CLAIM_DIR,'CONNECTION_BUDGET_PARTIAL_SELECTION');
 const plan=files.read(env.NS_CONNECTION_BUDGET_PLAN_FILE),{sha256,...body}=plan;
 if(plan.version===2)require('./physical-ticket-receiver').workerPlan(plan);
 need(plan.source?.coreCommit===B.REVIEWED_CORE_COMMIT,'CONNECTION_BUDGET_UNREVIEWED_SOURCE');
 need([1,2].includes(plan.version),'CONNECTION_BUDGET_PLAN_VERSION');
 need(B.hash(body)===sha256&&plan.kind==='controlled-connection-budget-plan','CONNECTION_BUDGET_PLAN_DIGEST');
 const ticket=files.read(env.NS_CONNECTION_BUDGET_FILE);
 need(ticket.version===plan.version,'CONNECTION_BUDGET_TICKET_VERSION');
 if(plan.version===2)require('./physical-ticket-receiver').ticket(ticket);
 const slot=plan.slots.find(s=>s.processInstanceId===ticket.processInstanceId);
 need(slot&&ticket.planSha256===sha256&&equal(ticket.source,plan.source)&&equal(ticket.capabilities,slot.capabilities)&&equal(ticket.directGroups,slot.directGroups)&&equal(ticket.cold,slot.cold)&&ticket.pgResourceId===plan.resource.pgResourceId&&equal(ticket.resourceAliases,plan.resource.aliases)&&/^[a-f0-9]{32}$/.test(ticket.nonce)&&/^[a-f0-9]{32}$/.test(ticket.incarnation),'CONNECTION_BUDGET_SLOT_CHANGED');
 if(plan.version===2){
  const W=require('./worker-database');W.identity(plan.workerDatabase);W.identity(ticket.workerDatabase);
  need(equal(ticket.workerDatabase,plan.workerDatabase),'CONNECTION_BUDGET_WORKER_DATABASE');
 }else need(!Object.hasOwn(ticket,'workerDatabase'),'CONNECTION_BUDGET_TICKET_VERSION');
 need(require('../../lib/server/serve/pool-config').startupConcurrency(env)===slot.startupConcurrency,'CONNECTION_BUDGET_STARTUP_CHANGED');
 need(env.NS_SOURCE_COMMIT===plan.source.coreCommit,'CONNECTION_BUDGET_IMAGE_SOURCE');
 const imageFile=fs.openSync(path.join(__dirname,'.image-source.json'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let imageSource;try{const stat=fs.fstatSync(imageFile);need(stat.isFile()&&stat.size<=512,'CONNECTION_BUDGET_IMAGE_BINDING');const bytes=Buffer.alloc(513),length=fs.readSync(imageFile,bytes,0,bytes.length,0);need(length<=512,'CONNECTION_BUDGET_IMAGE_BINDING');imageSource=JSON.parse(bytes.subarray(0,length));}finally{fs.closeSync(imageFile);}
 need(imageSource.version===1&&imageSource.coreCommit===plan.source.coreCommit&&imageSource.deployCommit===plan.source.deployCommit&&Object.keys(imageSource).sort().join(',')==='coreCommit,deployCommit,version','CONNECTION_BUDGET_IMAGE_BINDING');
 const claim=files.directory(env.NS_CONNECTION_BUDGET_CLAIM_DIR),prefix=ticket.incarnation;
 try{
  files.writeAt(claim,'claim-'+prefix+'.json',{kind:'one-use-connection-budget-claim',planSha256:sha256,source:plan.source,processInstanceId:ticket.processInstanceId,incarnation:ticket.incarnation,nonce:ticket.nonce},{exclusive:true});
  const admission=require('../../lib/storage/connection-admission');
  const tags=Object.keys(ticket.capabilities).map(k=>admission.applicationTag(ticket,k)).sort();
  // Full declared process credits are durable in the controller ledger;
  // constructor accounting stays in memory, with no per-call disk journal.
  admission.install(ticket,{onState(){},onQuiescent(state){
   need(state.planSha256===sha256&&state.processInstanceId===ticket.processInstanceId&&state.incarnation===ticket.incarnation&&state.nonce===ticket.nonce&&equal(state.source,plan.source)&&state.constructorsFrozen===true&&state.pendingConnects===0&&state.liveConnections===0&&state.unconfirmedCleanup===false&&state.cleanShutdown===true&&equal([...state.tags].sort(),tags),'CONNECTION_BUDGET_QUIESCENCE_UNPROVEN');
   files.writeAt(claim,'ack-'+prefix+'.json',state,{exclusive:true});
  }});
  selected={admission,claim,ticket};return selected;
 }catch(e){fs.closeSync(claim);throw e;}
}
function beginQuiesce(){selected?.admission.beginQuiesce();}
async function finalizeQuiescence(clean){if(!selected)return;await selected.admission.finalizeQuiescence(clean);}
module.exports={install,beginQuiesce,finalizeQuiescence};
