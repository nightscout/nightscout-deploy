'use strict';
// Disposable ordinary two-tenant operator rehearsal. Host orchestration and a
// fixed in-container API client; never loaded by a serving role.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,code,ms=30000){const end=Date.now()+ms;let last;do{try{last=await fn();if(last)return last;}catch(e){last=e.code||e.message;}await pause(200);}while(Date.now()<end);throw Object.assign(Error(code),{code,observation:last});}
async function client(mode){
 const root=process.cwd(),demo=require(path.join(root,'deploy/multitenant/demo')),operator=require(path.join(root,'deploy/multitenant/restore'));
 assert.equal(process.env.NS_DEMO_CONFIRM_SYNTHETIC,'1');const config=operator.loadConfig();
 const file='/run/ns-drill-state/pgstream-expect.json';
 if(mode==='seed'){
  for(const tenant of config.tenants){const old=(await demo.request(config,tenant,'/api/v3/entries?limit=1000')).result;assert(Array.isArray(old));for(const row of old)await demo.request(config,tenant,'/api/v3/entries/'+row.identifier,{method:'DELETE'});}
  const at=Date.now(),rows=config.tenants.map((t,i)=>({tenant:t.id,id:crypto.randomUUID(),value:i?120:50,date:i?at:at-600000+90000}));
  for(const row of rows){const tenant=config.tenants.find(t=>t.id===row.tenant);await demo.request(config,tenant,'/api/v3/entries/'+row.id,{method:'PUT',body:demo.document(row.id,row.date,row.value)});}
  fs.writeFileSync(file,JSON.stringify(rows),{mode:0o600,flag:'wx'});return {state:'seeded'};
 }
 const rows=JSON.parse(fs.readFileSync(file));
 if(mode==='gap-write'){
  const row=rows[1];await demo.request(config,config.tenants[1],'/api/v3/entries/'+row.id,{method:'PATCH',body:{sgv:159}});row.value=159;fs.writeFileSync(file,JSON.stringify(rows),{mode:0o600});return {state:'gap-written'};
 }
 assert.equal(mode,'viewer');const io=require('/run/ns-client/node_modules/socket.io-client');
 for(const row of rows){
  const tenant=config.tenants.find(t=>t.id===row.tenant),token=await demo.exchange(config,tenant);
  const body=(await demo.request(config,tenant,'/api/v3/entries/'+row.id)).result;assert.equal(body.sgv,row.value,'AUTHORIZED_API_CURRENT_VALUE');
  const socket=io('http://nginx:8080',{forceNew:true,reconnection:false,transports:['websocket'],extraHeaders:{host:tenant.host}}),frames=[];
  socket.on('dataUpdate',x=>frames.push(x));
  try{await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',()=>reject(Object.assign(Error('DRILL_VIEWER_CONNECT_REFUSED'),{code:'DRILL_VIEWER_CONNECT_REFUSED'})));});
   const ack=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('VIEWER_AUTHORIZE_TIMEOUT')),10000);socket.emit('authorize',{token},x=>{clearTimeout(t);resolve(x);});});
   assert.equal(ack.read,true,'CURRENT_VIEWER_AUTHORIZED');await wait(()=>frames.find(f=>f.sgvs?.some(r=>(r.mills===row.date)&&r.mgdl===row.value)),'AUTHORIZED_CURRENT_CLINICAL_FRAME');
   assert(!frames.some(f=>f.sgvs?.some(r=>r.mgdl===rows.find(x=>x.tenant!==row.tenant).value)),'NO_FOREIGN_CLINICAL_VALUE');
  }finally{socket.close();}
 }
 return {state:'authorized-current-two-tenant-frames'};
}
function qualify(rows,before,expectations){assert.equal(rows.length,2,'EXACT_COHORT');assert.deepEqual(rows.map(r=>r.tenant).sort(),expectations.map(r=>r.tenant).sort(),'EXACT_TENANT_COVERAGE');for(const row of rows){const wanted=expectations.find(x=>x.tenant===row.tenant);assert(wanted,'EXACT_TENANT');
  assert.deepEqual(row.work_observed,row.work_completed,'NO_UNFINISHED_OBSERVATION');assert.equal(row.work_pending_at,null,'NO_PENDING');
  for(const [index,key]of [[0,'last_stamp'],[1,'settings'],[2,'policy'],[3,'activity']])assert.equal(String(row.work_completed[index]),String(row[key]),'PHYSICAL_'+key.toUpperCase());
  assert.equal(row.phase,'active');assert.equal(String(row.output_restore_generation),String(row.restore),'CURRENT_RESTORE_GENERATION');
  assert(row.input?.ready,'READY_INPUT');assert.equal(String(row.input_checkpoint),String(row.last_stamp),'CURRENT_ACCEPTED_INPUT');
  assert(row.output?.frame.sgvs.some(x=>(x.mills===wanted.date)&&x.mgdl===wanted.value),'INDEPENDENT_CURRENT_CLINICAL_VALUE');
  if(before){const old=before.find(x=>x.tenant===row.tenant);assert.equal(row.output_identity,old.output_identity,'UNCHANGED_AUTHORITY');assert.equal(row.output_restore_generation,old.output_restore_generation,'UNCHANGED_RESTORE');
   if(row.tenant===expectations[0].tenant){assert(Number(row.work_completed_at)>=Number(old.work_due_at),'ORIGINAL_DUE_EXECUTED');assert(row.work_due_at===null||Number(row.work_due_at)>Number(old.work_due_at),'ORIGINAL_DUE_RETIRED_OR_RESCHEDULED');}else assert.equal(row.work_due_at,old.work_due_at,'NEIGHBOR_FUTURE_DUE_RETAINED');}
 }return true;}
async function host(){
 const stack=path.resolve(__dirname,'../stack.sh'),core=process.env.NS_DRILL_CORE;
 const command=(exe,args,input)=>{try{return execFileSync(exe,args,{encoding:'utf8',input,timeout:45000,maxBuffer:4194304,stdio:['pipe','pipe','pipe']}).trim();}catch(e){throw Object.assign(Error('DRILL_COMMAND_REFUSED'),{code:/^[A-Z][A-Z0-9_]+$/.test(String(e.stderr||'').trim())?String(e.stderr).trim():'DRILL_COMMAND_REFUSED',status:e.status});}};
 const call=args=>command(stack,args),state=call(['state']),directory=path.join(state,'drill');fs.mkdirSync(directory,{mode:0o700});
 const save=(name,x)=>fs.writeFileSync(path.join(directory,name+'.json'),JSON.stringify(x)+'\n',{mode:0o600,flag:'wx'});
 const report=(step,x)=>process.stdout.write(JSON.stringify({drill:'pgstream-recovery',step,...x})+'\n');
 const api=mode=>{const result=JSON.parse(call(['ops','-v',fs.realpathSync(path.join(core,'node_modules'))+':/run/ns-client/node_modules:ro','-v',path.resolve(__dirname)+':/run/ns-drill:ro','-v',directory+':/run/ns-drill-state','demo','node','-r','./deploy/multitenant/load-env.js','/run/ns-drill/pgstream-recovery.cjs',mode]));assert(!result.error,result.error);return result;};
 const docker=(args,input)=>command('docker',args,input),project=process.env.NS_DRILL_PROJECT;
 const all=()=>{const ids=docker(['ps','-aq','--filter','label=com.docker.compose.project='+project]).split(/\s+/).filter(Boolean);return JSON.parse(docker(['inspect',...ids]));};
 const service=r=>r.Config.Labels['com.docker.compose.service'];
 const pg=all().find(r=>service(r)==='postgres');assert(pg,'POSTGRES_REQUIRED');
 const sql=text=>docker(['exec','-i',pg.Id,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','nightscout_compose_test'],text);
 const query=text=>JSON.parse(sql('BEGIN READ ONLY; SELECT coalesce(json_agg(x),\'[]\') FROM ('+text+') x; COMMIT;'));
 const snapshot=()=>query(`SELECT c.tenant_id::text AS tenant,c.work_observed,c.work_completed,c.work_pending_at,c.work_due_at,c.work_completed_at,c.output_identity,c.output_revision,c.output_restore_generation,c.projection->0->'output' AS output,i.checkpoint AS input_checkpoint,i.projection->0 AS input,w.last_stamp,s.version AS settings,p.generation AS policy,a.version AS activity,l.generation AS restore,l.phase FROM nsdemo_eval_checkpoint.tenant_consumer_checkpoint c JOIN nsdemo_eval_checkpoint.tenant_consumer_checkpoint i ON i.tenant_id=c.tenant_id AND i.consumer='evaluator-compose-demo' JOIN nsdemo_clock.tenant_write_clock w ON w.tenant_id=c.tenant_id JOIN nsdemo_display_settings.tenant_settings s ON s.tenant_id=c.tenant_id JOIN nsdemo_operator_policy.tenant_operator_policy p ON p.tenant_id=c.tenant_id JOIN nsdemo_control.tenant_activity a ON a.tenant_id=c.tenant_id JOIN nsdemo_control.tenant_lifecycle_windows l ON l.tenant_id=c.tenant_id WHERE c.consumer='evaluator-compose-demo-completed' ORDER BY c.tenant_id`);
 const expected=()=>JSON.parse(fs.readFileSync(path.join(directory,'pgstream-expect.json')));

 let stopped=[];
 try{
  const original=all();save('pgstream-entry-cohort',original.map(r=>({cid:r.Id,service:service(r),restart:r.HostConfig.RestartPolicy})));
  report('seed',api('seed'));const before=await wait(()=>{const x=snapshot();saveObservation=x;return qualify(x,null,expected())&&x;},'INITIAL_COMPLETION');save('pgstream-before',before);
  assert(before[0].work_due_at&&Number(before[0].work_due_at)>Date.now(),'REAL_FUTURE_DUE_REQUIRED');
  for(const role of ['evaluator','pgstream']){const r=all().find(x=>service(x)===role);docker(['update','--restart=no',r.Id]);docker(['stop','--time','10',r.Id]);}
  report('gap-write',api('gap-write'));const gap=snapshot();save('pgstream-gap',gap);assert(BigInt(gap[1].last_stamp)>BigInt(gap[1].work_completed[0]),'GAP_WRITE_NOT_COMPLETED');
  stopped=all().filter(r=>!['postgres','vault'].includes(service(r)));save('pgstream-original-cohort',stopped.map(r=>({cid:r.Id,service:service(r),restart:r.HostConfig.RestartPolicy})));
  for(const r of stopped){docker(['update','--restart=no',r.Id]);docker(['stop','--time','10',r.Id]);}
  const cohort=all();assert(cohort.filter(r=>!['postgres','vault'].includes(service(r))).every(r=>!r.State.Running&&r.State.Pid===0),'WHOLE_COHORT_STOPPED');
  sql("SELECT pg_drop_replication_slot('nsdemo_pgstream');");
  const folder=path.join(core,'deploy/multitenant'),composeFiles=[path.join(folder,'compose.yaml'),path.join(state,'compose.replicas.yaml')];
  const environmentFile=path.join(directory,'pgstream-effective.env');fs.writeFileSync(environmentFile,fs.readFileSync(path.join(folder,'.env'),'utf8')+'\nNS_DEMO_IMAGE='+process.env.NS_DRILL_IMAGE+'\n',{mode:0o600,flag:'wx'});
  const db=query("SELECT current_database() AS name,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,system_identifier::text AS \"systemIdentifier\",pg_postmaster_start_time()::text AS \"postmasterStartedAt\" FROM pg_control_system()")[0];
  const labels=JSON.parse(fs.readFileSync(path.join(state,'bootstrap/complete.json')));
  const plan={version:1,action:'create-missing',project,source:{coreCommit:labels.sourceCommit,deployCommit:labels.deployCommit},imageId:process.env.NS_DRILL_IMAGE,postgresImageId:pg.Image,database:db,slot:'nsdemo_pgstream',operatorRole:'postgres',deploymentDirectory:folder,stateDirectory:state,composeFiles,environmentFile,approvedHistoricalComposeFiles:composeFiles.map(p=>({path:p,sha256:sha(fs.readFileSync(p))})),generationFile:path.join(state,'evaluator/ns_pgstream_generation'),generationFileSha256:sha(fs.readFileSync(path.join(state,'evaluator/ns_pgstream_generation'))),wireConfigSha256:sha(fs.readFileSync(path.join(state,'pgstream/pgstream.yaml'))),containers:cohort.map(r=>({cid:r.Id,service:service(r),imageId:r.Image,startedAt:r.State.StartedAt,configHash:r.Config.Labels['com.docker.compose.config-hash'],originalRestartPolicy:original.find(x=>x.Id===r.Id).HostConfig.RestartPolicy,composeFiles:r.Config.Labels['com.docker.compose.project.config_files'].split(',')})),receiptFile:path.join(directory,'pgstream-slot-receipt.json')};
  save('pgstream-plan',plan);const helper=path.join(folder,'pgstream-rebootstrap.js');
  const wrong={...plan,database:{...db,systemIdentifier:'0'},receiptFile:path.join(directory,'wrong-receipt.json')};save('pgstream-wrong-plan',wrong);
  let red=false;try{command(process.execPath,[helper,path.join(directory,'pgstream-wrong-plan.json')]);}catch(e){assert.equal(e.code,'PGSTREAM_REBOOTSTRAP_BACKEND_CHANGED');red=true;}assert(red,'WRONG_IDENTITY_REFUSED');assert.equal(query("SELECT slot_name FROM pg_replication_slots WHERE slot_name='nsdemo_pgstream'").length,0,'CONTROL_NO_SLOT_MUTATION');report('wrong-identity',{refused:true});
  report('slot',JSON.parse(command(process.execPath,[helper,path.join(directory,'pgstream-plan.json')])));
  assert.equal(JSON.parse(fs.readFileSync(plan.receiptFile)).state,'SLOT_RECREATED_EFFECTS_STOPPED');
  // No Compose dependencies: only these exact existing process incarnations restart.
  const recovery=cohort.filter(r=>['evaluator','pgstream'].includes(service(r)));
  const start=r=>{const policy=original.find(x=>x.Id===r.Id).HostConfig.RestartPolicy;assert(['no','on-failure','unless-stopped','always'].includes(policy.Name));const value=policy.Name==='on-failure'&&policy.MaximumRetryCount?policy.Name+':'+policy.MaximumRetryCount:policy.Name;docker(['update','--restart='+value,r.Id]);docker(['start',r.Id]);};
  for(const r of recovery)start(r);
  const due=Number(before[0].work_due_at);await pause(Math.max(0,due-Date.now()+50));
  const after=await wait(()=>{const x=snapshot();saveObservation=x;return qualify(x,before,expected())&&x;},'RECOVERY_COMPLETION');save('pgstream-reconciled',after);
  assert(all().filter(r=>!['postgres','vault','evaluator','pgstream'].includes(service(r))).every(r=>!r.State.Running),'NO_EARLY_REOPEN');
  for(const name of ['admin','api','realtime','tenant-admin','ui','nginx']){const r=cohort.find(r=>service(r)===name);if(r)start(r);}
  report('viewer',await wait(()=>api('viewer'),'AUTHORIZED_VIEWER_CONVERGENCE'));
  save('pgstream-reopened-cohort',all().map(r=>({cid:r.Id,service:service(r),startedAt:r.State.StartedAt,restart:r.HostConfig.RestartPolicy,running:r.State.Running})));
  report('result',{state:'passed',scope:'ordinary populated slot recovery, accepted input, due completion, current generation and authorized two-tenant frames'});
 }catch(e){for(const r of all().filter(x=>!['postgres','vault'].includes(service(x)))){try{docker(['update','--restart=no',r.Id]);docker(['stop','--time','5',r.Id]);}catch{ /* Original failure remains; operator inspects exact cohort. */ }}if(typeof saveObservation!=='undefined')save('pgstream-refused-observation',saveObservation);throw e;}
}
let saveObservation;
if(require.main===module)(process.argv[2]==='host'?host():client(process.argv[2])).then(x=>{if(x)process.stdout.write(JSON.stringify(x)+'\n');},e=>{process.stderr.write(JSON.stringify({error:/^[A-Z][A-Z0-9_]+$/.test(e.code||e.message)?e.code||e.message:'PGSTREAM_DRILL_ASSERTION',assertion:e.code==='ERR_ASSERTION'?e.message:undefined,scope:'keep affected effects stopped; inspect retained private drill evidence'})+'\n');process.exitCode=1;});
module.exports={wait,qualify};
