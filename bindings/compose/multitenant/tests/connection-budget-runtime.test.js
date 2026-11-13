'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const F=require('../connection-budget-files'),B=require('../connection-budget');
test('actual core ticket install, private nonce ACK and duplicate incarnation refusal',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ns-budget-runtime-'));fs.chmodSync(directory,0o700);const claims=path.join(directory,'claims');fs.mkdirSync(claims,{mode:0o700});
 const source={coreCommit:'1c6a1c2cf0fa898ece933c49f4e6cc5096f762da',deployCommit:'b'.repeat(40)},capabilities={'migration-direct':{kind:'client',directGroup:'checks'}},directGroups={checks:1},cold={activeLimit:1,pendingLimit:16,minDelayMs:1,maxDelayMs:2};
 const body={kind:'controlled-connection-budget-plan',source,resource:{pgResourceId:'synthetic-pg',aliases:['postgres:5432']},slots:[{processInstanceId:'ui',startupConcurrency:4,capabilities,directGroups,cold}]},plan={...body,sha256:B.hash(body)};
 const ticket={version:1,planSha256:plan.sha256,processInstanceId:'ui',incarnation:'c'.repeat(32),nonce:'d'.repeat(32),source,pgResourceId:'synthetic-pg',resourceAliases:['postgres:5432'],capabilities,directGroups,cold};
 F.write(path.join(directory,'plan.json'),plan);F.write(path.join(directory,'ticket.json'),ticket);
 const marker=path.join(__dirname,'..','.overlay.json'),before=fs.existsSync(marker)?fs.readFileSync(marker):null;
 try{fs.writeFileSync(marker,JSON.stringify({deployCommit:source.deployCommit}));
 const script=`const E=require('node:events');const runtime=require(${JSON.stringify(path.join(__dirname,'../connection-budget-runtime'))});runtime.install();const a=require(${JSON.stringify(path.join(__dirname,'../../../lib/storage/connection-admission'))});class Client{constructor(options){require('node:fs').appendFileSync(${JSON.stringify(path.join(directory,'constructed'))},'x');this.connection=new E();this.connectionParameters=options;}connect(){return Promise.resolve();}end(cb){this.connection.emit('end');cb();}};(async()=>{const C=a.wrapClient(Client,'migration-direct'),c=new C({host:'postgres',port:5432,application_name:'original-migration'});await c.connect();runtime.beginQuiesce();await c.end();await runtime.finalizeQuiescence(true);})().catch(()=>process.exitCode=1);`;
 const env={...process.env,NS_SOURCE_COMMIT:source.coreCommit,NS_CONNECTION_BUDGET_PLAN_FILE:path.join(directory,'plan.json'),NS_CONNECTION_BUDGET_FILE:path.join(directory,'ticket.json'),NS_CONNECTION_BUDGET_CLAIM_DIR:claims};
 const one=spawnSync(process.execPath,['-e',script],{env,encoding:'utf8',timeout:5000,maxBuffer:16384});assert.equal(one.status,0,one.stderr);
 const ack=F.read(path.join(claims,'ack-'+ticket.incarnation+'.json'));assert.equal(ack.constructorsFrozen,true);assert.equal(ack.pendingConnects,0);assert.equal(ack.liveConnections,0);assert.equal(ack.unconfirmedCleanup,false);assert.equal(ack.cleanShutdown,true);assert.equal(ack.applicationNames[ack.tags[0]].originalApplicationName,'original-migration');assert.equal(fs.statSync(path.join(claims,'ack-'+ticket.incarnation+'.json')).mode&0o777,0o600);
 const two=spawnSync(process.execPath,['-e',script],{env,encoding:'utf8',timeout:5000,maxBuffer:16384});assert.notEqual(two.status,0);assert.equal(fs.readFileSync(path.join(directory,'constructed'),'utf8'),'x','duplicate refused before any new constructor');assert(two.stderr.includes('CONNECTION_BUDGET_CLAIM_REUSED'));
 }finally{if(before)fs.writeFileSync(marker,before);else fs.unlinkSync(marker);fs.rmSync(directory,{recursive:true});}
});
test('default installer remains empty; selected undeclared CLI refuses before touching any referenced files',()=>{
 const runtime=require('../connection-budget-runtime');assert.equal(runtime.install({}),null);
 assert.throws(()=>runtime.install({NS_CONNECTION_BUDGET_UNPLANNED_PROCESS:'1',NS_CONNECTION_BUDGET_FILE:'/missing/untrusted.json'}),/UNPLANNED_PROCESS/);
});
