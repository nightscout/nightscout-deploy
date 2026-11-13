'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const F=require('../connection-budget-files'),B=require('../connection-budget');
test('actual core ticket install, never-connected real PG end ACK and duplicate pre-constructor refusal',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ns-budget-runtime-'));fs.chmodSync(directory,0o700);const claims=path.join(directory,'claims');fs.mkdirSync(claims,{mode:0o700});
 const source={coreCommit:'d0036890d0623ae79f14bfa71e7226c0fa122a29',deployCommit:'b'.repeat(40)},capabilities={'migration-direct':{kind:'client',directGroup:'checks'}},directGroups={checks:1},cold={activeLimit:1,pendingLimit:16,minDelayMs:1,maxDelayMs:2};
 const body={version:1,kind:'controlled-connection-budget-plan',source,resource:{pgResourceId:'synthetic-pg',aliases:['postgres:5432']},slots:[{processInstanceId:'ui',startupConcurrency:4,capabilities,directGroups,cold}]},plan={...body,sha256:B.hash(body)};
 const ticket={version:1,planSha256:plan.sha256,processInstanceId:'ui',incarnation:'c'.repeat(32),nonce:'d'.repeat(32),source,pgResourceId:'synthetic-pg',resourceAliases:['postgres:5432'],capabilities,directGroups,cold};
 F.write(path.join(directory,'plan.json'),plan);F.write(path.join(directory,'ticket.json'),ticket);
 const root=path.join(directory,'source'),base=path.join(root,'deploy/multitenant');fs.mkdirSync(base,{recursive:true});fs.symlinkSync(path.resolve(__dirname,'../../../lib'),path.join(root,'lib'),'dir');for(const name of ['connection-budget-runtime.js','connection-budget.js','connection-budget-files.js'])fs.copyFileSync(path.join(__dirname,'..',name),path.join(base,name));
 const marker=path.join(base,'.image-source.json');
 try{fs.writeFileSync(marker,JSON.stringify({version:1,coreCommit:source.coreCommit,deployCommit:source.deployCommit}),{mode:0o444});
 const script=`const M=require('node:module'),fs=require('node:fs'),load=M._load;M._load=function(name,...args){if(name==='../../lib/storage/connection-admission')fs.appendFileSync(${JSON.stringify(path.join(directory,'core-execution'))},'x');return load.call(this,name,...args);};const runtime=require(${JSON.stringify(path.join(base,'connection-budget-runtime'))});runtime.install();const PG=require('pg'),admission=require(${JSON.stringify(path.join(__dirname,'../../../lib/storage/connection-admission'))});class Client extends PG.Client{constructor(options){super(options);fs.appendFileSync(${JSON.stringify(path.join(directory,'constructed'))},'x');}};(async()=>{const C=admission.wrapClient(Client,'migration-direct'),c=new C({host:'postgres',port:5432,ssl:false,application_name:'original-migration'});runtime.beginQuiesce();await c.end();await runtime.finalizeQuiescence(true);})().catch(()=>process.exitCode=1);`;

 const env={...process.env,NS_SOURCE_COMMIT:source.coreCommit,NS_CONNECTION_BUDGET_PLAN_FILE:path.join(directory,'plan.json'),NS_CONNECTION_BUDGET_FILE:path.join(directory,'ticket.json'),NS_CONNECTION_BUDGET_CLAIM_DIR:claims};
 const one=spawnSync(process.execPath,['-e',script],{env,encoding:'utf8',timeout:5000,maxBuffer:16384});assert.equal(one.status,0,one.stderr);
 const ack=F.read(path.join(claims,'ack-'+ticket.incarnation+'.json'));assert.equal(ack.constructorsFrozen,true);assert.equal(ack.pendingConnects,0);assert.equal(ack.liveConnections,0);assert.equal(ack.unconfirmedCleanup,false);assert.equal(ack.cleanShutdown,true);assert.equal(ack.tags.length,1);assert.equal(ack.applicationNames[ack.tags[0]].originalApplicationName,'original-migration');assert.equal(fs.statSync(path.join(claims,'ack-'+ticket.incarnation+'.json')).mode&0o777,0o600);
 const two=spawnSync(process.execPath,['-e',script],{env,encoding:'utf8',timeout:5000,maxBuffer:16384});assert.notEqual(two.status,0);assert.equal(fs.readFileSync(path.join(directory,'core-execution'),'utf8'),'x','duplicate refused before referenced core admission code executes');assert.equal(fs.readFileSync(path.join(directory,'constructed'),'utf8'),'x','duplicate refused before any new PG constructor');assert(two.stderr.includes('CONNECTION_BUDGET_CLAIM_REUSED'));
 // Explicit version1 matches all compiled legacy plans. Host plan2 remains held
 // until the independent core physical ticket2 gate is frozen.
 const freshBody={...body,version:2,workerDatabase:{database:'synthetic',databaseOid:'16384'}};F.write(path.join(directory,'plan.json'),{...freshBody,sha256:B.hash(freshBody)});const held=spawnSync(process.execPath,['-e',script],{env,encoding:'utf8',timeout:5000,maxBuffer:16384});assert.notEqual(held.status,0);assert(held.stderr.includes('PHYSICAL_V2_NOT_REVIEWED'));assert.equal(fs.readFileSync(path.join(directory,'core-execution'),'utf8'),'x');
 }finally{fs.rmSync(directory,{recursive:true});}
});
test('default installer remains empty; selected undeclared CLI refuses before touching any referenced files',()=>{
 const runtime=require('../connection-budget-runtime');assert.equal(runtime.install({}),null);
 assert.throws(()=>runtime.install({NS_CONNECTION_BUDGET_UNPLANNED_PROCESS:'1',NS_CONNECTION_BUDGET_FILE:'/missing/untrusted.json'}),/UNPLANNED_PROCESS/);
});
