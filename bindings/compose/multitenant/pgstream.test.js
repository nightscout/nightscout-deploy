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
  // Six clinical row routes join four metadata routes in the maintained source.
  assert.equal(wire.source.postgres.replication.plugin.add_tables.split(',').length,10);
  const routes=require('../../lib/pgstream/evaluator').routes({...evaluator,namespaces:evaluator.postgres.namespaces});
  assert.deepEqual(wire.source.postgres.replication.plugin.add_tables.split(',').sort(),routes.map(row=>row.schema+'.'+row.table).sort());
  assert.equal(routes.some(row=>row.kind==='clock'||row.table==='tenant_write_clock'),false,'INTERNAL_CLOCK_ROUTE_RETIRED');
  assert.equal(routes.some(row=>row.kind==='heartbeat'||row.table==='nightscout_heartbeat'),false,'SYNTHETIC_HEARTBEAT_ROUTE_RETIRED');
  assert.deepEqual(evaluator.pgstream.bounds,{stepMs:5000,recoveryMs:30000,pendingMs:30000});
  assert.equal(evaluator.pgstream.receiver.url,'http://evaluator:19913/');assert.equal(evaluator.pgstream.receiver.trust,'network');assert.equal(evaluator.pgstream.binaryEnv,undefined);assert.equal(evaluator.pgstream.configFileEnv,undefined);assert.equal(evaluator.pgstream.bounds.maxRestarts,undefined);assert.equal(evaluator.pgstream.bounds.stopMs,undefined);assert.equal(docs.environments.evaluator.NS_PGSTREAM_BINARY,undefined);assert.equal(docs.environments.evaluator.NS_PGSTREAM_CONFIG,undefined);
  assert.equal(docs.environments.evaluator.NS_STREAM_RECOVERY_PG,urls.pgstream);assert.equal(evaluator.pgstream.recovery.connectionEnv,'NS_STREAM_RECOVERY_PG');assert.match(evaluator.pgstream.generation,/^[a-f0-9]{32}$/);assert.equal(evaluator.pgstream.transactionRows,10000);assert.equal(wire.source.postgres.replication.plugin.include_transactions,true);assert.deepEqual(wire.target.webhooks.notifier.transaction_batch,{max_rows:evaluator.pgstream.transactionRows,max_bytes:evaluator.pgstream.receiver.maxBytes});
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
 const notifier=binding.wire({pgstream:{transactionRows:10000,slot:'synthetic_slot'}},'postgres://synthetic@127.0.0.1/synthetic',{routes:[{schema:'synthetic_clock',table:'tenant_write_clock'}]}).target.webhooks.notifier;
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

test('native cohort wire has explicit preserved bounds and framing with red/restored controls',()=>{
 const config={maxRows:1,maxBytes:1,pgstream:{transactionRows:128,slot:'synthetic_slot',receiver:{maxBytes:1048576}}};
 const wire=()=>binding.wire(config,'postgres://synthetic@127.0.0.1/synthetic',{routes:[{schema:'synthetic_entries',table:'entries'}]});
 const criterion=value=>{assert.equal(value.source.postgres.replication.plugin.include_transactions,true,'NATIVE_FRAMING_REQUIRED');assert.deepEqual(value.target.webhooks.notifier.transaction_batch,{max_rows:128,max_bytes:1048576},'BOUNDED_NATIVE_COHORT_REQUIRED');};
 criterion(wire());for(const mutate of [x=>{x.source.postgres.replication.plugin.include_transactions=false;},x=>{delete x.target.webhooks.notifier.transaction_batch;},x=>{x.target.webhooks.notifier.transaction_batch.max_rows=1;}]){const bad=wire();mutate(bad);assert.throws(()=>criterion(bad));criterion(wire());}
 for(const cap of [undefined,0,-1,NaN,1000001]){assert.throws(()=>binding.wire({...config,pgstream:{...config.pgstream,transactionRows:cap}},'postgres://synthetic@127.0.0.1/synthetic',{routes:[]}),/positive transaction/);}
});

test('image builds the exact maintained source patch and final deterministic binary; pin/source controls fail',()=>{
 const dockerfile=fs.readFileSync(path.join(__dirname,'Dockerfile'),'utf8'),patch=fs.readFileSync(path.join(__dirname,'pgstream-exact-handover.patch'));
 const patchHash=crypto.createHash('sha256').update(patch).digest('hex'),binary=require('../../lib/pgstream/evaluator').BINARY_SHA256,provenance=require('./pgstream-source.json');
 assert.equal(provenance.binarySha256,binary);assert.equal(provenance.patchSha256,patchHash);assert(dockerfile.includes(provenance.connectorCommit));assert(dockerfile.includes(provenance.upstreamCommit));assert(dockerfile.includes(provenance.goBuilder));
 const criterion=(docker,bytes=patch)=>{
  assert(docker.includes('golang:1.26.11-alpine@sha256:f496f8c537ed506626ee1a6913afb32c45068a48697163c088f604cc775a0c38'),'PINNED_GO_BUILDER_REQUIRED');
  assert(docker.includes('git fetch --depth=1 origin 97d7ab464f0accf6cf1373b3c3f7b328debae4b9'),'MAINTAINED_UPSTREAM_COMMIT_REQUIRED');
  assert(docker.includes(crypto.createHash('sha256').update(bytes).digest('hex')+'  /tmp/pgstream-exact-handover.patch'),'PATCH_HASH_REQUIRED');
  assert(docker.includes(binary+'  /out/pgstream'),'CORE_BINARY_PIN_MUST_MATCH_BUILD');
  assert(docker.includes('CGO_ENABLED=0 GOTOOLCHAIN=local')&&docker.includes('-trimpath -buildvcs=false'),'REPRODUCIBLE_BINARY_FLAGS_REQUIRED');
  assert(docker.includes('COPY --from=pgstream-build --chmod=0555 /out/pgstream /usr/local/bin/pgstream'),'BUILT_BINARY_REQUIRED');
 };
 criterion(dockerfile);
 for(const broken of [dockerfile.replace(binary,'0'.repeat(64)),dockerfile.replace(patchHash,'0'.repeat(64)),dockerfile.replace('origin 97d7ab464f0accf6cf1373b3c3f7b328debae4b9','origin main')]){assert.throws(()=>criterion(broken));criterion(dockerfile);}
 assert.throws(()=>criterion(dockerfile,Buffer.concat([patch,Buffer.from('\nchanged')])));criterion(dockerfile);
});


test('startup transport uses the complete canonical roster before native run without changing delivery policy',()=>{
 const base={pgstream:{slot:'synthetic_slot',transactionRows:128,receiver:{url:'http://evaluator:19913/',trust:'network',bindHost:'0.0.0.0',maxBytes:4096,timeoutMs:1000},startupTransport:{timeoutMs:7200000,retryIntervalMs:25}}};
 const options={routes:[{schema:'synthetic_entries',table:'entries'}]};
 const wire=config=>binding.wire(config,'postgres://synthetic@127.0.0.1/synthetic',options);
 const criterion=(config,value)=>{
  const expected=config.processAssignment?config.processAssignment.receivers.map(url=>new URL('pgstream',url).href):[new URL('pgstream',config.pgstream.receiver.url).href];
  assert.deepEqual(value.target.webhooks.startup_transport,{receivers:expected,timeout_ms:7200000,retry_interval_ms:25},'COMPLETE_STARTUP_ROSTER_AND_EXPLICIT_BUDGET_REQUIRED');
  assert.equal(value.target.webhooks.notifier.client_timeout,2000);assert.equal(value.target.webhooks.notifier.strict_mode,true);assert.deepEqual(value.target.webhooks.notifier.backoff,{constant:{max_retries:1,interval:50}});
 };
 const single=wire(base);criterion(base,single);assert.equal(single.target.webhooks.notifier.transaction_batch.slice_receivers,undefined,'startup does not enable sliced delivery implicitly');
 const many={...base,processAssignment:{count:2,ordinal:0,receivers:['http://evaluator:19913/','http://evaluator-2:19913/']}};
 const actual=wire(many);criterion(many,actual);assert.deepEqual(actual.target.webhooks.startup_transport.receivers,actual.target.webhooks.notifier.transaction_batch.slice_receivers);
 for(const mutate of [v=>{delete v.target.webhooks.startup_transport;},v=>{v.target.webhooks.startup_transport.receivers.pop();},v=>{v.target.webhooks.startup_transport.receivers.reverse();},v=>{v.target.webhooks.startup_transport.timeout_ms=300000;}]){const bad=structuredClone(actual);mutate(bad);assert.throws(()=>criterion(many,bad));criterion(many,wire(many));}
 const absent=structuredClone(base);delete absent.pgstream.startupTransport;assert.equal(wire(absent).target.webhooks.startup_transport,undefined);
 for(const value of [{timeoutMs:0,retryIntervalMs:1},{timeoutMs:100,retryIntervalMs:101},{timeoutMs:1.5,retryIntervalMs:1}])assert.throws(()=>wire({...base,pgstream:{...base.pgstream,startupTransport:value}}),/startup transport milliseconds/);
});
