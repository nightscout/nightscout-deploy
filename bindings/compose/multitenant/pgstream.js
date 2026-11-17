'use strict';
// One platform-managed maintained pgstream service targets the admitted intake.
// DBA setup is separate from both serving roles and the streaming worker.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
function enabled(env=process.env){if(env.NS_PGSTREAM!==undefined&&env.NS_PGSTREAM!=='1')throw new Error('PGSTREAM_LEGACY_MODE_RETIRED');return true;}
function configure(docs,layout){
 enabled();
 if(require('./evaluator-workers').selection())throw new Error('PGSTREAM_EVALUATOR_PARTITION_UNQUALIFIED');
 const evaluator=docs.configs.evaluator,realtime=docs.configs.realtime;
 delete evaluator.changeFeed;delete realtime.changeFeed;
 evaluator.pgstream=configuration(layout);
 evaluator.timeIntervalMs=60000; // time-only work retains its exact durable due instants
 realtime.completedOutput={namespace:layout.namespaces.eval_checkpoint,consumer:evaluator.consumer};
 delete docs.environments.evaluator.NS_PGSTREAM_BINARY;delete docs.environments.evaluator.NS_PGSTREAM_CONFIG;
}
function configuration(layout){
 return {receiver:{url:'http://evaluator:19913/',trust:'network',bindHost:'0.0.0.0',maxBytes:16777216,timeoutMs:5000},slot:layout.prefix+'_pgstream',streamRole:layout.roles.pgstream,generation:require('node:crypto').randomBytes(16).toString('hex'),
   recovery:{connectionEnv:'NS_STREAM_RECOVERY_PG',timeoutMs:5000,maxQueued:32},
   bounds:{stepMs:5000,recoveryMs:30000,pendingMs:30000}};
}
function receiverURL(config){
 const receiver=require('../../lib/server/internal-api/transport').options(config.pgstream.receiver);
 if(!receiver.url)throw new TypeError('Explicit network intake receiver required');
 return new URL('pgstream',receiver.url).href;
}
function descriptor(layout){return {consumer:'evaluator-compose-demo',namespaces:{...Object.fromEntries(['entries','treatments','devicestatus','profile','food','activity'].map(domain=>[domain,layout.namespaces[domain]])),clock:layout.namespaces.clock,checkpoint:layout.namespaces.eval_checkpoint},trustedWorker:{settings:layout.namespaces.display_settings,operatorPolicy:layout.namespaces.operator_policy,activity:layout.namespaces.control},pgstream:configuration(layout)};}
function wire(config,runtimeURL,{subscriptionsPort=19914,routes}={}){
 if(!Number.isSafeInteger(subscriptionsPort)||subscriptionsPort<1024||subscriptionsPort>65535)throw new TypeError('Explicit subscriptions port required');
 const selected=routes||require('../../lib/pgstream/evaluator').routes({...config,namespaces:config.postgres?.namespaces||config.namespaces});
 const streamURL=new URL(runtimeURL);streamURL.searchParams.set('sslmode','disable');runtimeURL=streamURL.href;
 const storeURL=new URL(runtimeURL);storeURL.searchParams.set('pool_max_conns','2');
 // Subscriptions are installed by DBA bootstrap before the worker starts.
 // The runtime role can only read this fixed set; a stopped-worker change or
 // recovery starts a new cache with a synchronous upstream warm-up.
 return {source:{postgres:{url:runtimeURL,mode:'replication',replication:{replication_slot:config.pgstream.slot,plugin:{include_xids:true,include_transactions:true,add_tables:selected.map(row=>row.schema+'.'+row.table).join(',')}}}},
   target:{webhooks:{subscriptions:{store:{url:storeURL.href,cache:{enabled:true,refresh_interval:60}},server:{address:'127.0.0.1:'+subscriptionsPort}},notifier:{worker_count:1,strict_mode:true,transaction_batch:{max_rows:config.maxRows||10000,max_bytes:config.pgstream.receiver.maxBytes},client_timeout:2000,backoff:{constant:{max_retries:1,interval:50}}}}}};
}
async function init({admin,adminURL,layout,config,binary='/usr/local/bin/pgstream',binarySha256,routes,workColumns,realtimeColumns,realtimeConsumers=['realtime-compose-demo']}){
 const normalized={...config,namespaces:config.postgres?.namespaces||config.namespaces},targetURL=receiverURL(config);
 const product=()=>require('../../lib/pgstream/evaluator');
 const selected=routes||product().routes(normalized),expected=binarySha256||product().BINARY_SHA256;
 if(!path.isAbsolute(binary)||!expected||require('node:crypto').createHash('sha256').update(fs.readFileSync(binary)).digest('hex')!==expected)throw new Error('PGSTREAM_BINARY_PIN_REFUSED');
 const q=require('./config').quote,role=q(layout.roles.pgstream),evaluator=q(layout.roles.evaluator),table=q(layout.namespaces.eval_checkpoint)+'.tenant_consumer_checkpoint';
 const columns=workColumns||require('../../lib/pgstream/checkpoint').WORK_COLUMNS;
 if(!Array.isArray(columns)||!columns.length||columns.some(name=>!/^[a-z][a-z0-9_]*$/.test(name)))throw new TypeError('Explicit typed work columns required');
 const hasRealtime=layout.roles.realtime!==undefined;
 if(hasRealtime&&(!layout.namespaces.rt_checkpoint||!Array.isArray(realtimeConsumers)||!realtimeConsumers.length||realtimeConsumers.length>4||new Set(realtimeConsumers).size!==realtimeConsumers.length||realtimeConsumers.some(value=>!/^realtime-[A-Za-z0-9_-]{1,112}$/.test(value))))throw new TypeError('Explicit realtime receipt consumers required');
 const delivery=hasRealtime?(realtimeColumns||require('../../lib/pgstream/realtime-receipt').COLUMNS):[];
 if(delivery.some(name=>!/^[a-z][a-z0-9_]*$/.test(name)))throw new TypeError('Explicit typed delivery columns required');
 const consumer=config.consumer+'-completed';
 if(!/^evaluator-[A-Za-z0-9_-]{1,100}-completed$/.test(consumer))throw new TypeError('Explicit completed evaluator consumer required');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ns-pgstream-dba-'));
 try{
  const connection=new URL(adminURL);connection.searchParams.set('sslmode','disable');
  const file=path.join(directory,'init.yaml');fs.writeFileSync(file,JSON.stringify({source:{postgres:{url:connection.href,replication:{replication_slot:config.pgstream.slot}}}}),{mode:0o600});
  execFileSync(binary,['init','-c',file],{stdio:['ignore','pipe','pipe'],timeout:30000});
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
 await admin.query('ALTER ROLE '+role+' REPLICATION NOINHERIT CONNECTION LIMIT 5');
 await admin.query('CREATE TABLE pgstream.webhook_subscriptions(url text,schema_name text,table_name text,event_types text[],PRIMARY KEY(url,schema_name,table_name))');
 await admin.query('REVOKE ALL ON SCHEMA pgstream FROM PUBLIC');
 await admin.query('REVOKE ALL ON ALL TABLES IN SCHEMA pgstream FROM PUBLIC');
 await admin.query('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgstream FROM PUBLIC');
 await admin.query('GRANT USAGE,CREATE ON SCHEMA pgstream TO '+role);
 await admin.query('GRANT SELECT ON pgstream.webhook_subscriptions TO '+role);
 await admin.query('GRANT USAGE ON SCHEMA pgstream TO '+evaluator);
 await admin.query('GRANT SELECT ON pgstream.webhook_subscriptions TO '+evaluator);
 await admin.query('CREATE POLICY pgstream_evaluator_metadata ON '+table+' TO '+evaluator+" USING (consumer IN ('"+config.consumer+"','"+consumer+"')) WITH CHECK (consumer IN ('"+config.consumer+"','"+consumer+"'))");
 await admin.query('GRANT UPDATE('+columns.join(',')+') ON '+table+' TO '+evaluator);
 if(hasRealtime){
  const realtime=q(layout.roles.realtime),realtimeTable=q(layout.namespaces.rt_checkpoint)+'.tenant_consumer_checkpoint';
  const selectedConsumers=realtimeConsumers.map(value=>"'"+value+"'").join(',');
  await admin.query('GRANT USAGE ON SCHEMA '+q(layout.namespaces.eval_checkpoint)+' TO '+realtime);
  await admin.query('GRANT SELECT ON '+table+' TO '+realtime);
  await admin.query('CREATE POLICY pgstream_realtime_output ON '+table+' FOR SELECT TO '+realtime+" USING (consumer='"+consumer+"')");
  await admin.query('GRANT UPDATE('+delivery.join(',')+') ON '+realtimeTable+' TO '+realtime);
  await admin.query('CREATE POLICY pgstream_realtime_metadata ON '+realtimeTable+' FOR SELECT TO '+realtime+' USING (consumer IN ('+selectedConsumers+'))');
  await admin.query('CREATE POLICY pgstream_realtime_delivery_update ON '+realtimeTable+' FOR UPDATE TO '+realtime+' USING (consumer IN ('+selectedConsumers+')) WITH CHECK (consumer IN ('+selectedConsumers+'))');
 }
 for(const route of [...selected,{schema:'',table:'',kind:'schema'}])await admin.query('INSERT INTO pgstream.webhook_subscriptions VALUES($1,$2,$3,$4)',[
   targetURL,route.schema,route.table,route.kind==='schema'?['B','C','M']:['I','U','D']]);
}
module.exports={enabled,configure,configuration,descriptor,receiverURL,wire,init};
