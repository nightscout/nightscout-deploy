'use strict';
// One evaluator-owned maintained pgstream process, loopback-only subscriptions
// and receiver. DBA setup is never part of the running role's startup command.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
function enabled(env=process.env){if(env.NS_PGSTREAM!==undefined&&!['0','1'].includes(env.NS_PGSTREAM))throw new Error('PGSTREAM_SELECTION_INVALID');return env.NS_PGSTREAM==='1';}
function configure(docs,layout){
 if(!enabled())return;
 if(require('./evaluator-workers').selection())throw new Error('PGSTREAM_EVALUATOR_PARTITION_UNQUALIFIED');
 const evaluator=docs.configs.evaluator,realtime=docs.configs.realtime;
 delete evaluator.changeFeed;delete realtime.changeFeed;
 evaluator.pgstream=configuration(layout);
 evaluator.timeIntervalMs=60000; // single-site heartbeat cadence; exact due instants remain independent
 realtime.completedOutput={namespace:layout.namespaces.eval_checkpoint,consumer:evaluator.consumer};
 Object.assign(docs.environments.evaluator,{NS_PGSTREAM_BINARY:'/usr/local/bin/pgstream',NS_PGSTREAM_CONFIG:'/run/ns-config/pgstream.yaml'});
 if(docs.feed)docs.feed.environment.NS_PGSTREAM='1';
}
function configuration(layout){
 return {binaryEnv:'NS_PGSTREAM_BINARY',configFileEnv:'NS_PGSTREAM_CONFIG',receiverPort:19913,slot:layout.prefix+'_pgstream',streamRole:layout.roles.pgstream,
   bounds:{heartbeatMs:1000,stallMs:5000,stepMs:5000,stopMs:2000,recoveryMs:30000,pendingMs:30000,maxRestarts:3}};
}
function descriptor(layout){return {consumer:'evaluator-compose-demo',namespaces:{clock:layout.namespaces.clock,checkpoint:layout.namespaces.eval_checkpoint},trustedWorker:{settings:layout.namespaces.display_settings,operatorPolicy:layout.namespaces.operator_policy,activity:layout.namespaces.control},pgstream:configuration(layout)};}
function wire(config,runtimeURL){
 const streamURL=new URL(runtimeURL);streamURL.searchParams.set('sslmode','disable');runtimeURL=streamURL.href;
 const storeURL=new URL(runtimeURL);storeURL.searchParams.set('pool_max_conns','2');
 return {source:{postgres:{url:runtimeURL,mode:'replication',replication:{replication_slot:config.pgstream.slot,plugin:{add_tables:require('../../lib/pgstream/evaluator').routes({...config,namespaces:config.postgres?.namespaces||config.namespaces}).map(row=>row.schema+'.'+row.table).join(',')}}}},
   target:{webhooks:{subscriptions:{store:{url:storeURL.href,cache:{enabled:false}},server:{address:'127.0.0.1:19914'}},notifier:{worker_count:1,strict_mode:true,client_timeout:2000,constant:{max_retries:1,interval:50}}}}};
}
async function init({admin,adminURL,layout,config}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ns-pgstream-dba-'));
 try{
  const connection=new URL(adminURL);connection.searchParams.set('sslmode','disable');
  const file=path.join(directory,'init.yaml');fs.writeFileSync(file,JSON.stringify({source:{postgres:{url:connection.href,replication:{replication_slot:config.pgstream.slot}}}}),{mode:0o600});
  execFileSync('/usr/local/bin/pgstream',['init','-c',file],{stdio:['ignore','pipe','pipe'],timeout:30000});
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
 const q=require('./config').quote,role=q(layout.roles.pgstream),evaluator=q(layout.roles.evaluator),realtime=q(layout.roles.realtime),table=q(layout.namespaces.eval_checkpoint)+'.tenant_consumer_checkpoint',heartbeat=q(layout.namespaces.clock)+'.nightscout_heartbeat';
 await admin.query('ALTER ROLE '+role+' REPLICATION NOINHERIT CONNECTION LIMIT 4');
 await admin.query('CREATE TABLE '+heartbeat+'(id integer PRIMARY KEY CHECK(id=1),revision bigint NOT NULL CHECK(revision>=0))');
 await admin.query('INSERT INTO '+heartbeat+' VALUES(1,0)');
 await admin.query('CREATE TABLE pgstream.webhook_subscriptions(url text,schema_name text,table_name text,event_types text[],PRIMARY KEY(url,schema_name,table_name))');
 await admin.query('REVOKE ALL ON SCHEMA pgstream FROM PUBLIC');
 await admin.query('REVOKE ALL ON ALL TABLES IN SCHEMA pgstream FROM PUBLIC');
 await admin.query('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgstream FROM PUBLIC');
 await admin.query('GRANT USAGE,CREATE ON SCHEMA pgstream TO '+role);
 await admin.query('GRANT SELECT ON pgstream.webhook_subscriptions TO '+role);
 await admin.query('GRANT USAGE ON SCHEMA pgstream TO '+evaluator);
 await admin.query('GRANT SELECT ON pgstream.webhook_subscriptions TO '+evaluator);
 await admin.query('GRANT SELECT,UPDATE(revision) ON '+heartbeat+' TO '+evaluator);
 const consumer=config.consumer+'-completed';
 // Trusted metadata access applies only to the completed consumer. Clinical
 // row policies retain their tenant binding and FORCE RLS.
 await admin.query('CREATE POLICY pgstream_evaluator_metadata ON '+table+' TO '+evaluator+" USING (consumer='"+consumer+"') WITH CHECK (consumer='"+consumer+"')");
 await admin.query('GRANT USAGE ON SCHEMA '+q(layout.namespaces.eval_checkpoint)+' TO '+realtime);
 await admin.query('GRANT SELECT ON '+table+' TO '+realtime);
 await admin.query('CREATE POLICY pgstream_realtime_output ON '+table+' FOR SELECT TO '+realtime+" USING (consumer='"+consumer+"')");
 await admin.query('CREATE INDEX pgstream_pending_work ON '+table+" (consumer,((projection->0->>'pendingAt')::bigint)) WHERE (projection->0->>'enabled')::boolean IS TRUE AND (projection->0->>'pendingAt') IS NOT NULL");
 await admin.query('CREATE INDEX pgstream_due_work ON '+table+" (consumer,((projection->0->>'nextDueAt')::bigint)) WHERE (projection->0->>'enabled')::boolean IS TRUE AND (projection->0->>'nextDueAt') IS NOT NULL");
 const routes=require('../../lib/pgstream/evaluator').routes(config);
 for(const route of [...routes,{schema:'',table:'',kind:'schema'}])await admin.query('INSERT INTO pgstream.webhook_subscriptions VALUES($1,$2,$3,$4)',[
   'http://127.0.0.1:'+config.pgstream.receiverPort+'/pgstream',route.schema,route.table,route.kind==='schema'?['M']:['I','U','D']]);
}
module.exports={enabled,configure,configuration,descriptor,wire,init};
