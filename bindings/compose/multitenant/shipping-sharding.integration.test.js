'use strict';
// Explicit owned shipping composition only. No provisioning or container teardown
// is implicit; the coordinator selects its synthetic project/state and core.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const selected=process.env.NS_COMPOSE_SHARDING_STATE;
test('actual shipping edge preserves registered Host polling/WebSocket/API3 and real restore continuity',{skip:!selected,timeout:120000},async()=>{
  const core=process.env.NS_UI_TEST_CORE;assert.ok(core,'explicit source');
  const state=path.resolve(selected),project=process.env.NS_COMPOSE_SHARDING_PROJECT,port=Number(process.env.NS_COMPOSE_SHARDING_PORT);
  assert.match(project||'',/^ns-rt-binding(?:-clean|-final|-proof)?-[0-9]{8}$/);assert.ok(port>=1024&&port<=65535);
  const credentials=JSON.parse(fs.readFileSync(path.join(state,'primer/tenants.json'),'utf8')).tenants;
  const roots=JSON.parse(fs.readFileSync(path.join(state,'primer/provisioned.json'),'utf8'));
  assert.equal(credentials.length,2);const [a,b]=credentials;
  const {io}=require(path.join(core,'node_modules/socket.io-client'));
  const sockets=[],agents=[];
  const until=async(fn,label,ms=20000)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,30));}throw new Error('COMPOSE_SHARD_WAIT '+label);};
  function agent(){const value=new http.Agent({keepAlive:true,lookup:(host,options,done)=>options.all?done(null,[{address:'127.0.0.1',family:4}]):done(null,'127.0.0.1',4)});agents.push(value);return value;}
  function client(tenant,namespace,transport){
    const socket=io('http://'+tenant.host+':'+port+(namespace==='/'?'':namespace),{forceNew:true,autoUnref:true,transports:[transport],agent:agent(),timeout:2000,reconnectionDelay:50,reconnectionDelayMax:200});sockets.push(socket);
    const seen={socket,frames:[],acks:[],alarms:[],connections:0};
    socket.on('connect',()=>{seen.connections++;if(namespace==='/'){const root=roots.find(row=>row.id===tenant.id).rootSecret;socket.emit('authorize',{secret:crypto.createHash('sha1').update(root).digest('hex')});}else socket.emit('subscribe',{accessToken:tenant.dataToken,...(namespace==='/storage'?{collections:['entries']}:{})},reply=>seen.acks.push(reply));});
    socket.on('dataUpdate',value=>seen.frames.push(value));for(const event of ['alarm','urgent_alarm'])socket.on(event,value=>seen.alarms.push(value));return seen;
  }
  async function request(tenant,route,{method='GET',body,token}={}){
    return new Promise((resolve,reject)=>{const data=body===undefined?null:Buffer.from(JSON.stringify(body));const req=http.request({host:'127.0.0.1',port,path:route,method,agent:false,timeout:10000,headers:{host:tenant.host,accept:'application/json',...(token?{authorization:'Bearer '+token}:{}),...(data?{'content-type':'application/json','content-length':data.length}:{})}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())});}catch{reject(new Error('COMPOSE_SHARD_RESPONSE'));}});});req.on('error',()=>reject(new Error('COMPOSE_SHARD_HTTP')));req.on('timeout',()=>req.destroy());req.end(data);});
  }
  async function jwt(tenant){const result=await request(tenant,'/api/v2/authorization/request/'+encodeURIComponent(tenant.dataToken));assert.equal(result.status,200,'exchange '+String(result.body.error||result.body.message||'').replace(/[^A-Za-z0-9_: -]/g,'').slice(0,120));assert.equal(typeof result.body.token,'string');return result.body.token;}
  try {
    const mainA=client(a,'/','polling'),mainB=client(b,'/','websocket'),storage=client(a,'/storage','websocket'),alarms=client(a,'/alarm','polling');
    await until(()=>mainA.frames.length&&mainB.frames.length&&storage.acks.some(row=>row.success)&&alarms.acks.some(row=>row.success),'stock client admission');
    assert.equal(mainA.socket.io.engine.transport.name,'polling');assert.equal(mainB.socket.io.engine.transport.name,'websocket');
    const bSession=mainB.socket.id;assert.ok(mainA.frames.at(-1).sgvs.some(row=>row.mgdl===123));assert.ok(mainB.frames.at(-1).sgvs.some(row=>row.mgdl===177));
    assert.ok(!mainA.frames.at(-1).sgvs.some(row=>row.mgdl===177),'tenant frame isolation');
    const aToken=await jwt(a),bToken=await jwt(b);
    const current=await request(a,'/api/v3/entries',{token:aToken});assert.equal(current.status,200);assert.ok(current.body.result.some(row=>row.sgv===123),'API3 client explicitly reloads collection after subscribing');
    const probe=await request(b,'/api/v3/entries',{method:'POST',token:bToken,body:{identifier:'shipping-b-live-'+crypto.randomUUID(),type:'sgv',sgv:159,date:Date.now(),utcOffset:0,app:'synthetic-binding'}});assert.equal(probe.status,201);
    await until(()=>mainB.frames.some(frame=>frame.sgvs.some(row=>row.mgdl===159)),'B actual data progression');
    await new Promise(r=>setTimeout(r,6500));assert.equal(mainA.socket.connected,true,'stock idle polling survives ordinary empty poll');assert.equal(mainB.socket.id,bSession);
    const folder=path.join(core,'deploy/multitenant');
    const args=['compose','--project-name',project,'--env-file','.env','-f','compose.yaml','-f',path.join(state,'compose.replicas.yaml'),'-f',path.join(state,'compose.realtime.yaml'),'--profile','ops','run','--rm','--no-deps','demo'];
    const override=process.env.NS_COMPOSE_SHARDING_RESTORE_OVERRIDE;
    if(override){assert.ok(path.isAbsolute(override));args.splice(args.length-1,0,'--volume',override+':/opt/app/deploy/multitenant/restore.js:ro');}
    const demoOverride=process.env.NS_COMPOSE_SHARDING_DEMO_OVERRIDE;
    if(demoOverride){assert.ok(path.isAbsolute(demoOverride));args.splice(args.length-1,0,'--volume',demoOverride+':/opt/app/deploy/multitenant/demo.js:ro');}
    const record=path.join(state,'artifacts/shipping-restore.log');const out=fs.openSync(record,'w',0o600);
    const child=spawn('docker',args,{cwd:folder,stdio:['ignore',out,out]});const exit=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});fs.closeSync(out);
    assert.equal(exit,0,'actual shipping restore/census demo refused; inspect private artifact');
    const summary=JSON.parse(fs.readFileSync(record,'utf8').trim().split('\n').at(-1));assert.equal(summary.state,'passed');assert.equal(summary.observations.bCommittedDuringRestore,true);
    await until(()=>mainB.frames.some(frame=>frame.sgvs.some(row=>row.mgdl===152)),'actual B update during restore reaches unchanged socket');assert.equal(mainB.socket.id,bSession);
    assert.equal(mainB.connections,1,'unrelated B never reconnects during A restore');
    console.log('COMPOSE_SHARD_PROOF stockPolling stockWebSocket API3reload registeredHost tenantIsolation idlePolling actualRestore census BContinuity');
  } finally {for(const socket of sockets){socket.io.reconnection(false);socket.disconnect();}await new Promise(resolve=>setTimeout(resolve,300));for(const value of agents)value.destroy();}
});
