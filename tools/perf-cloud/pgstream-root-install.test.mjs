// Entirely inert installed-root ports. No real reader, provider, file ledger,
// key, guard, SSH, export or native hook is installed by this test fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installRootHook,approvalQuestionBinding} from './pgstream-root-install.mjs';
import {batchDigest,planBatch,sourceFiles} from './pgstream-caller.mjs';
import {PINS,CADENCE,PROFILE} from './pgstream-calibration.mjs';
const H='a'.repeat(64),J='b'.repeat(64),N='c'.repeat(32);
function batchFixture(){
  const hosts=Object.fromEntries([['sut','10.20.1.2','192.0.2.2'],['driver','10.20.1.3','192.0.2.3']].map(([role,privateIPv4,publicIPv4])=>[role,{providerId:'synthetic-'+role,privateIPv4,publicIPv4,sshHostKeySha256:H,cpuCores:4,ramBytes:8000000000,networkBitsPerSecond:1000000000,allocationSource:'provider-inventory',headroom:{measurement:'UNMEASURED'},provider:'synthetic',region:'test1',size:'test4',name:'owned-'+role,hourlyMicrousd:500000}]));
  const transport={interface:'ens7',mac:'02:00:00:00:00:01',approvedAddress:'10.20.1.2',approvalReference:'synthetic-root-binding'};
  const resourcePlan={reference:'synthetic',tenants:10,logicalPollingClients:20,hosts:Object.fromEntries(Object.entries(hosts).map(([k,h])=>[k,{providerId:h.providerId,cpuCores:h.cpuCores,ramBytes:h.ramBytes}]))};
  const cadence={...CADENCE,offeredRps:7};
  const receipt={version:1,kind:'joined-diagnostic',status:'AUTHORIZED_DIAGNOSTIC',functionalAcceptanceAtAuthorization:'PENDING',pair:{core:PINS.core,deploy:PINS.deploy},imageId:PINS.app,instrument:H,completionContract:'evaluator-work-v2',limits:{tenants:10,apiReplicas:1,trafficSeconds:310},remoteProfile:PROFILE,remoteExtensionSha256:H,remoteTransport:transport,remoteReportMode:'discovery',remoteWorkload:{cadence,primerConcurrency:1,resourcePlan}};
  const spec={reportMode:'discovery',profile:PROFILE,completionContract:'evaluator-work-v2',diagnostics:'on',paidT0:1000,lastNewPointAt:2800,tenants:10,logicalPollingClients:20,pins:PINS,cadence,extensionSha256:H,helperCommit:'d'.repeat(40),transport,port:18080,controllerIPv4:'192.0.2.1',runId:'synthetic-run',cloudId:'synthetic-run-'+'c'.repeat(12),nonce:N,expiresAt:4600,k6Image:'grafana/k6@sha256:'+J,budget:{rootOwned:true,totalUsd:3.5},hosts,receipt,sutInbound:[{protocol:'tcp',port:22,sourceIPv4:'192.0.2.1'},{protocol:'tcp',port:18080,sourceIPv4:'10.20.1.3',sourceProviderId:'synthetic-driver'}],driverLimits:{fdSoft:65536,fdHard:65536,k6PreallocatedVUsFormula:'min(400,ceil(rate*1000/arrivalCycleMs)*2+5)',k6MaxVUsPerScenario:800,measurement:'UNMEASURED'},primerConcurrency:1,resourcePlan,sourceQualification:{path:'/synthetic/qualification.json',sha256:H},pgstreamProducer:'canonical-262-with-pool-initialize',providerTokenOnHosts:false};
  const cell={id:'cell-one',namespace:'owned-cell',ports:[18080],subnets:['10.20.1.0/24'],target:{kind:'remote',provider:'synthetic',region:'test1',size:'test4',namePrefix:'owned',maxResources:2},workSeconds:1800,cleanupSeconds:1800,offeredRps:7,resources:{millicpus:8000,memoryBytes:16000000000,heapMiB:1024,hourlyMicrousd:1000000,totalMicrousd:3500000,liveResources:2},config:spec};
  return {version:1,id:'synthetic-batch',payload:{source:{core:PINS.core,deploy:PINS.deploy},image:PINS.app,helper:H,files:sourceFiles('sut').map(n=>({path:'cell-one/'+n,sha256:H}))},envelope:{maxConcurrent:1,maxLiveResources:2,maxOfferedRps:7,millicpus:8000,memoryBytes:16000000000,heapMiB:1024,hourlyMicrousd:1000000,totalMicrousd:3500000,cleanupAt:4600,workload:{tenants:[1,10],offeredRps:[1,7],durationSeconds:[1,310],probeEveryMs:[1,300000],hotFactor:[1,1],faultCases:[]}},cells:[cell]};
}
function fixture(){
  const batch=batchFixture(),cell=batch.cells[0],intent={version:1,id:batch.id,payload:batch.payload,envelope:batch.envelope,cells:[{id:cell.id,namespace:cell.namespace,nonce:cell.config.nonce,target:cell.target,resources:cell.resources,creationNotBefore:1000,creationNotAfter:1100,cleanupAt:4600,cost:{computeUpperMicrousd:1500000,feesEgressCleanupUpperMicrousd:2000000}}]};
  const request={purpose:'batch',intent,intentSha256:batchDigest(intent),question:'Approve the concrete [existing packet](/synthetic/packet): its named hosts, manifested source and $3.50 ceiling?',questionItemId:'["request_user_input_async","synthetic-question",0]',approvedAnswers:['Approve this exact packet'],chatId:'synthetic-chat',messageId:'synthetic-user'};request.questionBinding=approvalQuestionBinding(intent,request.question);
  const answer={questionItemId:request.questionItemId,question:request.question,answer:'Approve this exact packet'};
  const response={thread:{id:request.chatId},turns:[{items:[{type:'userMessage',id:request.messageId,content:[{type:'text',text:'<send_user_message_question_reply>\n'+JSON.stringify([answer])+'\n</send_user_message_question_reply>'}]}]}]};
  let state={maximumAggregateHourlyUSD:2,maximumTotalUSD:16,currentAggregateHourlyUSD:0,reservedAggregateHourlyUSD:0,totalReservedUpperUSD:7,uncommittedUpperBudgetUSD:9,hardAllPaidResourcesAbsentUTC:new Date(5000*1000).toISOString()};
  const ledger={transaction:async f=>{const v=structuredClone(state),out=await f(v);state=v;return out;}};
  const ids=['synthetic-driver','synthetic-sut'],mutable={clock:1000,request,response,batch,pointPurpose:'batch',readCount:0,admitCount:0,deleteCount:0,cleanupCount:0,sourceOK:true};
  const guard={status:'ARMED',namespace:cell.namespace,nonce:N,observedAt:1000,pid:123,startTicks:'111',sameBirth:true,keyCustody:true,cleanupAt:4500,receiptSha256:H,providerIds:[]};
  const ports={
    lookupApprovalRequest:async()=>structuredClone(mutable.request),
    readOriginalUserMessage:async ref=>{assert.deepEqual(ref,{chatId:'synthetic-chat',messageId:'synthetic-user'});mutable.readCount++;return {content:[{type:'text',text:JSON.stringify(mutable.response)}]};},
    boundBatch:async()=>structuredClone(mutable.batch),
    beforeAllocation:async()=>structuredClone(guard),
    observeCell:async()=>({namespace:cell.namespace,nonce:N,targetMatches:true,sourceHostBindingVerified:mutable.sourceOK,sourceHostBindingSha256:J,providerIds:ids,guard:{...guard,providerIds:ids}}),
    observeAbsence:async({record})=>({namespace:cell.namespace,nonce:N,observedAt:mutable.clock,receiptSha256:H,providerAbsent:true,providerKeyAbsent:true,localKeyFilesAbsent:true,guardSameBirthAbsent:true,guardGroupAbsent:true,guardPid:123,guardStartTicks:'111',providerIds:record.providerIds}),
    requestOwnedCleanup:async()=>{mutable.cleanupCount++;},
    lookupPoint:async()=>({cloudId:cell.config.cloudId,nonce:N,providerIds:ids,expiresAt:4600,lastNewPointAt:2800,approvalId:batch.id,purpose:mutable.pointPurpose}),
    admit:async()=>{mutable.admitCount++;return {status:'APPLIED'};},
    delete:async()=>{mutable.deleteCount++;return {status:'DELETED',providerIds:ids};},
  };
  const hook=installRootHook({ports,ledger,now:()=>mutable.clock,newToken:()=> 'synthetic-reservation'});
  return {hook,ports,ledger,mutable,request,response,batch,intent,cell,ids,state:()=>structuredClone(state)};
}

test('production refuses missing original reader; no request JSON installs authority',async()=>{
  const f=fixture(),ports={...f.ports};delete ports.readOriginalUserMessage;assert.throws(()=>installRootHook({ports,ledger:f.ledger}),/MISSING_TRUSTED_PORT/);
  for(const action of ['approve','import-intent','install-reader'])await assert.rejects(f.hook.dispatch(action,{approved:true}),/UNSUPPORTED_ACTION/);
  await assert.rejects(f.hook.dispatch('admit-batch',{id:f.batch.id,approved:true,originalUserMessage:f.response}),/REQUEST_AUTHORITY_FORBIDDEN/);assert.equal(f.mutable.readCount,0);assert.equal(f.state().totalReservedUpperUSD,7);
});

test('existing exact question reply imports original user evidence and composes the whole root lifecycle',async()=>{
  const f=fixture();const approval=await f.hook.prepare.reviewBatch(f.batch.id);assert.equal(approval.source.kind,'direct-user-message');assert.equal(approval.source.messageId,'synthetic-user');assert.equal(f.mutable.readCount,1);
  const r=await f.hook.prepare.reserveBeforeAllocation(f.batch.id,f.cell.id);await f.hook.prepare.markCreateAttempt(f.batch.id,f.cell.id,r.token);await f.hook.prepare.bindAllocation(f.batch.id,f.cell.id,r.token);
  const plan=planBatch(f.batch,1000);assert.equal((await f.hook.dispatch('admit-batch',plan)).status,'ADMITTED');const lease=await f.hook.dispatch('reserve-cell',{batchId:f.batch.id,planSha256:plan.sha256,cell:f.cell});assert.equal(lease.token,r.token);assert.equal(f.mutable.readCount,1);
  assert.equal((await f.hook.dispatch('admit',f.cell.config)).status,'APPLIED');assert.equal(f.mutable.admitCount,1);
  assert.equal((await f.hook.dispatch('delete',{cloudId:f.cell.config.cloudId,hosts:f.cell.config.hosts,expiresAt:4600})).status,'DELETED');
  await f.hook.dispatch('release-cell',{batchId:f.batch.id,planSha256:plan.sha256,cellId:f.cell.id,token:r.token,providerIds:f.ids});assert.equal(f.state().currentAggregateHourlyUSD,0);assert.equal(f.state().reservedAggregateHourlyUSD,0);assert.equal(f.state().totalReservedUpperUSD,10.5);
});

test('agent relays, other chats, wrong question/answer and changed binding refuse before ledger/provider calls',async()=>{
  const changes=[f=>f.mutable.response.turns[0].items[0].type='agentMessage',f=>f.mutable.response.thread.id='other-chat',f=>f.mutable.request.question+=' changed',f=>f.mutable.request.approvedAnswers=['Keep deferred'],f=>f.mutable.request.questionBinding.intentSha256=J];
  for(const change of changes){const f=fixture();change(f);await assert.rejects(f.hook.prepare.reviewBatch(f.batch.id),/ORIGINAL_USER_REQUIRED|ORIGINAL_CHAT|INTENT_QUESTION_BINDING|EXACT_APPROVAL_REQUIRED/);assert.equal(f.state().totalReservedUpperUSD,7);assert.equal(f.mutable.admitCount+f.mutable.deleteCount,0);}
});

test('an existing free-text approval requires its actual preceding question',async()=>{
  const f=fixture();f.mutable.response.turns[0].items=[{type:'agentMessage',text:f.request.question},{type:'userMessage',id:'synthetic-user',content:[{type:'text',text:'Approve this exact packet'}]}];await f.hook.prepare.reviewBatch(f.batch.id);
  const missing=fixture();missing.mutable.response.turns[0].items[0].content[0].text='Approve this exact packet';await assert.rejects(missing.hook.prepare.reviewBatch(missing.batch.id),/EXACT_APPROVAL_REQUIRED/);
});

test('newest-first connected reads preserve preceding-question order across turns',async()=>{
  const f=fixture();f.mutable.response.page={order:'newest_first'};f.mutable.response.turns=[{startedAt:2000,items:[{type:'userMessage',id:'synthetic-user',content:[{type:'text',text:'Approve this exact packet'}]}]},{startedAt:1000,items:[{type:'agentMessage',text:f.request.question}]}];await f.hook.prepare.reviewBatch(f.batch.id);
  const future=fixture();future.mutable.response.page={order:'newest_first'};future.mutable.response.turns=[{startedAt:3000,items:[{type:'agentMessage',text:future.request.question}]},{startedAt:2000,items:[{type:'userMessage',id:'synthetic-user',content:[{type:'text',text:'Approve this exact packet'}]}]}];await assert.rejects(future.hook.prepare.reviewBatch(future.batch.id),/EXACT_APPROVAL_REQUIRED/);
});

test('declined answers and an original reply to another question do not authorize the intent',async()=>{
  for(const changed of [{answer:'Keep deferred'},{questionItemId:'other-question'},{question:'Another concrete action?'}]){
    const f=fixture(),reply={questionItemId:f.request.questionItemId,question:f.request.question,answer:'Approve this exact packet',...changed};f.mutable.response.turns[0].items[0].content[0].text='<send_user_message_question_reply>'+JSON.stringify([reply])+'</send_user_message_question_reply>';
    await assert.rejects(f.hook.prepare.reviewBatch(f.batch.id),/EXACT_APPROVAL_REQUIRED/);assert.equal(f.state().totalReservedUpperUSD,7);assert.equal(f.mutable.admitCount,0);
  }
});

test('cached approval cannot be rebound to a changed root intent or old single-point authority',async()=>{
  const f=fixture();await f.hook.prepare.reviewBatch(f.batch.id);f.mutable.request.intent.envelope.totalMicrousd++;f.mutable.request.intentSha256=batchDigest(f.mutable.request.intent);f.mutable.request.questionBinding=approvalQuestionBinding(f.mutable.request.intent,f.mutable.request.question);await assert.rejects(f.hook.prepare.reviewBatch(f.batch.id),/APPROVAL_REQUEST_CHANGED/);
  const old=fixture();old.mutable.request.purpose='single-point';old.mutable.pointPurpose='single-point';await assert.rejects(old.hook.prepare.reviewBatch(old.batch.id),/AUTHORITY_PURPOSE/);assert.equal((await old.hook.dispatch('admit',old.cell.config)).status,'APPLIED');
});

test('caller projections and provider IDs cannot replace independently rooted source/host observations',async()=>{
  const f=fixture();const r=await f.hook.prepare.reserveBeforeAllocation(f.batch.id,f.cell.id);await f.hook.prepare.markCreateAttempt(f.batch.id,f.cell.id,r.token);await f.hook.prepare.bindAllocation(f.batch.id,f.cell.id,r.token);
  const plan=planBatch(f.batch,1000),bad=structuredClone(plan);bad.cells[0].ports=[9999];await assert.rejects(f.hook.dispatch('admit-batch',bad),/CALLER_BOUND_PLAN_CHANGED/);
  f.mutable.sourceOK=false;await assert.rejects(f.hook.dispatch('admit-batch',plan),/ROOT_BOUND_OBSERVATION/);f.mutable.sourceOK=true;await f.hook.dispatch('admit-batch',plan);
  const request=structuredClone(f.cell.config);request.hosts.driver.providerId='foreign';await assert.rejects(f.hook.dispatch('admit',request),/LEGACY_POINT_CUSTODY/);assert.equal(f.mutable.admitCount,0);
});

test('expired cleanup uses existing exact deletion primitive without renewing authority or adding a reader call',async()=>{
  const f=fixture();f.mutable.clock=6000;f.mutable.request=null;
  // lookupPoint is an immutable root custody record, not the now-expired request.
  await assert.rejects(f.hook.dispatch('admit',f.cell.config),/LEGACY_POINT_EXPIRED/);
  const out=await f.hook.dispatch('delete',{cloudId:f.cell.config.cloudId,hosts:f.cell.config.hosts,expiresAt:4600});assert.equal(out.status,'DELETED');assert.equal(f.mutable.readCount,0);assert.equal(f.mutable.deleteCount,1);
});
