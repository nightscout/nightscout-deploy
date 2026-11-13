'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const F=require('../connection-budget-files');
test('fixed adapter bounds observer generations, retains late backend and refuses before a third SQL child',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ns-budget-adapter-'));fs.chmodSync(dir,0o700);for(const file of ['compose.yaml','.env','postgres-ready.sh'])fs.writeFileSync(path.join(dir,file),'synthetic\n',{mode:0o600});
 const expected={project:'synthetic',workingDirectory:dir,imageId:'sha256:'+'a'.repeat(64),source:{coreCommit:'b'.repeat(40),deployCommit:'c'.repeat(40)}},postgres={cid:'d'.repeat(64),startedAt:'same',imageId:require('../postgres-profile.json').imageId};
 const plan={resource:{pgResourceId:'synthetic-pg',allowances:{observers:2}},bootstrapSchedule:'EXPLICIT_OVERLAP',slots:[]};
 const oldLoad=Module._load;let sqlCalls=0,late=true,reused=false,probeError=false;
 Module._load=function(name,...args){if(name==='node:child_process')return{spawnSync(command,argv,options){assert.equal(command,'docker');assert(options.timeout<=30000);assert.equal(options.maxBuffer,1048576);let out;
 if(argv[0]==='inspect')out=[{Id:postgres.cid,Image:postgres.imageId,State:{Running:true,StartedAt:postgres.startedAt},Mounts:[{Type:'bind',Source:path.join(dir,'postgres-ready.sh'),Destination:'/run/ns-budget-health/postgres-ready.sh',RW:false}],Config:{Healthcheck:{Test:['CMD','/usr/local/bin/gosu','postgres','/bin/sh','/run/ns-budget-health/postgres-ready.sh']},Labels:{'com.docker.compose.project':'synthetic','com.docker.compose.project.working_dir':dir,'com.docker.compose.service':'postgres'}}}];
 else if(argv[0]==='exec'&&argv.includes('/bin/sh')){if(probeError)return{status:1,stdout:''};return{status:0,stdout:argv.slice(argv.indexOf('observer-birth')+1).map(pid=>late?pid+' PRESENT '+(reused?'999':'12345'):pid+' ABSENT').join('\n')+'\n'};}
 else if(argv[0]==='exec'){sqlCalls++;assert(argv.includes('PGCONNECT_TIMEOUT=3'));assert(argv.includes('PGOPTIONS=-c statement_timeout=3000 -c lock_timeout=1000'));assert(argv.at(-1).includes("current_setting('reserved_connections',true)"));assert(argv.at(-1).includes("pg_read_file('/proc/self/stat',0,4096)"));if(sqlCalls>1&&late)assert(argv.at(-1).includes('backend_start='));out={observerPid:100+sqlCalls,observerStartedAt:'2026-11-12 22:22:43+00',observerApplicationName:argv.find(x=>x.startsWith('PGAPPNAME=')).slice(10),observerStartTicks:'12345',systemIdentifier:'123',postmasterStartedAt:'same',serverMaximum:100,superuserReserved:3,otherReserved:0,unmanagedClients:1,tags:[]};}
 else throw Error('unexpected Docker command');return{status:0,stdout:JSON.stringify(out)};}};return oldLoad.call(this,name,...args);};
 const moduleFile=require.resolve('../connection-budget-docker');delete require.cache[moduleFile];
 try{const adapter=require('../connection-budget-docker').create({directory:dir,plan,expected,postgres,composeFiles:[path.join(dir,'compose.yaml')],fileDigests:Object.fromEntries(['compose.yaml','.env','postgres-ready.sh'].map(f=>[path.join(dir,f),require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(dir,f))).digest('hex')]))});adapter.observe(plan,[],[]);adapter.observe(plan,[],[]);assert.equal(F.read(path.join(dir,'observers.json')).length,2);assert.throws(()=>adapter.observe(plan,[],[]),/OBSERVER_CREDITS_HELD/);assert.equal(sqlCalls,2);
 // Authenticated census absence is irrelevant while exact OS birth remains.
 // Reuse/error refuse without SQL. Exact OS absence permits bounded reuse.
 const held=F.read(path.join(dir,'observers.json'))[0];F.write(path.join(dir,'observers.json'),[held]);
 reused=true;assert.throws(()=>adapter.observe(plan,[],[]),/OBSERVER_OS_UNKNOWN/);assert.equal(sqlCalls,2);assert.equal(F.read(path.join(dir,'observers.json')).length,1);reused=false;
 probeError=true;assert.throws(()=>adapter.observe(plan,[],[]),/DOCKER_REFUSED/);assert.equal(sqlCalls,2);probeError=false;late=false;adapter.observe(plan,[],[]);assert.deepEqual(F.read(path.join(dir,'observers.json')).map(x=>x.pid),[103]);
 }finally{Module._load=oldLoad;delete require.cache[moduleFile];fs.rmSync(dir,{recursive:true});}
});
