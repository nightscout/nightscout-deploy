'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const N=require('../connection-budget-counts'),B=require('../connection-budget'),F=require('../connection-budget-files'),PG=require('../postgres-profile.json');
const A='11111111-1111-4111-8111-111111111111',Z='22222222-2222-4222-8222-222222222222';
const selector=()=>({version:1,kind:'native-synthetic-stored-counts',runId:'m7-native-'+'a'.repeat(32),tenants:[A,Z]});
const zero=s=>({rows:s.tenants.map(tenant=>({tenant,entriesTotal:0,entries:0,devicestatus:0,treatments:0,probe:0})),foreign:{entries:0,devicestatus:0,treatments:0,probe:0}});
function fixture(nested=false,adapterSource=null){
 const outer=fs.mkdtempSync(path.join(os.tmpdir(),'ns-counts-'));fs.chmodSync(outer,0o700);const dir=nested?path.join(outer,'state/connection-budget'):outer;if(nested)fs.mkdirSync(dir,{recursive:true,mode:0o700});const source={coreCommit:B.REVIEWED_CORE_COMMIT,deployCommit:'b'.repeat(40)};
 for(const file of ['compose.yaml','.env','postgres-ready.sh'])fs.writeFileSync(path.join(dir,file),file==='.env'?'NS_DEMO_PROJECT=synthetic\n':'synthetic\n',{mode:0o600});
 const expected={project:'synthetic',workingDirectory:dir,imageId:'sha256:'+'a'.repeat(64),source},postgres={cid:'d'.repeat(64),startedAt:'same',imageId:PG.imageId};
 const body={version:1,kind:'controlled-connection-budget-plan',source,resource:{pgResourceId:'synthetic-pg',systemIdentifier:'123',postmasterStartedAt:'same',serverMaximum:100,reserved:{superuser:3,other:0},allowances:{unmanaged:0,observers:2,controlRecovery:1,bootstrapOverlap:2,oldNewRolloutOverlap:2}},slots:[],bootstrapSchedule:'EXPLICIT_OVERLAP'},plan={...body,sha256:B.hash(body)};
 const observation={pgResourceId:'synthetic-pg',systemIdentifier:'123',postmasterStartedAt:'same',serverMaximum:100,superuserReserved:3,otherReserved:0,unmanagedClients:0,bootstrapClosed:true};
 let calls=0,present=true,fail=null,foreign=0,badCount=false,sql='',controller;
 function spawnSync(command,argv,options){assert.equal(command,'docker');assert(options.timeout<=30000);assert.equal(options.maxBuffer,1048576);
  if(argv[0]==='inspect')return{status:0,stdout:JSON.stringify([{Id:postgres.cid,Image:postgres.imageId,State:{Running:true,StartedAt:postgres.startedAt},Mounts:[{Type:'bind',Source:path.join(dir,'postgres-ready.sh'),Destination:'/run/ns-budget-health/postgres-ready.sh',RW:false}],Config:{Healthcheck:{Test:['CMD','/usr/local/bin/gosu','postgres','/bin/sh','/run/ns-budget-health/postgres-ready.sh']},Labels:{'com.docker.compose.project':'synthetic','com.docker.compose.project.working_dir':dir,'com.docker.compose.service':'postgres'}}}])};
  if(argv[0]==='exec'&&argv.includes('/bin/sh'))return{status:0,stdout:argv.slice(argv.indexOf('observer-birth')+1).map(pid=>pid+(present?' PRESENT 12345':' ABSENT')).join('\n')+'\n'};
  assert.equal(argv[0],'exec');assert(fs.existsSync(path.join(dir,'observer-claim.json')),'controller durable credit before SQL');const book=F.read(path.join(dir,'observers.json'));assert.equal(book.at(-1).state,'IN_FLIGHT','adapter durable credit before SQL');
  calls++;sql=argv.at(-1);assert(argv.includes('PGCONNECT_TIMEOUT=3'));assert(argv.includes('PGOPTIONS=-c statement_timeout=3000 -c lock_timeout=1000'));
  if(fail==='timeout')return{error:Object.assign(Error('synthetic timeout'),{code:'ETIMEDOUT'}),status:null,stdout:''};
  if(fail==='error')return{status:1,stdout:''};
  let storedCounts;if(sql.includes("'storedCounts'")){storedCounts=zero(selector());storedCounts.foreign.entries=foreign;if(badCount)storedCounts.rows[0].entries=1;}
  return{status:0,stdout:JSON.stringify({...observation,pgResourceId:undefined,bootstrapClosed:undefined,observerPid:100+calls,observerStartedAt:'2026-11-12 22:22:43+00',observerApplicationName:argv.find(x=>x.startsWith('PGAPPNAME=')).slice(10),observerStartTicks:'12345',tags:[],...(storedCounts?{storedCounts}:{})})};
 }
 const filename=require.resolve('../connection-budget-docker'),loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));const original=loaded.require.bind(loaded);loaded.require=name=>name==='node:child_process'?{spawnSync}:original(name);loaded._compile(adapterSource||fs.readFileSync(filename,'utf8'),filename);
 const ports=loaded.exports.create({directory:dir,plan,expected,postgres,composeFiles:[path.join(dir,'compose.yaml')],fileDigests:Object.fromEntries(['compose.yaml','.env','postgres-ready.sh'].map(f=>[path.join(dir,f),crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,f))).digest('hex')]))});
 const C=require('../connection-budget-controller');controller=C.create({directory:dir,plan,expected,ports});
 return{dir,outer,state:path.join(outer,'state'),plan,ports,controller,observation,expected,postgres,get calls(){return calls;},get sql(){return sql;},set present(v){present=v;},set fail(v){fail=v;},set foreign(v){foreign=v;},set badCount(v){badCount=v;},close(){fs.rmSync(outer,{recursive:true});}};
}
test('exact native selector and complete zero rows; foreign positive counts remain observations',()=>{
 const s=selector();assert.deepEqual(N.selector(s),s);assert.match(N.hash(s),/^[a-f0-9]{64}$/);assert.deepEqual(N.result(s,zero(s)),zero(s));
 const positive=zero(s);positive.foreign.entries=1;assert.equal(N.result(s,positive).foreign.entries,1);
 const invalid=[{...s,sql:'SELECT 1'},{...s,kind:'legacy'},{...s,runId:'ns-admission-'+'a'.repeat(32)},{...s,runId:"m7-native-'"},{...s,tenants:[]},{...s,tenants:Array.from({length:129},(_,i)=>(i+1).toString(16).padStart(8,'0')+'-0000-4000-8000-000000000001')},{...s,tenants:[A,A]},{...s,tenants:['AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA']},{...s,tenants:['foreign']}];
 for(const value of invalid)assert.throws(()=>N.selector(value));
 for(const change of [v=>v.rows.pop(),v=>v.rows[0].tenant=Z,v=>v.rows[0].doc={},v=>v.rows[0].entries=-1,v=>v.rows[0].entries=Number.MAX_SAFE_INTEGER+1,v=>v.rows[0].entries=1,v=>v.foreign.entries=-1,v=>v.foreign.tenant=A]){const value=zero(s);change(value);assert.throws(()=>N.result(s,value));}
 const sql=N.expression(s);for(const fixed of ['nsdemo_entries.entries','nsdemo_devicestatus.devicestatus','nsdemo_treatments.treatments',"->>'device'","->>'enteredBy'",'WITH ORDINALITY','NOT('])assert(sql.includes(fixed));assert(!sql.includes('SELECT doc'));assert.equal((sql.match(/NOT\(/g)||[]).length,4);assert(sql.length<262144);const max={...s,tenants:Array.from({length:128},(_,i)=>(i+1).toString(16).padStart(8,'0')+'-0000-4000-8000-000000000001')};assert(N.expression(max).length<262144);
});
test('one shared credited SQL returns valid-zero roster and truthful foreign totals with exact source/custody',()=>{const f=fixture();try{
 f.foreign=2;const result=f.controller.storedCounts(selector());assert.equal(f.calls,1);assert.equal(result.counts.length,2);assert.equal(result.counts[0].entriesTotal,0);assert.equal(result.foreign.entries,2);assert.deepEqual(result.source,f.plan.source);assert.deepEqual(result.custody.postgres,f.postgres);assert.equal(result.selectorSha256,N.hash(selector()));assert.equal(result.scope,'FIXED_SYNTHETIC_COUNTS_ONLY_NOT_NATIVE_ACCEPTANCE');assert(f.sql.includes("'storedCounts'"));assert(!fs.existsSync(path.join(f.dir,'observer-claim.json')));
 }finally{f.close();}});
test('bind/observe/count share total two observers; no spare or control reserve is borrowed',()=>{const f=fixture();try{
 F.locked(f.dir,fd=>{F.writeAt(fd,'observer-claim.json',{kind:'bind-recording'},{exclusive:true});f.ports.observe(f.plan,[],[]);fs.unlinkSync(F.location(fd,'observer-claim.json'));}); // exact bind shared-adapter seam
 f.controller.storedCounts(selector());assert.equal(f.calls,2);assert.throws(()=>f.controller.observe(),/OBSERVER_CREDITS_HELD/);assert.equal(f.calls,2);assert.equal(F.read(path.join(f.dir,'observers.json')).length,2);
 }finally{f.close();}});
test('OS absence permits reuse; active lock and unknown count outcomes retain durable credits',()=>{
 const f=fixture();try{F.locked(f.dir,()=>assert.throws(()=>f.controller.storedCounts(selector())));assert.equal(f.calls,0);f.controller.observe();f.present=false;f.controller.storedCounts(selector());assert.equal(f.calls,2);assert.equal(F.read(path.join(f.dir,'observers.json')).length,1);}finally{f.close();}
 for(const mode of ['timeout','error','shape']){const x=fixture();try{if(mode==='shape'){x.badCount=true;x.foreign=3;}else x.fail=mode;let failure;try{x.controller.storedCounts(selector());assert.fail('must refuse');}catch(error){failure=error;}if(mode==='shape')assert.equal(F.read(path.join(x.dir,failure.countsDiagnostic)).foreign.entries,3);assert.equal(x.calls,1);assert(fs.existsSync(path.join(x.dir,'observer-claim.json')));assert.equal(F.read(path.join(x.dir,'observers.json')).at(-1).state,'IN_FLIGHT');assert.throws(()=>x.controller.observe());assert.equal(x.calls,1);}finally{x.close();}}
});
test('invalid selector/source/ceiling refuse before SQL; wrong metadata/custody remains uncertain',()=>{
 for(const mode of ['selector','source','ceiling']){const f=fixture();try{if(mode==='source')f.plan.source.coreCommit='e'.repeat(40);if(mode==='ceiling')f.plan.resource.allowances.observers=3;assert.throws(()=>f.controller.storedCounts(mode==='selector'?{...selector(),schema:'foreign'}:selector()));assert.equal(f.calls,0);}finally{f.close();}}
 for(const mode of ['resource','custody','payload']){const f=fixture();try{f.foreign=2;const original=f.ports.storedCounts;f.ports.storedCounts=(...args)=>{const value=original(...args);if(mode==='resource')value.resource.systemIdentifier='foreign';if(mode==='custody')value.custody.project='foreign';if(mode==='payload')value.storedCounts.rows[0].doc={};return value;};let failure;try{f.controller.storedCounts(selector());assert.fail('must refuse');}catch(error){failure=error;}assert.match(failure.countsDiagnostic,/^counts-observation-/);assert.equal(F.read(path.join(f.dir,failure.countsDiagnostic)).foreign.entries,2);assert(fs.existsSync(path.join(f.dir,'observer-claim.json')));assert.throws(()=>f.controller.storedCounts(selector()));assert.equal(f.calls,1);}finally{f.close();}}
});
test('count admission rejects malformed ledger incarnation before SQL like ordinary observation',()=>{const f=fixture();try{
 f.plan.slots.push({processInstanceId:'synthetic'});const {sha256,...body}=f.plan;f.plan.sha256=B.hash(body);const book=B.ledger(f.plan);book.slots.synthetic=[{state:'ISSUED',tags:[],incarnation:'not-canonical'}];F.write(path.join(f.dir,'ledger.json'),book);
 const controller=require('../connection-budget-controller').create({directory:f.dir,plan:f.plan,expected:f.expected,ports:f.ports});assert.throws(()=>controller.observe(),/CONNECTION_CONTROLLER_LEDGER/);assert.throws(()=>controller.storedCounts(selector()),/CONNECTION_CONTROLLER_LEDGER/);assert.equal(f.calls,0);assert(!fs.existsSync(path.join(f.dir,'observer-claim.json')));
 }finally{f.close();}});
test('diagnostic disk failure retains positive foreign observation and unknown credits',()=>{const f=fixture(),write=F.write;try{
 f.foreign=2;F.write=(file,...args)=>{if(path.basename(file).startsWith('counts-observation-'))throw Object.assign(Error('synthetic disk failure'),{code:'EIO'});return write(file,...args);};
 let failure;try{f.controller.storedCounts(selector());assert.fail('must refuse');}catch(error){failure=error;}finally{F.write=write;}
 const result=require('../connection-budget-cli').errorResult(failure);assert.equal(result.error,'EIO');assert.equal(result.countsObservation.foreign.entries,2);assert.equal(result.countsObservation.validation,'UNVALIDATED_DIAGNOSTIC_NOT_ACCEPTANCE');assert.equal(result.countsDiagnostic,undefined);assert.equal(f.calls,1);assert.equal(F.read(path.join(f.dir,'observers.json')).at(-1).state,'IN_FLIGHT');assert(fs.existsSync(path.join(f.dir,'observer-claim.json')));assert.throws(()=>f.controller.observe());assert.equal(f.calls,1);
 }finally{F.write=write;f.close();}});
test('actual CLI private selector path and early source guard; no arbitrary query or profile fields',()=>{
 const f=fixture(true);try{
  fs.mkdirSync(path.join(f.state,'bootstrap'),{mode:0o700});
  const digests=Object.fromEntries(['compose.yaml','.env','postgres-ready.sh'].map(name=>[path.join(f.dir,name),crypto.createHash('sha256').update(fs.readFileSync(path.join(f.dir,name))).digest('hex')]));
  const config={...f.expected,image:f.expected.imageId,composeFiles:[path.join(f.dir,'compose.yaml')],fileDigests:digests};
  F.write(path.join(f.dir,'controller-config.json'),config);F.write(path.join(f.dir,'plan.json'),f.plan);F.write(path.join(f.state,'bootstrap/complete.json'),{sourceCommit:f.plan.source.coreCommit,deployCommit:f.plan.source.deployCommit});
  const file=path.join(f.state,'selector.json');F.write(file,selector());
  const filename=require.resolve('../connection-budget-cli'),loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));const original=loaded.require.bind(loaded);let imports=0;
  loaded.require=name=>name==='./build'?{assertCleanSource:()=>f.plan.source.coreCommit,overlay:()=>({deployCommit:f.plan.source.deployCommit})}:name==='./connection-budget-docker'?{create(){imports++;return f.ports;}}:name==='node:child_process'?{spawnSync(command,args){assert.equal(command,'docker');if(args[0]==='image')return{status:0,stdout:JSON.stringify([{Id:f.expected.imageId,Config:{Labels:{'org.opencontainers.image.revision':f.plan.source.coreCommit,'org.nightscout.deploy.revision':f.plan.source.deployCommit}}}])};if(args[0]==='compose')return{status:0,stdout:f.postgres.cid};if(args[0]==='inspect')return{status:0,stdout:JSON.stringify([{Id:f.postgres.cid,Image:f.postgres.imageId,State:{Running:true,StartedAt:f.postgres.startedAt},Config:{Labels:{'com.docker.compose.project':f.expected.project,'com.docker.compose.project.working_dir':f.expected.workingDirectory,'com.docker.compose.service':'postgres'}}}])};throw Error('UNEXPECTED_CLI_CHILD');}}:original(name);loaded._compile(fs.readFileSync(filename,'utf8'),filename);
  assert.equal(loaded.exports.main([f.state,'bind']).state,'BOUND');assert.equal(f.calls,1);
  const value=loaded.exports.main([f.state,'stored-counts',file]);assert.equal(value.counts.length,2);assert.equal(f.calls,2);
  assert.throws(()=>loaded.exports.main([f.state,'observe']),/OBSERVER_CREDITS_HELD/);assert.equal(f.calls,2);
  F.write(path.join(f.state,'foreign.json'),{...selector(),schema:'foreign'});assert.throws(()=>loaded.exports.main([f.state,'stored-counts',path.join(f.state,'foreign.json')]));assert.equal(f.calls,2);
  const before=imports;f.plan.source.coreCommit='e'.repeat(40);const {sha256,...body}=f.plan;f.plan.sha256=B.hash(body);config.source=f.plan.source;F.write(path.join(f.dir,'plan.json'),f.plan);F.write(path.join(f.dir,'controller-config.json'),config);
  assert.throws(()=>loaded.exports.main([f.state,'stored-counts',file]),/UNREVIEWED_SOURCE/);assert.equal(imports,before);assert.equal(f.calls,2);
 }finally{f.close();}
});
module.exports={fixture,selector,zero};
