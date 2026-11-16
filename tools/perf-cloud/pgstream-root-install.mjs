// Required-port wiring at the EXISTING trusted root hook boundary. No CLI, new
// launcher, allocator, signing key, approval-file loader or default tool gateway.
//
// Current native hooks read sealed root plans/GOs; the owning chat, outside that
// process, reads the original user message. There is no installed native message
// reader in this source tree. The root host must install readOriginalUserMessage
// and immutable approval-request lookup; missing ports refuse. Test injections
// qualify source behavior only and are never a deployable authority configuration.
//
// lookupApprovalRequest must return the root-owned record captured when asking the
// EXISTING concrete approval question: purpose ('batch' or 'single-point'), intent,
// intentSha256, question, questionItemId, approvedAnswers, chatId, messageId,
// questionBinding:{intentSha256,questionSha256}. It must not resolve controller JSON
// or mutable packet content as authority. No new question/answer format is required.
//
// boundBatch reads the actual root inventory/configuration, not the caller's plan.
// The remaining ports reuse existing provider/key/guard/source-host observations
// and exact admit/delete/cleanup primitives. Their live installation is separate
// and remains UNMEASURED until the actual host supplies these trusted functions.
import {isDeepStrictEqual as equal} from 'node:util';
import {rootAdapter} from './pgstream-batch-root.mjs';
import {batchDigest,planBatch} from './pgstream-caller.mjs';

const need=(v,c)=>{if(!v)throw Error('PGCAL_ROOT_INSTALL_'+c);};
const clone=v=>structuredClone(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const providerIds=hosts=>Object.values(hosts).map(h=>String(h.providerId)).sort();
const required=['lookupApprovalRequest','readOriginalUserMessage','boundBatch',
  'beforeAllocation','observeCell','observeAbsence','requestOwnedCleanup',
  'lookupPoint','admit','delete'];

// Pure binding helper for the root's existing approval-request record. It does
// not authorize anything, write a receipt or fetch an original user message.
export const approvalQuestionBinding=(intent,question)=>({intentSha256:batchDigest(intent),questionSha256:batchDigest(question)});

function originalApproval(response,request){
  // Accept the connected reader's complete tool result, not a supplied approval
  // boolean or a relay pretending to be a user message.
  let data=response;
  if(Array.isArray(response?.content)){
    const text=response.content.find(c=>c.type==='text');need(text,'ORIGINAL_READ_SHAPE');
    try{data=JSON.parse(text.text);}catch{throw Error('PGCAL_ROOT_INSTALL_ORIGINAL_READ_SHAPE');}
  }
  need(data?.thread?.id===request.chatId&&Array.isArray(data.turns),'ORIGINAL_CHAT');
  const turns=[...data.turns];
  let chronologyKnown=true;
  if(data.page?.order==='newest_first')turns.reverse();
  else if(data.page?.order==='oldest_first'||turns.length<=1){/* source order */}
  else if(turns.every(t=>Number.isFinite(t.startedAt))&&new Set(turns.map(t=>t.startedAt)).size===turns.length)turns.sort((a,b)=>a.startedAt-b.startedAt);
  else chronologyKnown=false;
  const items=turns.flatMap(t=>t.items??[]),matching=items.filter(m=>m.id===request.messageId);
  need(matching.length===1&&matching[0].type==='userMessage','ORIGINAL_USER_REQUIRED');
  const message=matching[0],parts=(message.content??[]).filter(c=>c.type==='text').map(c=>c.text);
  need(parts.length>0,'ORIGINAL_USER_TEXT');
  const text=parts.join('\n').trim(),tag='<send_user_message_question_reply>',end='</send_user_message_question_reply>';
  let answered=false;
  if(text.startsWith(tag)&&text.endsWith(end)){
    let replies;try{replies=JSON.parse(text.slice(tag.length,-end.length).trim());}catch{throw Error('PGCAL_ROOT_INSTALL_ORIGINAL_REPLY_SHAPE');}
    need(Array.isArray(replies),'ORIGINAL_REPLY_SHAPE');
    const reply=replies.filter(r=>r.questionItemId===request.questionItemId);
    answered=reply.length===1&&reply[0].question===request.question&&request.approvedAnswers.includes(reply[0].answer);
  }else{
    // A historical match is not a pending question. Free text must follow the
    // nearest conversational item, which must uniquely be this exact question.
    // An intervening question/reply or unknown order is ambiguous and refuses.
    // Structured replies above instead retain their explicit question identity.
    const before=items.slice(0,items.indexOf(message));
    const conversation=before.filter(m=>m.type==='agentMessage'||m.type==='userMessage');
    const pending=conversation.at(-1),questions=conversation.filter(m=>m.type==='agentMessage'&&m.text===request.question);
    answered=chronologyKnown&&pending?.type==='agentMessage'&&pending.text===request.question&&questions.length===1&&request.approvedAnswers.includes(text);
  }
  need(answered,'EXACT_APPROVAL_REQUIRED');
  return {kind:'direct-user-message',chatId:request.chatId,messageId:request.messageId,
    originalMessageSha256:batchDigest(message),questionSha256:batchDigest(request.question)};
}

export function installRootHook({ports,ledger,now=()=>Date.now()/1000,newToken}){
  need(ports&&required.every(name=>typeof ports[name]==='function'),'MISSING_TRUSTED_PORT');
  ports=Object.freeze({...ports}); // the controller cannot replace installed readers
  need(typeof ledger?.transaction==='function','MISSING_LEDGER');
  const cache=new Map(),requests=new Map(),admittedPlans=new Map();
  async function reviewed(id,purpose){
    // Only an identifier crosses from the controller. References, question,
    // intent, answer vocabulary and reader capability all come from the root.
    const request=clone(await ports.lookupApprovalRequest(id));
    need(request&&request.purpose===purpose,'AUTHORITY_PURPOSE');
    need(typeof request.chatId==='string'&&!!request.chatId&&typeof request.messageId==='string'&&!!request.messageId&&typeof request.question==='string'&&!!request.question&&typeof request.questionItemId==='string'&&Array.isArray(request.approvedAnswers)&&request.approvedAnswers.length>0&&request.approvedAnswers.every(a=>typeof a==='string'&&!!a),'APPROVAL_REQUEST');
    need(request.intent?.id===id&&hash(request.intentSha256)&&request.intentSha256===batchDigest(request.intent)&&equal(request.questionBinding,approvalQuestionBinding(request.intent,request.question)),'INTENT_QUESTION_BINDING');
    const fingerprint=batchDigest(request);need(!requests.has(id)||requests.get(id)===fingerprint,'APPROVAL_REQUEST_CHANGED');requests.set(id,fingerprint);
    if(cache.has(id))return clone(cache.get(id));
    const response=await ports.readOriginalUserMessage({chatId:request.chatId,messageId:request.messageId});
    const source=originalApproval(response,request),record={source,intent:request.intent,intentSha256:request.intentSha256};
    record.receiptSha256=batchDigest(record);cache.set(id,record);return clone(record);
  }
  async function bound(id){
    const approval=await reviewed(id,'batch');
    const batch=clone(await ports.boundBatch(id));need(batch?.id===id,'ROOT_BOUND_BATCH');
    const plan=planBatch(batch,now());
    need(equal(plan.payload,approval.intent.payload)&&equal(plan.envelope,approval.intent.envelope),'ROOT_BOUND_PAYLOAD');
    const old=admittedPlans.get(id);need(!old||equal(old,plan),'BOUND_BATCH_CHANGED');
    const cells={};
    for(const cell of plan.cells){
      const expected=approval.intent.cells.find(c=>c.id===cell.id);
      need(expected&&cell.namespace===expected.namespace&&cell.nonce===expected.nonce&&equal(cell.target,expected.target)&&equal(cell.resources,expected.resources)&&cell.expiresAt<=expected.cleanupAt,'ROOT_BOUND_CELL');
      const observation=await ports.observeCell({batchId:id,cellId:cell.id});
      need(observation?.sourceHostBindingVerified===true&&hash(observation.sourceHostBindingSha256)&&Array.isArray(observation.providerIds)&&equal([...observation.providerIds].sort(),providerIds(cell.hosts)),'ROOT_BOUND_OBSERVATION');
      cells[cell.id]={cellSha256:cell.cellSha256,providerIds:providerIds(cell.hosts),sourceHostBindingSha256:observation.sourceHostBindingSha256};
    }
    need(plan.cells.length===approval.intent.cells.length,'ROOT_BOUND_COHORT');admittedPlans.set(id,clone(plan));
    const record={intentSha256:approval.intentSha256,planSha256:plan.sha256,projectionSha256:batchDigest(plan),cells};
    record.receiptSha256=batchDigest(record);return record;
  }
  const adapter=rootAdapter({ledger,now,...(newToken?{newToken}:{}),
    authority:{reviewedIntent:id=>reviewed(id,'batch'),boundPlan:bound},
    custody:{beforeAllocation:r=>ports.beforeAllocation(clone(r)),observe:r=>ports.observeCell(clone(r)),absence:r=>ports.observeAbsence(clone(r))},
    cleanupOwned:r=>ports.requestOwnedCleanup(clone(r))});
  function rejectAuthorityFields(request){
    need(request&&typeof request==='object'&&!Array.isArray(request),'REQUEST_SHAPE');
    for(const name of ['approved','authority','approval','intent','originalUserMessage','trustedReader'])need(!Object.hasOwn(request,name),'REQUEST_AUTHORITY_FORBIDDEN');
  }
  async function legacy(action,request){
    const point=clone(await ports.lookupPoint(request.cloudId));
    need(point&&['batch','single-point'].includes(point.purpose)&&point.cloudId===request.cloudId&&(action==='delete'?request.expiresAt===point.expiresAt:point.nonce===request.nonce)&&Array.isArray(point.providerIds)&&request.hosts&&equal(point.providerIds.toSorted(),providerIds(request.hosts)),'LEGACY_POINT_CUSTODY');
    if(action==='admit'){
      need(now()<point.lastNewPointAt,'LEGACY_POINT_EXPIRED');
      await reviewed(point.approvalId,point.purpose); // single-point stays single-point
    }
    // Delete remains possible after approval expiry and does not import authority.
    // Existing primitives still own exact NIC/provider/seal/cleanup validation.
    return ports[action](clone(request),point);
  }
  async function dispatch(action,request){
    need(['admit-batch','reserve-cell','release-cell','admit','delete'].includes(action),'UNSUPPORTED_ACTION');
    rejectAuthorityFields(request);
    if(action==='admit'||action==='delete')return legacy(action,request);
    if(action==='admit-batch'){
      const trusted=await bound(request.id);
      need(trusted.projectionSha256===batchDigest(request),'CALLER_BOUND_PLAN_CHANGED');
    }
    return adapter.dispatch(action,clone(request));
  }
  // Host-side preparation only: not reachable by provider-hook argv/stdin.
  // Existing root provider preparation calls these around its unchanged allocator.
  return {dispatch,prepare:{
    reviewBatch:id=>reviewed(id,'batch'),
    reserveBeforeAllocation:adapter.reserveBeforeAllocation,
    markCreateAttempt:adapter.markCreateAttempt,
    bindAllocation:adapter.bindAllocation,
    cancelBatch:adapter.cancelBatch,
  }};
}
