'use strict';
// Tiny synthetic binding proof: actual generated SQL/config and source adapters.
// The issued evaluator proof and the operator each use their deployment role.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync,spawn}=require('node:child_process');
const {Client}=require('pg'),plan=require('../config'),binding=require('../native-lifecycle'),bridge=require('../restore'),scope=require('../../../lib/storage/tenant-scope');
const PG='postgres@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97',VAULT='hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2';
const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}).trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function ready(fn){let last;for(const until=Date.now()+30000;Date.now()<until;){try{return await fn();}catch(e){last=e;await sleep(200);}}throw last;}
test('actual tiny native generated provisioning, export, logical restore and private recovery retain B and queue IDs',{skip:process.env.NS_NATIVE_LIFECYCLE_BIND_TEST!=='1',timeout:180000},async()=>{
 assert.match(process.env.NS_NATIVE_BIND_CORE_COMMIT||'',/^[a-f0-9]{40}$/);assert.match(process.env.NS_NATIVE_BIND_DEPLOY_COMMIT||'',/^[a-f0-9]{40}$/);
 const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
 const id=crypto.randomBytes(4).toString('hex'),owner='native_bind_'+id,containers=[],directory=fs.mkdtempSync(path.join(os.tmpdir(),'ns-native-bind-'));
 const l=plan.layout(),q=plan.quote,ns=l.namespaces,table=(kind,name)=>q(ns[kind])+'.'+q(name),password=crypto.randomBytes(24).toString('hex'),vaultToken=crypto.randomBytes(24).toString('hex');
 let admin,provisioning,adminURI,selection,raw,config,env,docs,floorServer,floorService;
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
  await require('../platform-startup').install(admin,l);
  // Actual native logical source, without a maintained producer/whole boot claim.
  // Apply the evaluator's bookkeeping grant from pgstream.init; this fixture creates only the slot.
  const work=require('../../../lib/pgstream/checkpoint').WORK_COLUMNS;
  await admin.query('GRANT UPDATE('+work.map(q).join(',')+') ON '+table('eval_checkpoint','tenant_consumer_checkpoint')+' TO '+q(l.roles.evaluator));
  const slot=require('../pgstream').descriptor(l).pgstream.slot;await admin.query("SELECT pg_create_logical_replication_slot($1,'pgoutput')",[slot]);
  const source=await binding.source(admin,slot);
  const output=path.join(directory,'generated'),writePrivate=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,JSON.stringify(value),{mode:0o600,flag:'wx'});};
  await require('../registry-bootstrap').finish({options:{output,uid:process.getuid(),gid:process.getgid(),sourceCommit:process.env.NS_NATIVE_BIND_CORE_COMMIT,deployCommit:process.env.NS_NATIVE_BIND_DEPLOY_COMMIT,vault:{origin:'https://vault:8200'}},request,rootToken:vaultToken,layout:l,roleURLs:urls,writePrivate,admin,adminURL:adminURI,nativeSource:source});
  raw=JSON.parse(fs.readFileSync(path.join(output,'ops/config.json')));env={...JSON.parse(fs.readFileSync(path.join(output,'ops/env.json'))),NS_DEMO_TOKEN_A:'synthetic',NS_DEMO_TOKEN_B:'synthetic'};
  selection=require('../../../lib/tenant-lifecycle/native-selection').create(raw.nativeSelection);
  docs={evaluator:JSON.parse(fs.readFileSync(path.join(output,'evaluator/config.json')))};
  assert.equal(selection.binding.generation,docs.evaluator.pgstream.generation);
  for(const role of plan.serviceRoles)assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output,role,'operation.json'))).nativeSelection,raw.nativeSelection);
  const adminDoc=JSON.parse(fs.readFileSync(path.join(output,'admin/config.json'))),provisionerToken=fs.readFileSync(path.join(output,'admin/vault-token'),'utf8').trim();
  provisioning=require('../../../lib/tenant-registry/provision').createProvisioning({connectionString:urls.provisioner,namespaces:adminDoc.provisioning.namespaces,checkpoints:adminDoc.provisioning.checkpoints,ownerCatalogue:adminDoc.provisioning.ownerPolicy.catalogue,actor:adminDoc.provisioning.operator,vault:{address:vaultAddress,mount:l.mount,getToken:async()=>provisionerToken,allowInsecureLoopback:true,timeoutMs:5000}});
  for(const [i,tenant]of [plan.A,plan.B].entries())assert.equal((await provisioning.provision({id:tenant,hosts:[plan.tenantAlias(i)],issueRootSecret:true})).outcome,'created');
  await provisioning.close();provisioning=null;
  for(const tenant of [plan.A,plan.B]){await admin.query('BEGIN');try{await admin.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);for(const kind of [...plan.clinical,'settings'])await admin.query('INSERT INTO '+table(kind,kind)+' (tenant_id,id_kind,doc) VALUES($1,\'string\',$2)',[tenant,JSON.stringify({_id:'native-'+kind,identifier:'native-'+kind,value:1,type:'sgv',srvCreated:Date.now()-200,srvModified:Date.now()-100})]);await admin.query('UPDATE '+table('clock','tenant_write_clock')+' SET last_stamp=$2 WHERE tenant_id=$1',[tenant,String(Date.now())]);await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;}}
  const values=require('../../../tests/fixtures/tenant-deployment-notifications').notificationInputs({tenants:[plan.A,plan.B],now:Date.now(),outboxRole:l.roles.outbox,checkpointWriterRole:l.roles.evaluator,ackReaderRole:l.roles.alarm}).rows;
  for(const [name,rows]of Object.entries(values))for(const row of rows.filter(v=>v.consumer==='synthetic_realtime'&&v.tenant_id===plan.A)){const keys=Object.keys(row);await admin.query('INSERT INTO '+table('outbox',name)+' ('+keys.map(q).join(',')+') VALUES('+keys.map((_,i)=>'$'+(i+1)).join(',')+')',keys.map(key=>row[key]));}
  for(const tenant of [plan.A,plan.B])await admin.query('INSERT INTO '+table('control','tenant_lifecycle_restore_authority')+' (tenant_id,role_oid,active) VALUES($1,$2::regrole::oid,true)',[tenant,l.roles.operator]);
  const input=JSON.parse(fs.readFileSync(path.join(output,'evaluator/env.json')));
  const evaluator=require('../../../lib/server/serve/evaluator-config').parse(docs.evaluator,input,require('../../../lib/server/internal-api/listener-config').resolve(['evaluator'],input));
  const selected=require('../../../lib/server/serve/operation-cohort-config').load({...input,MULTITENANT_OPERATION_CONFIG:path.join(output,'evaluator/operation.json')});
  const verifier=require('../../../lib/server/serve/platform-verification').create({namespace:evaluator.platformVerification.namespace,connectionString:urls.platform_verifier,targets:[{
    role:'evaluator',config:evaluator,operationProfileDigest:selected.nativeSelection.digest,check:()=>require('../../../lib/server/serve/platform-verification-admin').checkTarget({role:'evaluator',config:evaluator,operationConfig:selected})
  }]});
  const platformAdmin=require('../../../lib/server/serve/platform-verification-admin');
  const rolePath=file=>path.join(output,'api',file);
  const target={role:'api',configFile:rolePath('config.json'),environmentFile:rolePath('env.json'),operationConfigFile:rolePath('operation.json')};
  floorService=platformAdmin.create({namespace:raw.floorVerification.namespace,connectionString:urls.platform_verifier,targets:[target]},{});
  let admitFloor=true;
  floorServer=require('node:http').createServer(platformAdmin.api({service:floorService,admitted:()=>admitFloor,
    fallback:(_req,res)=>{res.writeHead(404);res.end();}}));
  await new Promise((resolve,reject)=>{floorServer.once('error',reject);floorServer.listen(0,'127.0.0.1',resolve);});
  assert.equal(raw.floorVerification.adminOrigin,'http://admin:1342');
  raw.floorVerification.adminOrigin='http://127.0.0.1:'+floorServer.address().port;
  config=bridge.validateConfig(raw,env);
  async function verifyFloorGeneration(){
   const result=await admin.query('SELECT f.status,f.generation=w.generation AS current FROM '+q(raw.floorVerification.namespace)+'.verified_tenant_floor f JOIN '+table('control','tenant_lifecycle_windows')+' w USING(tenant_id) WHERE f.tenant_id=$1',[plan.A]);
   assert.deepEqual(result.rows,[{status:'verified',current:true}]);
  }
  await assert.rejects(bridge.capture(config,plan.A,env),{code:'COMPOSE_OPERATOR_SELECTION_UNVERIFIED'});
  await verifier.verify().catch(error=>{console.error('NATIVE_BIND_VERIFY_REFUSAL',error.verificationDiagnostic);throw error;});
  const withAdmin=async fn=>fn(admin);
  const rows=async(tenant)=>{const result={};for(const entry of raw.catalogues)for(const name of entry.tables)result[entry.kind+'.'+name]=require('../../../lib/tenant-lifecycle/artifact').digestRows((await admin.query('SELECT * FROM '+q(raw.namespaces[entry.kind])+'.'+q(name)+' WHERE tenant_id=$1',[tenant])).rows);return result;};
  const beforeB=await rows(plan.B),queues=async()=>{const result={};for(const name of ['tenant_notification_heads','tenant_notification_requests','tenant_notification_state'])result[name]=require('../../../lib/tenant-lifecycle/artifact').digestRows((await admin.query('SELECT * FROM '+table('outbox',name)+' WHERE tenant_id=$1',[plan.A])).rows);return result;},queueBefore=await queues();
  assert.equal(raw.version,3);assert.equal(Object.hasOwn(raw,'tenants'),false);assert.equal(Object.hasOwn(raw.control,'locks'),false);
  const grant=table('control','tenant_lifecycle_restore_authority');
  const allowA=active=>admin.query('UPDATE '+grant+' SET active=$2 WHERE tenant_id=$1 AND role_oid=$3::regrole::oid',[plan.A,active,l.roles.operator]);
  await allowA(false);
  await assert.rejects(bridge.capture(config,plan.A,env),{code:'COMPOSE_OPERATOR_TENANT_REFUSED'});
  await bridge.capture(config,plan.B,env);
  await allowA(true);
  const artifact=await bridge.capture(config,plan.A,env);
  const mutate=async()=>withAdmin(async client=>{await client.query('BEGIN');try{await client.query("SELECT set_config('app.current_tenant_id',$1,true)",[plan.A]);await client.query('UPDATE '+table('entries','entries')+" SET doc=jsonb_set(doc,'{value}','99'::jsonb) WHERE tenant_id=$1",[plan.A]);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}});
  await mutate();const restored=await bridge.restore(config,artifact,env);assert.equal(restored.result.tables,7);await verifyFloorGeneration();assert.deepEqual(await queues(),queueBefore);assert.deepEqual(await rows(plan.B),beforeB);
  const beforeA=await rows(plan.A);
  for(const change of [v=>{v.nativeSelection.generation='foreign-generation';},v=>{v.nativeSelection.source.system_id+='1';}]){const bad=structuredClone(raw);change(bad);const parsed=bridge.validateConfig(bad,env);await assert.rejects(bridge.capture(parsed,plan.A,env),{code:'COMPOSE_OPERATOR_SELECTION_UNVERIFIED'});assert.deepEqual(await rows(plan.A),beforeA);}
  await verifier.invalidate();
  await assert.rejects(bridge.restore(config,artifact,env),{code:'COMPOSE_OPERATOR_SELECTION_UNVERIFIED'});
  assert.equal((await admin.query('SELECT phase FROM '+table('control','tenant_lifecycle_windows')+' WHERE tenant_id=$1',[plan.A])).rows[0].phase,'active');
  await verifier.verify();
  // The operator's own private pool (max 1) reads the held claim and resumes under it.
  async function recover(){
   const state=(await admin.query('SELECT claim_id FROM '+table('control','tenant_lifecycle_windows')+' WHERE tenant_id=$1',[plan.A])).rows[0];
   const result=await bridge.recover(config,'resume',plan.A,state.claim_id,env);assert.equal(result.state,'active');await verifyFloorGeneration();return result;
  }
  admitFloor=false;
  await assert.rejects(bridge.restore(config,artifact,env),{code:'COMPOSE_OPERATOR_FLOOR_VERIFICATION_REFUSED'});
  await assert.rejects(recover(),{code:'COMPOSE_OPERATOR_FLOOR_VERIFICATION_REFUSED'});
  assert.equal((await admin.query('SELECT phase FROM '+table('control','tenant_lifecycle_windows')+' WHERE tenant_id=$1',[plan.A])).rows[0].phase,'suspended');
  assert.deepEqual(await rows(plan.B),beforeB);
  admitFloor=true;
  assert.equal((await recover()).interrupted,'data-replaced');
  await mutate();await assert.rejects(bridge.restore(config,artifact,env,{onRow(){throw Error('NATIVE_BIND_BEFORE_DATA');}}),/NATIVE_BIND_BEFORE_DATA/);assert.equal((await recover()).interrupted,'before-data');
  // A verified selection may be withdrawn after the data commit. It must
  // remain suspended until the operator's next pre-start verification.
  await assert.rejects(bridge.restore(config,artifact,env,{onCommitted:()=>verifier.invalidate()}),{code:'COMPOSE_OPERATOR_SELECTION_UNVERIFIED'});
  assert.equal((await admin.query('SELECT phase FROM '+table('control','tenant_lifecycle_windows')+' WHERE tenant_id=$1',[plan.A])).rows[0].phase,'suspended');
  await verifier.verify();await verifier.close();
  assert.equal((await recover()).interrupted,'data-replaced');
  assert.deepEqual(await rows(plan.B),beforeB);assert.deepEqual(await queues(),queueBefore);await bridge.capture(config,plan.A,env);
 }finally{
  if(floorServer)await new Promise(resolve=>floorServer.close(resolve));
  if(floorService)await floorService.close();
  if(provisioning)await provisioning.close();if(admin)await admin.end();scope.setTenancyMode(previous);
  for(const cid of containers.reverse()){const actual=JSON.parse(docker(['inspect',cid]))[0];assert.equal(actual.Config.Labels['org.nightscout.test.owner'],owner);docker(['rm','-f','-v',cid]);}
  fs.rmSync(directory,{recursive:true,force:true});
 }
});
