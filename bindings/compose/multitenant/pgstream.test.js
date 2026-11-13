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
  assert.match(wire.source.postgres.replication.plugin.add_tables,/tenant_consumer_checkpoint/);
  const heartbeat=require('../../lib/pgstream/evaluator').routes({...evaluator,namespaces:evaluator.postgres.namespaces}).find(row=>row.kind==='heartbeat');
  assert.equal(heartbeat.schema,evaluator.postgres.namespaces.clock);
  assert.notEqual(heartbeat.schema,'pgstream','upstream drops internal-schema DML before webhook delivery');
  assert.equal(evaluator.changeFeed,undefined);assert.equal(realtime.changeFeed,undefined);assert.equal(evaluator.timeIntervalMs,60000);
  assert.equal(realtime.completedOutput.namespace,evaluator.postgres.namespaces.checkpoint);
  const checkpoint=docs.admin.config.provisioning.checkpoints.find(row=>row.consumer===evaluator.consumer+'-completed');assert(checkpoint);assert.equal(checkpoint.namespace,realtime.completedOutput.namespace);
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'ns-pgstream-docs-'));
  for(const [role,config]of Object.entries(docs.configs)){const folder=path.join(directory,role);fs.mkdirSync(folder);for(const [name,value]of Object.entries({'config.json':config,'operation.json':docs.operations[role],'evaluator-metadata.json':evaluator}))fs.writeFileSync(path.join(folder,name),JSON.stringify(value));}
  plan.validateFiles(directory,docs);
  const broken=structuredClone(docs);delete broken.configs.realtime.completedOutput;assert.throws(()=>plan.validateFiles(directory,broken),/PGSTREAM_COMPLETED_SOURCE_MISMATCH/);
 }finally{if(directory)fs.rmSync(directory,{recursive:true,force:true});if(saved===undefined)delete process.env.NS_PGSTREAM;else process.env.NS_PGSTREAM=saved;}
});
