'use strict';
// Explicit owned-stack acceptance only. Provisioning, fixture authority setup,
// teardown and settings writes are separate named operations, never implicit.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const execute=promisify(execFile),selected=process.env.NS_EVALUATOR_BINDING_STATE;
test('actual evaluator two-to-three membership preserves clinical alarm effects, checkpoints and B socket progress',{skip:!selected,timeout:120000},async()=>{
 const core=process.env.NS_UI_TEST_CORE,state=path.resolve(selected),project=process.env.NS_EVALUATOR_BINDING_PROJECT,port=Number(process.env.NS_EVALUATOR_BINDING_PORT);
 assert(core);assert.match(project||'',/^ns-evaluator-binding-proof-[0-9]{8}(?:-[a-z][a-z0-9]{0,15})?$/);assert.ok(port>=1024&&port<=65535);
 const tenants=JSON.parse(fs.readFileSync(path.join(state,'primer/tenants.json'),'utf8')).tenants,roots=JSON.parse(fs.readFileSync(path.join(state,'primer/provisioned.json'),'utf8'));
 const [a,b]=tenants;assert.equal(tenants.length,2);
 const {io}=require(path.join(core,'node_modules/socket.io-client')),bucket=require(path.join(core,'lib/pool-membership/slice')).bucket,notification=require(path.join(core,'lib/tenant-notifications/contract'));
 const oracle=require('./fixtures/clinical-effect-oracle.cjs');
 const sockets=[],agents=[],cwd=path.join(core,'deploy/multitenant');
 const files=require('./fixtures/shipping-compose-files.cjs').files({core,state});
 assert(files.some(file=>path.basename(file)==='compose.evaluator.yaml'),'EXPLICIT_EVALUATOR_PROFILE_REQUIRED');
 const compose=['compose','-p',project,'--env-file','.env',...files.flatMap(file=>['-f',file])];
 const fixture=path.join(__dirname,'fixtures/evaluator-private-probe.cjs');
 async function docker(args){try{return (await execute('docker',[...compose,...args],{cwd,maxBuffer:4*1024*1024})).stdout;}catch{throw new Error('EVALUATOR_SHIPPING_COMMAND_REFUSED');}}
 async function inspection(){const raw=await docker(['--profile','ops','run','--rm','--no-deps','-v',fixture+':/opt/evaluator-probe.cjs:ro','demo','node','/opt/evaluator-probe.cjs','inspect']);return JSON.parse(raw.trim().split('\n').at(-1));}
 async function members(n){const raw=await docker(['--profile','ops','run','--rm','--no-deps','primer','node','deploy/multitenant/evaluator-pool.js','set',String(n)]);return JSON.parse(raw.trim().split('\n').at(-1));}
 async function effects(){const raw=await docker(['exec','-T','postgres','psql','-X','-q','-At','-U','postgres','-d','nightscout_compose_test','-c',"SELECT coalesce(json_agg(json_build_object('tenant',tenant_id,'request',request_id,'state',state,'created',created_at,'acceptedAt',accepted_at,'origin',origin,'configIdentity',config_identity,'payload',payload)),'[]'::json) FROM nsdemo_outbox.tenant_notification_requests"]);return JSON.parse(raw.trim()).map(({payload,...row})=>({...row,clear:!!payload.clear,effectDigest:notification.effectIdentity(payload)}));}
 async function repeatDeadlines(){const raw=await docker(['exec','-T','postgres','psql','-X','-q','-At','-U','postgres','-d','nightscout_compose_test','-c',"SELECT json_agg(json_build_object('tenant',tenant_id,'deadline',producer->>'repeatAt')) FROM nsdemo_outbox.tenant_notification_state"]);return new Map(JSON.parse(raw.trim()).map(row=>[row.tenant,Number(row.deadline)]));}
 async function clock(tenant){const raw=await docker(['exec','-T','postgres','psql','-X','-q','-At','-U','postgres','-d','nightscout_compose_test','-c',"SELECT last_stamp FROM nsdemo_clock.tenant_write_clock WHERE tenant_id='"+tenant.id+"'"]);return Number(raw.trim());}
 async function until(fn,label,ms=20000){const end=performance.now()+ms;while(performance.now()<end){const result=await fn();if(result)return result;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('EVALUATOR_SHIPPING_WAIT '+label);}
 function agent(){const value=new http.Agent({keepAlive:true,lookup:(host,options,done)=>options.all?done(null,[{address:'127.0.0.1',family:4}]):done(null,'127.0.0.1',4)});agents.push(value);return value;}
 function socket(tenant,namespace){const value=io('http://'+tenant.host+':'+port+namespace,{forceNew:true,autoUnref:true,transports:['websocket'],agent:agent(),timeout:2000});sockets.push(value);const seen={socket:value,acks:[],alarms:[],frames:[],connections:0};
  value.on('connect',()=>{seen.connections++;if(namespace==='/'){value.emit('authorize',{secret:crypto.createHash('sha1').update(roots.find(row=>row.id===tenant.id).rootSecret).digest('hex')});}else value.emit('subscribe',{accessToken:tenant.dataToken},reply=>seen.acks.push(reply));});
  for(const event of ['alarm','urgent_alarm'])value.on(event,payload=>seen.alarms.push({event,payload}));value.on('dataUpdate',frame=>seen.frames.push(frame));return seen;}
 async function request(tenant,route,{method='GET',token,body}={}){return new Promise((resolve,reject)=>{const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));const req=http.request({host:'127.0.0.1',port,path:route,method,timeout:10000,headers:{host:tenant.host,accept:'application/json',...(token?{authorization:'Bearer '+token}:{}),...(bytes?{'content-type':'application/json','content-length':bytes.length}:{})}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())});}catch{reject(new Error('EVALUATOR_SHIPPING_HTTP_SHAPE'));}});});req.on('error',()=>reject(new Error('EVALUATOR_SHIPPING_HTTP')));req.on('timeout',()=>req.destroy());req.end(bytes);});}
 async function jwt(tenant){const reply=await request(tenant,'/api/v2/authorization/request/'+encodeURIComponent(tenant.dataToken));assert.equal(reply.status,200);assert.equal(typeof reply.body.token,'string');return reply.body.token;}
 async function upload(tenant,token,value){const marker={identifier:'evaluator-shipping-'+crypto.randomUUID(),type:'sgv',sgv:value,date:Date.now(),utcOffset:0,app:'synthetic-evaluator-proof'};const reply=await request(tenant,'/api/v3/entries',{method:'POST',token,body:marker});assert.equal(reply.status,201);return marker;}
 try{
  const two=await until(async()=>{const rows=await inspection();return rows.length===3&&rows.every(row=>row.gate.eligible&&row.observed.effectiveMembers===2)?rows:null;},'two-member agreement');
  assert(two.find(row=>row.configured.ordinal===2).tenants.every(row=>!row.admitted&&row.cycles===0),'third fixed participant is honestly idle');
  for(const tenant of tenants)assert(two.find(row=>row.configured.ordinal===bucket(tenant.id,2)).tenants.some(row=>row.tenant===tenant.id&&row.ready&&row.cycles>0));
  const aa=socket(a,'/alarm'),ba=socket(b,'/alarm'),bb=socket(b,'/');await until(()=>aa.acks.some(row=>row.success)&&ba.acks.some(row=>row.success)&&bb.frames.length,'actual alarm subscriptions');const bSession=bb.socket.id;
  const before=await effects(),oldIds=new Set(before.map(row=>row.request)),aToken=await jwt(a),bToken=await jwt(b);
  await Promise.all([upload(a,aToken,400),upload(b,bToken,400)]);
  await until(()=>aa.alarms.length&&ba.alarms.length,'clinical alarm generation by two members');
  const first=await until(async()=>{const rows=(await effects()).filter(row=>!oldIds.has(row.request));return tenants.every(tenant=>rows.some(row=>row.tenant===tenant.id&&!row.clear&&row.state==='accepted'))?rows:null;},'durable accepted clinical requests');
  for(const tenant of tenants)assert.equal(first.filter(row=>row.tenant===tenant.id&&!row.clear&&row.state==='accepted').length,1,'one initial accepted normal effect per tenant');
  const deadlines=await repeatDeadlines(),start=performance.now(),set=await members(3);assert.equal(set.desired.members,3);
  const bInput=await upload(b,bToken,401);const expected=await clock(b);
  const three=await until(async()=>{const rows=await inspection();return rows.every(row=>row.gate.eligible&&row.observed.effectiveMembers===3)&&tenants.every(tenant=>rows.find(row=>row.configured.ordinal===bucket(tenant.id,3)).tenants.some(row=>row.tenant===tenant.id&&row.ready&&row.cycles>0&&(tenant.id!==b.id||row.inputCheckpoint>=expected)))?rows:null;},'three-member current clinical acquisition');
  const elapsed=performance.now()-start,lease=Math.min(...three.map(row=>row.configured.leaseMs));assert.ok(elapsed<lease,'handoff current within one configured lease');assert.notEqual(bucket(b.id,2),bucket(b.id,3),'B actually changes evaluator');
  await until(()=>bb.frames.some(frame=>frame.sgvs.some(row=>row.mgdl===401&&row.mills===bInput.date)),'B actual post-transition frame');
  await new Promise(resolve=>setTimeout(resolve,1500));
  const after=(await effects()).filter(row=>!oldIds.has(row.request));
  const verdict=oracle.verdict({a:a.id,b:b.id,first,after,deadlines,now:Date.now(),fanout:new Map([[a.id,aa.alarms.map(row=>notification.effectIdentity(row.payload))],[b.id,ba.alarms.map(row=>notification.effectIdentity(row.payload))]])});
  console.log('EVALUATOR_EFFECT_CLASSIFICATION '+JSON.stringify(verdict));
  assert.equal(bb.socket.id,bSession);assert.equal(bb.connections,1,'B socket never reconnects');
  const roleConfigs=['evaluator','evaluator-2','evaluator-3'].map(role=>JSON.parse(fs.readFileSync(path.join(state,role,'config.json'),'utf8')));assert.equal(new Set(roleConfigs.map(row=>row.consumer)).size,1);
  console.log('EVALUATOR_SHIPPING_PROOF members2to3 clinicalRequests'+verdict.acceptedNormals+' intentionalBChangedEffect alarmFanoutTyped checkpointCurrent stableConsumer BSameSocket handoffMs'+Math.ceil(elapsed)+' leaseMs'+lease);
 }finally{for(const value of sockets){value.io.reconnection(false);value.disconnect();}await new Promise(resolve=>setTimeout(resolve,200));for(const value of agents)value.destroy();}
});
