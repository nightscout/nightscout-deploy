'use strict';
// Tiny synthetic binding proof: actual generated SQL/config and source adapters.
// Peer endpoints model role processes over real backend identities; no CLI/10k claim.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync,spawn}=require('node:child_process');
const {Client,Pool}=require('pg'),plan=require('../config'),binding=require('../native-lifecycle'),bridge=require('../restore'),scope=require('../../../lib/storage/tenant-scope');
const PG='postgres@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97',VAULT='hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2';
const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}).trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function ready(fn){let last;for(const until=Date.now()+30000;Date.now()<until;){try{return await fn();}catch(e){last=e;await sleep(200);}}throw last;}
test('actual tiny native generated provisioning, export, logical restore and private recovery retain B and queue IDs',{skip:process.env.NS_NATIVE_LIFECYCLE_BIND_TEST!=='1',timeout:180000},async()=>{
 const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
 const id=crypto.randomBytes(4).toString('hex'),owner='native_bind_'+id,containers=[],peers=[],backends=[],directory=fs.mkdtempSync(path.join(os.tmpdir(),'ns-native-bind-'));
 const l=plan.layout(),q=plan.quote,ns=l.namespaces,table=(kind,name)=>q(ns[kind])+'.'+q(name),password=crypto.randomBytes(24).toString('hex'),vaultToken=crypto.randomBytes(24).toString('hex');
 let admin,provisioning,adminURI,selection,raw,config,env,docs,currentDigest;
 const urls={};
 try{
  for(const [name,image,args,extra]of [[owner+'_pg',PG,['-e','POSTGRES_USER=bootstrap','-e','POSTGRES_PASSWORD','-e','POSTGRES_DB=nightscout_compose_test'],{POSTGRES_PASSWORD:password}],[owner+'_vault',VAULT,['-e','VAULT_DEV_ROOT_TOKEN_ID'],{VAULT_DEV_ROOT_TOKEN_ID:vaultToken}]]){
   const vault=image===VAULT,cid=execFileSync('docker',['run','--pull','never','--name',name,'--label','org.nightscout.test.owner='+owner,'--memory','768m','--cpus','1','--pids-limit','192','-d','-p','127.0.0.1::'+(vault?'8200':'5432'),...args,image,...(vault?['server','-dev']:['-c','wal_level=logical'])],{env:{...process.env,...extra},encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}).trim();
   assert.match(cid,/^[a-f0-9]{64}$/);containers.push(cid);console.log('NATIVE_BIND_RESOURCE '+JSON.stringify({id:cid,name,image,owner}));spawn('sh',['-c','while kill -0 "$1" 2>/dev/null; do sleep 2; done; docker rm -f -v "$2" >/dev/null 2>&1','reaper',String(process.pid),cid],{stdio:'ignore',detached:true}).unref();
  }
  adminURI='postgres://bootstrap:'+password+'@127.0.0.1:'+docker(['port',containers[0],'5432/tcp']).split(':').pop()+'/nightscout_compose_test';
  const vaultAddress='http://127.0.0.1:'+docker(['port',containers[1],'8200/tcp']).split(':').pop()+'/';
  await ready(async()=>{const c=new Client({connectionString:adminURI});await c.connect();await c.end();});
  const request=async(resource,body,token=vaultToken)=>{const response=await fetch(vaultAddress+'v1/'+resource,{method:body===undefined?'GET':'POST',headers:{'X-Vault-Token':token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});if(!response.ok){await response.body?.cancel();throw Error('NATIVE_BIND_VAULT_REFUSED');}return response.status===204?null:response.json();};
  await ready(()=>request('sys/health'));admin=new Client({connectionString:adminURI});await admin.connect();
  await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');await admin.query('REVOKE CREATE ON DATABASE nightscout_compose_test FROM PUBLIC');
  for(const role of [l.owner,l.managementAuthorityOwner])await admin.query('CREATE ROLE '+q(role)+' NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION');
  for(const [kind,role]of Object.entries(l.roles)){const secret=crypto.randomBytes(24).toString('hex');await admin.query('CREATE ROLE '+q(role)+" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD '"+secret+"'");const url=new URL(adminURI);url.username=role;url.password=secret;urls[kind]=url.toString();}
  for(const [kind,catalogue]of Object.entries(plan.catalogues())){
   await admin.query('CREATE SCHEMA '+q(ns[kind]));await require('../../../lib/migrations/postgres').run('up',{direct:true,connectionString:adminURI,namespace:ns[kind],catalogue});
   for(const row of(await admin.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[ns[kind]])).rows)await admin.query('ALTER TABLE '+q(ns[kind])+'.'+q(row.tablename)+' OWNER TO '+q(l.owner));
   for(const row of(await admin.query('SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1',[ns[kind]])).rows)await admin.query('ALTER FUNCTION '+row.signature+' OWNER TO '+q(l.owner));
   await admin.query('ALTER SCHEMA '+q(ns[kind])+' OWNER TO '+q(l.owner));
  }
  for(const sql of plan.grants(l))await admin.query(sql);
  // Actual native logical source, without a maintained producer/whole boot claim.
  const slot=require('../pgstream').descriptor(l).pgstream.slot;await admin.query("SELECT pg_create_logical_replication_slot($1,'pgoutput')",[slot]);
  const source=await binding.source(admin,slot);
  const output=path.join(directory,'generated'),writePrivate=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,JSON.stringify(value),{mode:0o600,flag:'wx'});};
  await require('../registry-bootstrap').finish({options:{output,uid:process.getuid(),gid:process.getgid(),sourceCommit:process.env.NS_NATIVE_BIND_CORE_COMMIT,deployCommit:process.env.NS_NATIVE_BIND_DEPLOY_COMMIT,vault:{origin:'https://vault:8200'}},request,rootToken:vaultToken,layout:l,roleURLs:urls,writePrivate,admin,adminURL:adminURI,nativeSource:source});
  raw=JSON.parse(fs.readFileSync(path.join(output,'ops/config.json')));env={...JSON.parse(fs.readFileSync(path.join(output,'ops/env.json'))),NS_DEMO_TOKEN_A:'synthetic',NS_DEMO_TOKEN_B:'synthetic'};
  selection=require('../../../lib/tenant-lifecycle/native-selection').create(raw.nativeSelection);currentDigest=selection.digest;
  docs={evaluator:JSON.parse(fs.readFileSync(path.join(output,'evaluator/config.json')))};
  assert.equal(selection.binding.generation,docs.evaluator.pgstream.generation);
  for(const role of plan.serviceRoles)assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output,role,'operation.json'))).nativeSelection,raw.nativeSelection);
  const adminDoc=JSON.parse(fs.readFileSync(path.join(output,'admin/config.json'))),provisionerToken=fs.readFileSync(path.join(output,'admin/vault-token'),'utf8').trim();
  provisioning=require('../../../lib/tenant-registry/provision').createProvisioning({connectionString:urls.provisioner,namespaces:adminDoc.provisioning.namespaces,checkpoints:adminDoc.provisioning.checkpoints,ownerCatalogue:adminDoc.provisioning.ownerPolicy.catalogue,actor:adminDoc.provisioning.operator,vault:{address:vaultAddress,mount:l.mount,getToken:async()=>provisionerToken,allowInsecureLoopback:true,timeoutMs:5000}});
  for(const [i,tenant]of [plan.A,plan.B].entries())assert.equal((await provisioning.provision({id:tenant,hosts:[plan.tenantAlias(i)],issueRootSecret:true})).outcome,'created');
  await provisioning.close();provisioning=null;
  for(const tenant of [plan.A,plan.B]){await admin.query('BEGIN');try{await admin.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);for(const kind of [...plan.clinical,'settings'])await admin.query('INSERT INTO '+table(kind,kind)+' (tenant_id,id_kind,doc) VALUES($1,\'string\',$2)',[tenant,JSON.stringify({_id:'native-'+kind,identifier:'native-'+kind,value:1,type:'sgv',srvCreated:Date.now()-200,srvModified:Date.now()-100})]);await admin.query('UPDATE '+table('clock','tenant_write_clock')+' SET last_stamp=$2 WHERE tenant_id=$1',[tenant,String(Date.now())]);await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;}}
  const values=require('../../../tests/fixtures/tenant-deployment-notifications').notificationInputs({tenants:[plan.A],now:Date.now(),outboxRole:l.roles.outbox,checkpointWriterRole:l.roles.evaluator,ackReaderRole:l.roles.alarm}).rows;
  for(const [name,rows]of Object.entries(values))for(const row of rows.filter(v=>v.consumer==='synthetic_realtime')){const keys=Object.keys(row);await admin.query('INSERT INTO '+table('outbox',name)+' ('+keys.map(q).join(',')+') VALUES('+keys.map((_,i)=>'$'+(i+1)).join(',')+')',keys.map(key=>row[key]));}
  for(const tenant of [plan.A,plan.B])await admin.query('INSERT INTO '+table('control','tenant_lifecycle_restore_authority')+' (tenant_id,role_oid,active) VALUES($1,$2::regrole::oid,true)',[tenant,l.roles.operator]);
  const op=new Client({connectionString:urls.operator});await op.connect();let identity;try{identity=await require('../../../lib/tenant-lifecycle/operation-window-readiness').admit(op,ns.control,{maintenance:true,intakeProfile:selection});}finally{await op.end();}
  const transport=require('../../../lib/server/internal-api/transport'),contract=require('../../../lib/server/internal-api/contracts').lifecycleParticipant,datastore=require('../../../lib/storage/postgres-datastore');
  raw.control.participants=raw.control.participants.map((peer,i)=>({...peer,endpoint:{socketPath:path.join(directory,'peer-'+i+'.sock'),maxBytes:1048576,timeoutMs:5000}}));
  for(const peer of raw.control.participants){const role=peer.roles[0],client=new Client({connectionString:urls[role.replace('tenant-admin','owner_reader')]});await client.connect();backends.push(client);const row=(await client.query('SELECT pg_backend_pid() AS pid,current_user AS role,extract(epoch from backend_start)::text AS birth,'+datastore.SQL+' FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0],incarnation=crypto.randomUUID();
   const status=request=>({version:4,ownership:peer.roles.includes('realtime')?{count:peer.slice?.count||1,ordinal:peer.slice?.ordinal||0,rule:require('../../../lib/pool-membership/slice').RULE}:null,participant:peer.id,incarnation,namespace:ns.control,roles:peer.roles,tenants:['registry:'+ns.registry],namespaces:peer.namespaces,identity,intakeProfileDigest:currentDigest,datastore:datastore.identity(row),backends:[{pid:row.pid,role:row.role,birth:row.birth}],request});
   peers.push(await transport.open(peer.endpoint,contract,()=>({getStatus:async(_ctx,body)=>status(body.request),invalidateTenant:async(_ctx,body)=>({...status(body.request),tenant:body.tenant}),getOperations:async(_ctx,body)=>({request:body.request,tenant:body.tenant,participant:peer.id,incarnation,operations:[]})})));
  }
  config=bridge.validateConfig(raw,env);
  const rows=async(tenant)=>{const result={};for(const entry of raw.catalogues)for(const name of entry.tables)result[entry.kind+'.'+name]=require('../../../lib/tenant-lifecycle/artifact').digestRows((await admin.query('SELECT * FROM '+q(raw.namespaces[entry.kind])+'.'+q(name)+' WHERE tenant_id=$1',[tenant])).rows);return result;};
  const beforeB=await rows(plan.B),queues=async()=>{const result={};for(const name of ['tenant_notification_heads','tenant_notification_requests','tenant_notification_state'])result[name]=require('../../../lib/tenant-lifecycle/artifact').digestRows((await admin.query('SELECT * FROM '+table('outbox',name)+' WHERE tenant_id=$1',[plan.A])).rows);return result;},queueBefore=await queues();
  const artifact=await bridge.capture(config,plan.A,env);
  const mutate=async()=>{await admin.query('BEGIN');try{await admin.query("SELECT set_config('app.current_tenant_id',$1,true)",[plan.A]);await admin.query('UPDATE '+table('entries','entries')+" SET doc=jsonb_set(doc,'{value}','99'::jsonb) WHERE tenant_id=$1",[plan.A]);await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;}};
  await mutate();const restored=await bridge.restore(config,artifact,env);assert.equal(restored.result.tables,7);assert.deepEqual(await queues(),queueBefore);assert.deepEqual(await rows(plan.B),beforeB);
  const beforeA=await rows(plan.A);
  for(const change of [v=>{v.nativeSelection.generation='foreign-generation';},v=>{v.nativeSelection.source.system_id+='1';}]){const bad=structuredClone(raw);change(bad);const parsed=bridge.validateConfig(bad,env);await assert.rejects(bridge.capture(parsed,plan.A,env),{code:'RESTORE_COHORT_INTAKE_PROFILE_MISMATCH'});assert.deepEqual(await rows(plan.A),beforeA);}
  const foreign=structuredClone(raw);foreign.nativeSelection.source.system_id+='1';const bad=bridge.validateConfig(foreign,env);currentDigest=bad.nativeSelection.digest;try{await assert.rejects(bridge.capture(bad,plan.A,env),{code:'LIFECYCLE_NATIVE_SOURCE_CHANGED'});}finally{currentDigest=selection.digest;}
  const readyClient=new Client({connectionString:urls.lifetime_api});await readyClient.connect();try{await require('../../../lib/tenant-lifecycle/operation-window-readiness').admit(readyClient,ns.control,{lifetime:true,intakeProfile:selection});}finally{await readyClient.end();}
  await admin.query('REVOKE SELECT(generation) ON '+table('control','tenant_lifecycle_recommission')+' FROM '+q(l.roles.lifetime_api));
  const refusedClient=new Client({connectionString:urls.lifetime_api});await refusedClient.connect();try{await assert.rejects(require('../../../lib/tenant-lifecycle/operation-window-readiness').admit(refusedClient,ns.control,{lifetime:true,intakeProfile:selection}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});}finally{await refusedClient.end();}
  for(const sql of require('../../../lib/tenant-lifecycle/native-selection').servingGrants({namespace:ns.control,role:l.roles.lifetime_api}))await admin.query(sql);
  const restoredClient=new Client({connectionString:urls.lifetime_api});await restoredClient.connect();try{await require('../../../lib/tenant-lifecycle/operation-window-readiness').admit(restoredClient,ns.control,{lifetime:true,intakeProfile:selection});}finally{await restoredClient.end();}
  // A real one-shot entry owns the only operator backend and creates the genuine
  // recovery context. The fixture supplies a source/epoch-bound synthetic ticket.
  async function recover(){
   const state=(await admin.query('SELECT claim_id FROM '+table('control','tenant_lifecycle_windows')+' WHERE tenant_id=$1',[plan.A])).rows[0],row=(await admin.query('SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",oid::text AS "roleOid",rolname AS role FROM pg_roles WHERE rolname=$1',[l.roles.operator])).rows[0],epoch=(await admin.query('SELECT system_identifier::text AS system_id,pg_postmaster_start_time()::text AS birth FROM pg_control_system()')).rows[0];
   const O=require('../lifecycle-operator'),B=require('../connection-budget'),source={coreCommit:env.NS_SOURCE_COMMIT,deployCommit:process.env.NS_NATIVE_BIND_DEPLOY_COMMIT},expected={source,project:'native-bind',workingDirectory:directory,imageId:'sha256:'+'c'.repeat(64)},intent={version:1,command:'resume',tenant:plan.A,claimId:state.claim_id};
   const lease={incarnation:crypto.randomBytes(16).toString('hex'),nonce:crypto.randomBytes(16).toString('hex'),intent,intentSha256:B.hash(intent)},ticket=O.ticket({source,sha256:'f'.repeat(64),resource:{pgResourceId:'native-bind',aliases:[new URL(adminURI).host],systemIdentifier:epoch.system_id,postmasterStartedAt:epoch.birth},lifecycleOperator:{principal:row}},lease,expected,{}),gate={version:1,incarnation:lease.incarnation,nonce:lease.nonce,intentSha256:lease.intentSha256,container:{...expected,service:O.NAME,cid:'a'.repeat(64),startedAt:'synthetic'}};
   const result=await require('../lifecycle-operator-entry').execute({ticket,gate,config,env,admission:require('../../../lib/storage/connection-admission'),pg:require('pg')});assert.equal(result.outcome,'COMPLETED');return result.result;
  }
  await mutate();await assert.rejects(bridge.restore(config,artifact,env,{onRow(){throw Error('NATIVE_BIND_BEFORE_DATA');}}),/NATIVE_BIND_BEFORE_DATA/);assert.equal((await recover()).interrupted,'before-data');
  await assert.rejects(bridge.restore(config,artifact,env,{onCommitted(){throw Error('NATIVE_BIND_AFTER_DATA');}}),/NATIVE_BIND_AFTER_DATA/);assert.equal((await recover()).interrupted,'data-replaced');
  assert.deepEqual(await rows(plan.B),beforeB);assert.deepEqual(await queues(),queueBefore);await bridge.capture(config,plan.A,env);
 }finally{
  if(provisioning)await provisioning.close();for(const peer of peers)await peer.close();for(const client of backends)await client.end();if(admin)await admin.end();scope.setTenancyMode(previous);
  for(const cid of containers.reverse()){const actual=JSON.parse(docker(['inspect',cid]))[0];assert.equal(actual.Config.Labels['org.nightscout.test.owner'],owner);docker(['rm','-f','-v',cid]);}
  fs.rmSync(directory,{recursive:true,force:true});
 }
});
