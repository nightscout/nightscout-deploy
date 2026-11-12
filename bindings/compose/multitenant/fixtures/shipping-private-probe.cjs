'use strict';
// Synthetic private-plane transport/control proof. No credential is printed.
require('/opt/app/deploy/multitenant/load-env');
const fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict');
const clients=require('/opt/app/lib/server/internal-api/clients');
const operator=require('/opt/app/deploy/multitenant/restore');
const internal=require('/opt/app/lib/server/internal-api/listener-config').observer(process.env);
const config=operator.loadConfig(),mode=process.env.NS_SHIP_PROBE;
const map=which=>require('/opt/app/lib/realtime-placement').load({...process.env,MULTITENANT_REALTIME_PLACEMENT:'/run/ns-placement/'+which+'.json'},{internal});
async function call(origin,host,path){return new Promise((resolve,reject)=>{const request=http.get(origin+path,{headers:{host},timeout:2000},response=>{const chunks=[];response.on('data',c=>chunks.push(c));response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(chunks).toString()}));});request.on('error',()=>reject(new Error('PRIVATE_HTTP_UNAVAILABLE')));request.on('timeout',()=>request.destroy());});}
(async()=>{
 if(mode==='handshake-positive'){const tenant=config.tenants[0],route=map('backend').route(tenant.id),result=await call(route.consumerOrigin,tenant.host,'/socket.io/?EIO=4&transport=polling');console.log('WARM_HTTP_STATUS '+result.status);assert.equal(result.status,200);return;}
 if(mode==='cold'){
  const tenant=config.tenants[0],placement=map('backend'),route=placement.route(tenant.id);
  const handshake=await call(route.consumerOrigin,tenant.host,'/socket.io/?EIO=4&transport=polling');console.log('COLD_HTTP_STATUS '+handshake.status);assert.equal(handshake.status,403);
  await assert.rejects(clients.alarmDelivery(route.endpoint).deliverAlarm({tenant:tenant.id,id:require('node:crypto').randomUUID(),attempt:1,notification:{level:1,title:'Synthetic cold target'},receipts:[],placement:{generation:route.generation,shard:route.shard,worker:route.worker,incarnation:route.incarnation}}));
  console.log('COLD_TARGET handshake403 handoffRefused');return;
 }
 if(mode==='alarm-a'||mode==='alarm-b'){
  const tenant=config.tenants[mode==='alarm-a'?0:1],route=map('routes').route(tenant.id);
  const result=await clients.alarmDelivery(route.endpoint).deliverAlarm({tenant:tenant.id,id:require('node:crypto').randomUUID(),attempt:1,notification:{level:1,title:'Synthetic shipping '+mode},receipts:[],placement:{generation:route.generation,shard:route.shard,worker:route.worker,incarnation:route.incarnation}});
  assert.equal(result.accepted,true);console.log('ALARM_ACCEPTED '+mode+' generation'+route.generation);return;
 }
 const client=new(require('/opt/app/node_modules/pg').Client)({connectionString:process.env.NS_OPERATOR_PG});await client.connect();let pin,cohort;
 try{
  if(mode==='pin-busy'){await assert.rejects(require('/opt/app/lib/realtime-placement/publication-lock').pin(client,config.control.namespace),{code:'RESTORE_COHORT_PLACEMENT_BUSY'});console.log('ACTUAL_PUBLICATION_PIN_EXCLUDED');return;}
  const module=require('/opt/app/lib/server/serve/operation-cohort'),placement=map('backend');
  const options={namespace:config.control.namespace,tenants:operator.cohortTenants(config),participants:config.control.participants,placement};
  if(mode==='omitted-idle'){await assert.rejects(module.createRemote({...options,participants:options.participants.filter(row=>row.worker!=='realtime-2')}),{code:'RESTORE_COHORT_PLACEMENT_INCOMPLETE'});console.log('IDLE_OMISSION_REFUSED');return;}
  cohort=await module.createRemote(options);pin=await module.pin(cohort,config.tenants[0].id,{client});await module.assertComplete(cohort,config.tenants[0].id,{client});
  const route=placement.current().workers.get('realtime-2'),health=await call(route.consumerOrigin,config.tenants[0].host,'/health'),body=JSON.parse(health.body);
  assert.equal(health.status,200);assert.equal(body.configured,0);assert.equal(body.placement.resource,true);console.log('ACTUAL_CENSUS_IDLE_OWNER resourceHeld configured0');
 }finally{if(pin)await require('/opt/app/lib/server/serve/operation-cohort').releasePin(pin);await cohort?.close();await client.end();}
})().catch(error=>{console.error('SHIPPING_PRIVATE_PROBE_REFUSED '+JSON.stringify({code:String(error.code||error.name).replace(/[^A-Z0-9_]/g,'').slice(0,90),actual:typeof error.actual==='number'?error.actual:null,expected:typeof error.expected==='number'?error.expected:null,message:error.code==='ERR_ASSERTION'?String(error.message).slice(0,160):null}));process.exitCode=1;});
