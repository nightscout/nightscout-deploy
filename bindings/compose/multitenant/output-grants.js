'use strict';
// Evaluator output metadata and realtime delivery grants, installed by bootstrap.
// Validate the whole grant set before bootstrap installs any of it.
function outputGrants({layout,consumer:producer,workColumns,realtimeColumns,realtimeConsumers=['realtime-compose-demo']}){
 const q=require('./config').quote,evaluator=q(layout.roles.evaluator),table=q(layout.namespaces.eval_checkpoint)+'.tenant_consumer_checkpoint';
 const columns=workColumns||require('../../lib/pgstream/checkpoint').WORK_COLUMNS;
 if(!Array.isArray(columns)||!columns.length||columns.some(name=>!/^[a-z][a-z0-9_]*$/.test(name)))throw new TypeError('Explicit typed work columns required');
 const hasRealtime=layout.roles.realtime!==undefined;
 if(hasRealtime&&(!layout.namespaces.rt_checkpoint||!Array.isArray(realtimeConsumers)||!realtimeConsumers.length||realtimeConsumers.length>4||new Set(realtimeConsumers).size!==realtimeConsumers.length||realtimeConsumers.some(value=>!/^realtime-[A-Za-z0-9_-]{1,112}$/.test(value))))throw new TypeError('Explicit realtime receipt consumers required');
 const delivery=hasRealtime?(realtimeColumns||require('../../lib/pgstream/realtime-receipt').COLUMNS):[];
 if(delivery.some(name=>!/^[a-z][a-z0-9_]*$/.test(name)))throw new TypeError('Explicit typed delivery columns required');
 const consumer=producer+'-completed';
 if(!/^evaluator-[A-Za-z0-9_-]{1,100}-completed$/.test(consumer))throw new TypeError('Explicit completed evaluator consumer required');
 return async function installOutput(admin) {
  await admin.query('CREATE POLICY pgstream_evaluator_metadata ON '+table+' TO '+evaluator+" USING (consumer IN ('"+producer+"','"+consumer+"')) WITH CHECK (consumer IN ('"+producer+"','"+consumer+"'))");
  await admin.query('GRANT UPDATE('+columns.join(',')+') ON '+table+' TO '+evaluator);
  if(hasRealtime){
   const realtime=q(layout.roles.realtime),realtimeTable=q(layout.namespaces.rt_checkpoint)+'.tenant_consumer_checkpoint';
   await require('../../lib/pgstream/realtime-obligation').install(admin,{
     source:layout.namespaces.eval_checkpoint,target:layout.namespaces.rt_checkpoint,producer:producer,consumers:realtimeConsumers
   });
   const selectedConsumers=realtimeConsumers.map(value=>"'"+value+"'").join(',');
   await admin.query('GRANT USAGE ON SCHEMA '+q(layout.namespaces.eval_checkpoint)+' TO '+realtime);
   await admin.query('GRANT SELECT ON '+table+' TO '+realtime);
   await admin.query('CREATE POLICY pgstream_realtime_output ON '+table+' FOR SELECT TO '+realtime+" USING (consumer='"+consumer+"')");
   await admin.query('GRANT UPDATE('+delivery.join(',')+') ON '+realtimeTable+' TO '+realtime);
   await admin.query('CREATE POLICY pgstream_realtime_metadata ON '+realtimeTable+' FOR SELECT TO '+realtime+' USING (consumer IN ('+selectedConsumers+'))');
   await admin.query('CREATE POLICY pgstream_realtime_delivery_update ON '+realtimeTable+' FOR UPDATE TO '+realtime+' USING (consumer IN ('+selectedConsumers+')) WITH CHECK (consumer IN ('+selectedConsumers+'))');
  }
 };
}
module.exports={outputGrants};
