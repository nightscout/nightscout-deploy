'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const plan=require('./config'),binding=require('./pgstream');
test('selected pgstream documents, raw-to-wire config and completed-consumer provisioning agree',()=>{
 const saved=process.env.NS_PGSTREAM;process.env.NS_PGSTREAM='1';let directory;
 try{
  const layout=plan.layout(),urls=Object.fromEntries(Object.entries(layout.roles).map(([kind,role])=>[kind,'postgres://'+role+':'+crypto.randomBytes(20).toString('hex')+'@postgres/nightscout_compose_test']));
  const docs=plan.documents({layout,urls,tokens:[],publicKeys:[],managementKeys:[],vaultAddress:'https://vault:8200',registryMode:true});
  const evaluator=docs.configs.evaluator,realtime=docs.configs.realtime,wire=binding.wire(evaluator,urls.pgstream);
  assert.equal(new URL(wire.source.postgres.url).searchParams.get('sslmode'),'disable');
  assert.equal(new URL(wire.target.webhooks.subscriptions.store.url).searchParams.get('pool_max_conns'),'2');
  assert.equal(wire.target.webhooks.notifier.strict_mode,true);
  assert(!wire.source.postgres.replication.plugin.add_tables.includes('tenant_consumer_checkpoint'));
  // Six clinical row routes join the five metadata routes in the maintained source.
  assert.equal(wire.source.postgres.replication.plugin.add_tables.split(',').length,11);
  const routes=require('../../lib/pgstream/evaluator').routes({...evaluator,namespaces:evaluator.postgres.namespaces});
  assert.deepEqual(wire.source.postgres.replication.plugin.add_tables.split(',').sort(),routes.map(row=>row.schema+'.'+row.table).sort());
  assert.equal(routes.some(row=>row.kind==='heartbeat'||row.table==='nightscout_heartbeat'),false,'SYNTHETIC_HEARTBEAT_ROUTE_RETIRED');
  assert.deepEqual(evaluator.pgstream.bounds,{stepMs:5000,recoveryMs:30000,pendingMs:30000});
  assert.equal(evaluator.pgstream.receiver.url,'http://evaluator:19913/');assert.equal(evaluator.pgstream.receiver.trust,'network');assert.equal(evaluator.pgstream.binaryEnv,undefined);assert.equal(evaluator.pgstream.configFileEnv,undefined);assert.equal(evaluator.pgstream.bounds.maxRestarts,undefined);assert.equal(evaluator.pgstream.bounds.stopMs,undefined);assert.equal(docs.environments.evaluator.NS_PGSTREAM_BINARY,undefined);assert.equal(docs.environments.evaluator.NS_PGSTREAM_CONFIG,undefined);
  assert.equal(evaluator.changeFeed,undefined);assert.equal(realtime.changeFeed,undefined);assert.equal(evaluator.timeIntervalMs,60000);
  assert.equal(realtime.completedOutput.namespace,evaluator.postgres.namespaces.checkpoint);
  const checkpoint=docs.admin.config.provisioning.checkpoints.find(row=>row.consumer===evaluator.consumer+'-completed');assert(checkpoint);assert.equal(checkpoint.namespace,realtime.completedOutput.namespace);
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'ns-pgstream-docs-'));
  for(const [role,config]of Object.entries(docs.configs)){const folder=path.join(directory,role);fs.mkdirSync(folder);for(const [name,value]of Object.entries({'config.json':config,'operation.json':docs.operations[role],'evaluator-metadata.json':evaluator}))fs.writeFileSync(path.join(folder,name),JSON.stringify(value));}
  plan.validateFiles(directory,docs);
  const broken=structuredClone(docs);delete broken.configs.realtime.completedOutput;assert.throws(()=>plan.validateFiles(directory,broken),/PGSTREAM_COMPLETED_SOURCE_MISMATCH/);
 }finally{if(directory)fs.rmSync(directory,{recursive:true,force:true});if(saved===undefined)delete process.env.NS_PGSTREAM;else process.env.NS_PGSTREAM=saved;}
});

// pgstream v1.6.0 cmd/config/config_yaml.go WebhookNotifierConfig reads Backoff;
// constant at notifier level is ignored and falls back to upstream defaults.
test('canonical wire places the bounded retry policy in the maintained notifier backoff namespace',()=>{
 const notifier=binding.wire({pgstream:{slot:'synthetic_slot'}},'postgres://synthetic@127.0.0.1/synthetic',{routes:[{schema:'synthetic_clock',table:'tenant_write_clock'}]}).target.webhooks.notifier;
 const criterion=value=>{
  assert.deepEqual(value.backoff,{constant:{max_retries:1,interval:50}},'PGSTREAM_BACKOFF_NAMESPACE_REQUIRED');
  assert.equal(Object.hasOwn(value,'constant'),false,'PGSTREAM_IGNORED_CONSTANT_FORBIDDEN');
  assert.equal(value.client_timeout,2000);assert.equal(value.worker_count,1);assert.equal(value.strict_mode,true);
 };
 criterion(notifier);
 const wrongLevel=structuredClone(notifier);wrongLevel.constant=wrongLevel.backoff.constant;delete wrongLevel.backoff;
 const omitted=structuredClone(notifier);delete omitted.backoff;
 for(const broken of [wrongLevel,omitted]){assert.throws(()=>criterion(broken),/PGSTREAM_BACKOFF_NAMESPACE_REQUIRED/);criterion(notifier);}
});
