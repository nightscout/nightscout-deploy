'use strict';
// Fixed one-shot process. The host opens its private start gate only after a
// durable exact-CID binding. No load-env, observer secret or worker ticket here.
const fs=require('node:fs'),path=require('node:path'),{isDeepStrictEqual:equal}=require('node:util');
const F=require('./connection-budget-files'),B=require('./connection-budget'),O=require('./lifecycle-operator'),C=require('./control-recovery'),W=require('./worker-database');
const need=(v,c)=>{if(!v)throw Object.assign(new Error(c),{code:c});};
const digest=file=>require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const contexts=new WeakSet();
function isContext(value){return contexts.has(value);}
// Fence every new dispatch, including readiness/cohort SQL and cleanup rollback.
// An outstanding dispatch may settle late; that poisons the whole execution.
function singlePool(pool,{check,late,verify}){
 let acquired=false;
 return Object.freeze({async connect(){
  check();need(!acquired,'LIFECYCLE_OPERATOR_SECOND_CONNECT');acquired=true;
  const client=await pool.connect();
  try{check();await verify(client);check();}catch(error){client.release(true);throw error;}
  const query=client.query.bind(client);
  client.query=function(...args){
   try{check();}catch(error){return Promise.reject(error);}
   let result;try{result=query(...args);}catch(error){throw error;}
   need(result&&typeof result.then==='function','LIFECYCLE_OPERATOR_QUERY_PROTOCOL');
   return result.then(value=>{try{check();}catch(error){late();throw error;}return value;},error=>{try{check();}catch(expired){late();throw expired;}throw error;});
  };
  return client;
 }});
}
async function execute({ticket,gate,action,config,env,admission,pg,clock=()=>process.hrtime.bigint(),onQuiescent}){
 const fresh=ticket?.version===2;
 if(fresh){const receiver=require('./physical-ticket-receiver');receiver.ticket(ticket,O.NAME);receiver.gate(gate,ticket);}
 const request=fresh?C.intent(O.NAME,action):O.intent(ticket?.operator?.intent),op=fresh?ticket.control:ticket.operator;
 if(fresh){
  need(op&&equal(Object.keys(op).sort(),['class','expected','files','intentSha256','principal','resourceEpoch','version'])&&op.version===2&&op.class===O.NAME,'CONTROL_RECOVERY_TICKET');
  const db=W.identity(ticket.workerDatabase);C.principal(op.principal);
  need(op.principal.database===db.database&&op.principal.databaseOid===db.databaseOid,'CONTROL_RECOVERY_WORKER_DATABASE');
  need(equal(ticket.capabilities,C.capability(O.NAME)),'CONTROL_RECOVERY_CAPABILITY');
  need(equal(gate,{version:2,class:O.NAME,incarnation:ticket.incarnation,nonce:ticket.nonce,intentSha256:op.intentSha256,container:gate.container}),'CONTROL_RECOVERY_GATE');
  // Capture/artifact and commissioning dispatch remain held until their complete
  // fixed runtime joins. Never fall through to clearOperations for a new verb.
  need(['inspect','resume','clear-operations'].includes(request.command),'CONTROL_RECOVERY_ACTION_NOT_INTEGRATED');
 }else{
  need(ticket.version===1&&!ticket.control&&!ticket.workerDatabase,'LIFECYCLE_OPERATOR_TICKET');
  need(equal(gate,{version:1,incarnation:ticket.incarnation,nonce:ticket.nonce,intentSha256:op.intentSha256,container:gate.container}),'LIFECYCLE_OPERATOR_GATE');
  need(equal(ticket.capabilities,{[O.NAME]:{kind:'pool',poolMax:1,maxInstances:1,metadata:{requestedMaximum:1,source:'deploy/multitenant/lifecycle-operator-entry.js',configurationSource:'fixed-controller-operator'}}}),'LIFECYCLE_OPERATOR_CAPABILITY');
 }
 need(ticket.processInstanceId===O.NAME&&ticket.planSha256&&op.intentSha256===B.hash(request)&&equal(op.resourceEpoch,[op.resourceEpoch?.[0],op.resourceEpoch?.[1]])&&op.resourceEpoch.every(v=>typeof v==='string'&&v.length>0),'LIFECYCLE_OPERATOR_TICKET');
 need(gate.container.service===O.NAME&&equal(gate.container.source,ticket.source)&&equal(Object.fromEntries(Object.keys(op.expected).map(k=>[k,gate.container[k]])),op.expected),'LIFECYCLE_OPERATOR_GATE');
 need(equal(ticket.directGroups,{})&&equal(ticket.cold,{activeLimit:1,pendingLimit:1,minDelayMs:0,maxDelayMs:0}),'LIFECYCLE_OPERATOR_CAPABILITY');
 need(config.control.locks.some(r=>r.tenant===request.tenant)&&env.NS_SOURCE_COMMIT===ticket.source.coreCommit,'LIFECYCLE_OPERATOR_TENANT');
 need(op.principal&&equal(Object.keys(op.principal).sort(),['database','databaseOid','role','roleOid'])&&['database','role'].every(k=>typeof op.principal[k]==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(op.principal[k]))&&['databaseOid','roleOid'].every(k=>typeof op.principal[k]==='string'&&/^[1-9][0-9]{0,9}$/.test(op.principal[k])&&Number(op.principal[k])<=4294967295),'LIFECYCLE_OPERATOR_PRINCIPAL');
 const uri=new URL(env.NS_OPERATOR_PG);
 need(decodeURIComponent(uri.username)===op.principal.role&&decodeURIComponent(uri.pathname.slice(1))===op.principal.database,'LIFECYCLE_OPERATOR_PRINCIPAL');
 let expired=false,uncertain=false,proof;
 const deadline=clock()+30000000000n;
 const check=()=>{if(expired||clock()>=deadline){expired=true;throw Object.assign(Error('LIFECYCLE_OPERATOR_DEADLINE'),{code:'LIFECYCLE_OPERATOR_DEADLINE'});}};
 const timer=setTimeout(()=>{expired=true;},30000);timer.unref?.();
 const selected=admission.install(ticket,{onState(){},onQuiescent(value){check();proof=value;return onQuiescent?.(value);}});
 let pool,cohort,controller,result,error,clean=true;
 try{
  check();
  const Pool=admission.wrapPool(pg.Pool,pg.Client,O.NAME);
  pool=new Pool(admission.poolOptions(O.NAME,{connectionString:env.NS_OPERATOR_PG,max:1,connectionTimeoutMillis:5000,statement_timeout:10000,lock_timeout:2000,options:'-c search_path=pg_catalog',idleTimeoutMillis:0}));
  const facade=singlePool(pool,{check,late(){uncertain=true;},async verify(client){
   check();const r=await client.query("SELECT current_user AS role,current_user::regrole::oid::text AS \"roleOid\",current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS \"databaseOid\",pg_postmaster_start_time()::text AS epoch,pg_backend_pid() AS pid,(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS birth");check();
   need(r.rows.length===1&&r.rows[0].role===op.principal.role&&r.rows[0].roleOid===op.principal.roleOid&&r.rows[0].database===op.principal.database&&r.rows[0].databaseOid===op.principal.databaseOid&&r.rows[0].epoch===op.resourceEpoch[1]&&Number.isSafeInteger(r.rows[0].pid)&&r.rows[0].pid>0&&typeof r.rows[0].birth==='string'&&r.rows[0].birth.length>0,'LIFECYCLE_OPERATOR_BACKEND_IDENTITY');
  }});
  const context=Object.freeze({pool:facade,check,...(fresh?{class:O.NAME}:{})});contexts.add(context);
  const adapter=require('./restore');
  if(request.command!=='inspect')cohort=await adapter.recoveryCohort(config,env);check();
  controller=adapter.recoveryController(config,cohort,context);
  result=await (request.command==='inspect'?controller.inspect(request.tenant):request.command==='resume'?controller.resume(request.tenant,{claimId:request.claimId}):controller.clearOperations(request.tenant));check();
 }catch(cause){error=cause;if(expired||/OUTCOME_UNCERTAIN/.test(cause.code||''))uncertain=true;}
 finally{
  try{await controller?.close();}catch(cause){clean=false;error=error||cause;}
  try{await cohort?.close();}catch(cause){clean=false;error=error||cause;}
  try{selected.beginQuiesce();await pool?.end();await selected.finalizeQuiescence(clean&&!uncertain&&!expired);}catch(cause){clean=false;error=error||cause;}
  clearTimeout(timer);
 }
 need(clean&&!uncertain&&!expired&&proof,'LIFECYCLE_OPERATOR_OUTCOME_UNCERTAIN');
 return {...(fresh?{version:2,kind:'controlled-operation-complete',class:O.NAME}:{version:1,kind:'lifecycle-operator-complete'}),incarnation:ticket.incarnation,nonce:ticket.nonce,planSha256:ticket.planSha256,source:ticket.source,intentSha256:op.intentSha256,container:gate.container,outcome:error?'REFUSED':'COMPLETED',result:error?{error:/^[A-Z][A-Z0-9_]{1,100}$/.test(error.code||'')?error.code:'LIFECYCLE_OPERATOR_REFUSED'}:result,quiescence:proof};
}
async function main(){
 const view='/run/ns-operator-ticket',claims='/run/ns-operator-claims';
 const ticket=F.read(path.join(view,'ticket.json'));
 // Waiting for a host-owned RO gate cannot authenticate or construct a pool.
 const deadline=Date.now()+5000;let gate;
 for(;;){try{gate=F.read(path.join(view,'gate.json'));break;}catch(error){if(error.code!=='CONNECTION_BUDGET_PRIVATE_FILE'&&error.code!=='ENOENT')throw error;if(Date.now()>=deadline)throw Object.assign(Error('LIFECYCLE_OPERATOR_GATE_TIMEOUT'),{code:'LIFECYCLE_OPERATOR_GATE_TIMEOUT'});await new Promise(resolve=>setTimeout(resolve,20));}}
 let action;
 if(ticket.version!==1){const receiver=require('./physical-ticket-receiver');receiver.ticket(ticket,O.NAME);receiver.gate(gate,ticket);
  action=F.read(path.join(view,'action.json'));need(B.hash(C.intent(O.NAME,action))===ticket.control.intentSha256,'CONTROL_RECOVERY_INTENT');
  need(ticket.control.files['action.json']===digest(path.join(view,'action.json')),'LIFECYCLE_OPERATOR_FILES');
 }else {need(!ticket.control&&!ticket.workerDatabase,'LIFECYCLE_OPERATOR_TICKET');O.intent(ticket.operator?.intent);}
 const env=F.read('/run/ns-operator-env/env.json'),raw=F.read('/run/ns-operator-config/config.json');
 need(equal(Object.keys(env).sort(),['NS_OPERATOR_PG','NS_SOURCE_COMMIT',...(env.MULTITENANT_REALTIME_PLACEMENT?['MULTITENANT_REALTIME_PLACEMENT']:[])].sort()),'LIFECYCLE_OPERATOR_ENV');
 need(env.NS_SOURCE_COMMIT===ticket.source.coreCommit&&B.REVIEWED_CORE_COMMIT===ticket.source.coreCommit,'CONNECTION_BUDGET_UNREVIEWED_SOURCE');
 const image=JSON.parse(fs.readFileSync(path.join(__dirname,'.image-source.json'),'utf8'));
 need(equal(image,{version:1,...ticket.source}),'LIFECYCLE_OPERATOR_IMAGE');
 const selectedFiles={...(ticket.version===2?{'action.json':digest(path.join(view,'action.json'))}:{}),'env.json':digest('/run/ns-operator-env/env.json'),'config.json':digest('/run/ns-operator-config/config.json'),...(env.MULTITENANT_REALTIME_PLACEMENT?{'placement.json':digest('/run/ns-placement/backend.json')}:{})};
 need(equal(selectedFiles,(ticket.version===2?ticket.control:ticket.operator).files),'LIFECYCLE_OPERATOR_FILES');
 if(env.MULTITENANT_REALTIME_PLACEMENT)need(env.MULTITENANT_REALTIME_PLACEMENT==='/run/ns-placement/backend.json','LIFECYCLE_OPERATOR_PLACEMENT');
 const config=require('./restore').validateRecoveryConfig(raw,env),fd=F.directory(claims);
 try{
  F.writeAt(fd,'claim.json',{incarnation:ticket.incarnation,nonce:ticket.nonce,planSha256:ticket.planSha256,intentSha256:(ticket.version===2?ticket.control:ticket.operator).intentSha256},{exclusive:true});
  const receipt=await execute({ticket,gate,action,config,env,admission:require('../../lib/storage/connection-admission'),pg:require('pg')});
  F.writeAt(fd,'complete.json',receipt,{exclusive:true});
 }finally{fs.closeSync(fd);}
}
if(require.main===module)main().catch(()=>{process.stderr.write('LIFECYCLE_OPERATOR_OUTCOME_UNCERTAIN\n');process.exitCode=1;});
module.exports={execute,singlePool,isContext,main};
