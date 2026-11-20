'use strict';
// One platform-managed maintained pgstream service targets the admitted receiver roster.
// DBA setup is separate from both serving roles and the streaming worker.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
function enabled(env=process.env){if(env.NS_PGSTREAM!==undefined&&env.NS_PGSTREAM!=='1')throw new Error('PGSTREAM_LEGACY_MODE_RETIRED');return true;}
function receiverURL(config){
 const receiver=require('../../lib/server/internal-api/transport').options(config.pgstream.receiver);
 if(!receiver.url)throw new TypeError('Explicit network intake receiver required');
 return new URL('pgstream',receiver.url).href;
}
function descriptor(layout,selected){
 const workers=selected&&require('./evaluator-workers').roster(selected);
 // K=1 is unsliced: one receiver, no slice envelope (core hostAssignment).
 const processAssignment=workers&&workers.length>1?{count:workers.length,ordinal:workers.findIndex(worker=>worker.service==='evaluator'),receivers:workers.map(worker=>worker.url)}:undefined;
 // Ordinal 0's receiver is the descriptor's own (Compose: http://evaluator:19913/, the default).
 const settings=require('../../lib/server/serve/deployment-settings').evaluator({NS_PG_PREFIX:layout.prefix,...(processAssignment?{NS_PGSTREAM_RECEIVER_URL:workers[0].url}:{})});
 return {...settings,namespaces:settings.postgres.namespaces,...(processAssignment?{processAssignment}:{})};
}

function wire(config,runtimeURL,{subscriptionsPort=19914,routes,assignment=config.processAssignment}={}){
 if(!Number.isSafeInteger(config.pgstream?.transactionRows)||config.pgstream.transactionRows<1||config.pgstream.transactionRows>1000000||!Number.isSafeInteger(config.pgstream?.receiver?.maxBytes??16777216)||(config.pgstream?.receiver?.maxBytes??16777216)<1)throw new TypeError('Explicit positive transaction row/byte bounds required');
 if(!Number.isSafeInteger(subscriptionsPort)||subscriptionsPort<1024||subscriptionsPort>65535)throw new TypeError('Explicit subscriptions port required');
 const receivers=assignment?require('../../lib/pgstream/assigned-worker').processProfile(JSON.stringify(assignment),config.pgstream.receiver).receivers.map(url=>new URL('pgstream',url).href):config.pgstream.startupTransport===undefined?null:[receiverURL(config)];
 const startup=config.pgstream.startupTransport===undefined?null:require('../../lib/pgstream/config').validateStartupTransport(config.pgstream.startupTransport);
 const selected=routes||require('../../lib/pgstream/evaluator').routes({...config,namespaces:config.postgres?.namespaces||config.namespaces});
 const streamURL=new URL(runtimeURL);streamURL.searchParams.set('sslmode','disable');runtimeURL=streamURL.href;
 const storeURL=new URL(runtimeURL);storeURL.searchParams.set('pool_max_conns','2');
 // Subscriptions are installed by DBA bootstrap before the worker starts.
 // The runtime role can only read this fixed set; a stopped-worker change or
 // recovery starts a new cache with a synchronous upstream warm-up.
 return {source:{postgres:{url:runtimeURL,mode:'replication',replication:{replication_slot:config.pgstream.slot,plugin:{include_xids:true,include_transactions:true,add_tables:selected.map(row=>row.schema+'.'+row.table).join(',')}}}},
   target:{webhooks:{...(startup?{startup_transport:{receivers,timeout_ms:startup.timeoutMs,retry_interval_ms:startup.retryIntervalMs}}:{}),subscriptions:{store:{url:storeURL.href,cache:{enabled:true,refresh_interval:60}},server:{address:'127.0.0.1:'+subscriptionsPort}},notifier:{worker_count:1,strict_mode:true,transaction_batch:{max_rows:config.pgstream.transactionRows,max_bytes:config.pgstream?.receiver?.maxBytes??16777216,...(assignment?{slice_receivers:require('../../lib/pgstream/assigned-worker').processProfile(JSON.stringify(assignment),config.pgstream.receiver).receivers.map(url=>new URL('pgstream',url).href)}:{})},client_timeout:2000,backoff:{constant:{max_retries:1,interval:50}}}}}};
}
async function init({admin,adminURL,layout,config,binary='/usr/local/bin/pgstream',routes,workColumns,realtimeColumns,realtimeConsumers=['realtime-compose-demo']}){
 const normalized={...config,namespaces:config.postgres?.namespaces||config.namespaces};
 const receiver=config.pgstream.receiver;
 const profile=config.processAssignment===undefined?undefined:require('../../lib/pgstream/assigned-worker').processProfile(JSON.stringify(config.processAssignment),receiver);
 const targets=profile?profile.receivers.map(url=>receiverURL({pgstream:{receiver:{...receiver,url}}})):[receiverURL(config)];
 const product=()=>require('../../lib/pgstream/evaluator');
 const selected=routes||product().routes(normalized);
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
 // Keep the standalone bound and allow bounded identification/export and
 // cancellation connections for the extra receiver processes.
 await admin.query('ALTER ROLE '+role+' REPLICATION NOINHERIT CONNECTION LIMIT '+(5+2*(targets.length-1)));
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
  await require('../../lib/pgstream/realtime-obligation').install(admin,{
    source:layout.namespaces.eval_checkpoint,target:layout.namespaces.rt_checkpoint,producer:config.consumer,consumers:realtimeConsumers
  });
  const selectedConsumers=realtimeConsumers.map(value=>"'"+value+"'").join(',');
  await admin.query('GRANT USAGE ON SCHEMA '+q(layout.namespaces.eval_checkpoint)+' TO '+realtime);
  await admin.query('GRANT SELECT ON '+table+' TO '+realtime);
  await admin.query('CREATE POLICY pgstream_realtime_output ON '+table+' FOR SELECT TO '+realtime+" USING (consumer='"+consumer+"')");
  await admin.query('GRANT UPDATE('+delivery.join(',')+') ON '+realtimeTable+' TO '+realtime);
  await admin.query('CREATE POLICY pgstream_realtime_metadata ON '+realtimeTable+' FOR SELECT TO '+realtime+' USING (consumer IN ('+selectedConsumers+'))');
  await admin.query('CREATE POLICY pgstream_realtime_delivery_update ON '+realtimeTable+' FOR UPDATE TO '+realtime+' USING (consumer IN ('+selectedConsumers+')) WITH CHECK (consumer IN ('+selectedConsumers+'))');
 }
 const subscribed=[...selected,{schema:'',table:'',kind:'schema'}];
 for(const target of targets)for(const route of subscribed)await admin.query('INSERT INTO pgstream.webhook_subscriptions VALUES($1,$2,$3,$4)',[
   target,route.schema,route.table,route.kind==='schema'?['B','C','M']:['I','U','D']]);
}
module.exports={enabled,descriptor,receiverURL,wire,init};
