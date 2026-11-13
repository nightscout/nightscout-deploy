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
 need(plan.source?.coreCommit===B.REVIEWED_CORE_COMMIT,'CONNECTION_BUDGET_UNREVIEWED_SOURCE');
 need(B.hash(body)===sha256&&plan.kind==='controlled-connection-budget-plan','CONNECTION_BUDGET_PLAN_DIGEST');
 const ticket=files.read(env.NS_CONNECTION_BUDGET_FILE),slot=plan.slots.find(s=>s.processInstanceId===ticket.processInstanceId);
 need(slot&&ticket.planSha256===sha256&&equal(ticket.source,plan.source)&&equal(ticket.capabilities,slot.capabilities)&&equal(ticket.directGroups,slot.directGroups)&&equal(ticket.cold,slot.cold)&&ticket.pgResourceId===plan.resource.pgResourceId&&equal(ticket.resourceAliases,plan.resource.aliases)&&/^[a-f0-9]{32}$/.test(ticket.nonce)&&/^[a-f0-9]{32}$/.test(ticket.incarnation),'CONNECTION_BUDGET_SLOT_CHANGED');
 need(require('../../lib/server/serve/pool-config').startupConcurrency(env)===slot.startupConcurrency,'CONNECTION_BUDGET_STARTUP_CHANGED');
 need(env.NS_SOURCE_COMMIT===plan.source.coreCommit,'CONNECTION_BUDGET_IMAGE_SOURCE');
 const overlay=JSON.parse(fs.readFileSync(path.join(__dirname,'.overlay.json'),'utf8'));
 need(overlay.deployCommit===plan.source.deployCommit,'CONNECTION_BUDGET_IMAGE_BINDING');
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
