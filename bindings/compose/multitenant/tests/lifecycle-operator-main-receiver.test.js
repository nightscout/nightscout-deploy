'use strict';
// Actual main with recording fixed-file IO. No /run writes, credentials, PG or
// native mounts. This verifies ordering, not native file/mount custody.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),B=require('../connection-budget');
const json=v=>JSON.parse(JSON.stringify(v));
function fixture(){
 const className='lifecycle-operator',source={coreCommit:B.REVIEWED_CORE_COMMIT,deployCommit:'b'.repeat(40)},expected={source,project:'synthetic',workingDirectory:'/private/synthetic',imageId:'sha256:'+'c'.repeat(64)},action={version:2,command:'inspect',tenant:'11111111-1111-4111-8111-111111111111'},bytes=Buffer.from(JSON.stringify(action)+'\n');
 const ticket={version:2,workerDatabase:{database:'synthetic',databaseOid:'16384'},processInstanceId:className,incarnation:'d'.repeat(32),nonce:'e'.repeat(32),planSha256:'f'.repeat(64),source,pgResourceId:'synthetic-pg',resourceAliases:['postgres:5432'],capabilities:{[className]:{kind:'pool',poolMax:1,maxInstances:1,metadata:{requestedMaximum:1,source:'deploy/multitenant/lifecycle-operator-entry.js',configurationSource:'fixed-controller-control'}}},directGroups:{},cold:{activeLimit:1,pendingLimit:1,minDelayMs:0,maxDelayMs:0},control:{version:2,class:className,intentSha256:B.hash(action),resourceEpoch:['123','epoch'],expected,principal:{role:'synthetic_operator',roleOid:'31',database:'synthetic',databaseOid:'16384'},files:{'action.json':require('node:crypto').createHash('sha256').update(bytes).digest('hex'),'env.json':'1'.repeat(64),'config.json':'2'.repeat(64)}}};
 const gate={version:2,class:className,incarnation:ticket.incarnation,nonce:ticket.nonce,intentSha256:ticket.control.intentSha256,container:{...expected,service:className,cid:'3'.repeat(64),startedAt:'start'}};return {ticket,gate,action,bytes,image:{version:1,coreCommit:B.REVIEWED_CORE_COMMIT,deployCommit:'b'.repeat(40)}};
}
function set(f,p){const keys=p.split('.'),last=keys.pop();let value=f;for(const k of keys)value=value[k];value[last]=[value[last]];}
async function rejectedMain(change,transform=s=>s,expectedEffects={credentials:0,claims:0,core:0}){
 const f=fixture();change(f);const received=json({ticket:f.ticket,gate:f.gate,action:f.action}),effects={credentials:0,claims:0,core:0};
 const filename=require.resolve('../lifecycle-operator-entry'),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
 m.require=function(name){if(name==='./connection-budget-files')return {read(file){if(file==='/run/ns-operator-ticket/ticket.json')return received.ticket;if(file==='/run/ns-operator-ticket/gate.json')return received.gate;if(file==='/run/ns-operator-ticket/action.json')return received.action;effects.credentials++;throw Error('CREDENTIAL_READ_BEFORE_TYPED_REFUSAL');},directory(){effects.claims++;throw Error('CLAIM_OPEN');},writeAt(){effects.claims++;throw Error('CLAIM_WRITE');}};
  if(name==='node:fs')return {...fs,readFileSync(file,...args){return file==='/run/ns-operator-ticket/action.json'?f.bytes:file===path.join(path.dirname(filename),'.image-source.json')?Buffer.from(JSON.stringify(f.image)):fs.readFileSync(file,...args);}};
  if(name==='../../lib/storage/connection-admission'){effects.core++;throw Error('CORE_BEFORE_TYPED_REFUSAL');}return Module.prototype.require.call(this,name);};
 m._compile(transform(fs.readFileSync(filename,'utf8')),filename);let error;try{await m.exports.main();}catch(e){error=e;}
 assert(error,'MALFORMED_MUST_REFUSE');assert.deepEqual(effects,expectedEffects,'NO_CREDENTIAL_CLAIM_CORE_EFFECT');return error;
}
test('actual main refuses serialized fresh2 ticket/control/gate authority before credentials, claim or core require',async()=>{
 for(const p of ['ticket.version','ticket.incarnation','ticket.nonce','ticket.planSha256','ticket.source.deployCommit','ticket.workerDatabase.databaseOid','ticket.control.version','ticket.control.class','ticket.control.intentSha256','ticket.control.resourceEpoch.0','ticket.control.principal.role','ticket.control.principal.roleOid','ticket.control.expected.project','ticket.control.expected.imageId','gate.version','gate.class','gate.incarnation','gate.nonce','gate.container.cid','gate.container.startedAt','gate.container.imageId'])await rejectedMain(f=>set(f,p));
 for(const p of ['ticket.control','ticket.control.files','gate.container'])await rejectedMain(f=>{const keys=p.split('.'),last=keys.pop();let value=f;for(const k of keys)value=value[k];value[last]=[];});
});
test('actual main refuses malformed/mismatched action intent and file digest before credentials or claim',async()=>{
 for(const p of ['action.version','action.command','action.tenant'])await rejectedMain(f=>set(f,p));
 await rejectedMain(f=>f.action.tenant='22222222-2222-4222-8222-222222222222');await rejectedMain(f=>f.ticket.control.files['action.json']='0'.repeat(64));
});
test('moving fresh receiver validation after credential read makes same main ordering oracle red; restored passes',async()=>{
 const transform=s=>s.replace(" if(ticket.version!==1){const receiver=require('./physical-ticket-receiver');", " F.read('/run/ns-operator-env/env.json');\n if(ticket.version!==1){const receiver=require('./physical-ticket-receiver');");assert.notEqual(transform(fs.readFileSync(require.resolve('../lifecycle-operator-entry'),'utf8')),fs.readFileSync(require.resolve('../lifecycle-operator-entry'),'utf8'));
 await assert.rejects(()=>rejectedMain(f=>set(f,'ticket.incarnation'),transform),/NO_CREDENTIAL_CLAIM_CORE_EFFECT/);await rejectedMain(f=>set(f,'ticket.incarnation'));
});

test('valid fresh receiver reaches next private credential boundary, proving refusal instrument is nonvacuous',async()=>{const error=await rejectedMain(()=>{},s=>s,{credentials:1,claims:0,core:0});assert.equal(error.message,'CREDENTIAL_READ_BEFORE_TYPED_REFUSAL');});

test('actual main requires exact class-owned mandatory/optional file names before private credentials',async()=>{
 const required=['action.json','config.json','env.json'];
 for(const name of required)await rejectedMain(f=>delete f.ticket.control.files[name]);
 for(const name of ['foreign.json','environment.json','env.JSON','Env.json','config-copy.json','action-extra.json','placement-copy.json','__proto__'])await rejectedMain(f=>{f.ticket.control.files={...f.ticket.control.files,[name]:'a'.repeat(64)};});
 for(const original of required)for(const replacement of [original.toUpperCase(),original.replace('.json','.JSON'),original.replace('.json','-copy.json')])await rejectedMain(f=>{const files=f.ticket.control.files,hash=files[original];delete files[original];files[replacement]=hash;});
 for(const malformed of [null,[],{},'env.json',17])await rejectedMain(f=>{f.ticket.control.files=malformed;});
 await rejectedMain(f=>{f.ticket.control.files=[f.ticket.control.files];});
 // Both declared lifecycle source rosters pass to the next credential boundary.
 for(const placement of [false,true]){const error=await rejectedMain(f=>{if(placement)f.ticket.control.files['placement.json']='a'.repeat(64);},s=>s,{credentials:1,claims:0,core:0});assert.equal(error.message,'CREDENTIAL_READ_BEFORE_TYPED_REFUSAL');}
});
test('omitting class file roster guard fails the original zero-credential oracle; restored rejects',async()=>{
 const guard="  need(equal(Object.keys(ticket.control.files).sort(),['action.json','config.json','env.json',...(Object.hasOwn(ticket.control.files,'placement.json')?['placement.json']:[])]),'LIFECYCLE_OPERATOR_FILE_ROSTER');";
 const transform=s=>s.replace(guard,'');assert.notEqual(transform(fs.readFileSync(require.resolve('../lifecycle-operator-entry'),'utf8')),fs.readFileSync(require.resolve('../lifecycle-operator-entry'),'utf8'));
 for(const change of [f=>delete f.ticket.control.files['env.json'],f=>delete f.ticket.control.files['config.json'],f=>f.ticket.control.files['foreign.json']='a'.repeat(64)]){await assert.rejects(()=>rejectedMain(change,transform),/NO_CREDENTIAL_CLAIM_CORE_EFFECT/);await rejectedMain(change);}
});

test('actual main checks independently known reviewed source and public image identity before private credentials',async()=>{
 for(const change of [f=>f.ticket.source.coreCommit='0'.repeat(40),f=>f.ticket.source.deployCommit='0'.repeat(40),f=>f.image.coreCommit='0'.repeat(40),f=>f.image.deployCommit='0'.repeat(40),f=>f.image.version=2,f=>f.image.version=[1],f=>f.image.coreCommit=[f.image.coreCommit],f=>f.image.deployCommit=[f.image.deployCommit],f=>f.image.extra='foreign',f=>delete f.image.deployCommit,f=>f.image=[],f=>f.image=null])await rejectedMain(change);
 // Matching image metadata cannot authorize a source other than the fixed core.
 await rejectedMain(f=>{f.ticket.source.coreCommit='0'.repeat(40);f.image.coreCommit=f.ticket.source.coreCommit;});
 const positive=await rejectedMain(()=>{},s=>s,{credentials:1,claims:0,core:0});assert.equal(positive.message,'CREDENTIAL_READ_BEFORE_TYPED_REFUSAL');
});
test('moving immutable source/image validation after credentials fails same early authority oracle; restored refuses',async()=>{
 const marker=" need(ticket.source.coreCommit===B.REVIEWED_CORE_COMMIT,'CONNECTION_BUDGET_UNREVIEWED_SOURCE');";
 const transform=s=>s.replace(marker," F.read('/run/ns-operator-env/env.json');\n"+marker);assert.notEqual(transform(fs.readFileSync(require.resolve('../lifecycle-operator-entry'),'utf8')),fs.readFileSync(require.resolve('../lifecycle-operator-entry'),'utf8'));
 for(const change of [f=>f.ticket.source.coreCommit='0'.repeat(40),f=>f.image.deployCommit='0'.repeat(40)]){await assert.rejects(()=>rejectedMain(change,transform),/NO_CREDENTIAL_CLAIM_CORE_EFFECT/);await rejectedMain(change);}
});
