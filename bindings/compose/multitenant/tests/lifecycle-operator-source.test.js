'use strict';
// Run only in a joined source fixture. Actual admission, pg driver/pool,
// restore-resume, readiness, adapter and remote cohort; recording IO, no PG/RLS.
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const E=require('../lifecycle-operator-entry'),O=require('../lifecycle-operator'),B=require('../connection-budget'),C=require('../control-recovery');
const pg=require('pg'),protocol=require('../../../tests/fixtures/operation-window-admission-protocol'),lower=require('../../../lib/storage/postgres-connection');
const A='11111111-1111-4111-8111-111111111111',BID='22222222-2222-4222-8222-222222222222',CLAIM='33333333-3333-4333-8333-333333333333',OP='44444444-4444-4444-8444-444444444444';
const DATA={database:'synthetic',database_oid:'16384',server_address:'127.0.0.1',server_port:5432,postmaster_birth:'1700000000.000000'};
function fresh(relative,transform=s=>s){const filename=require.resolve(relative),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m._compile(transform(fs.readFileSync(filename,'utf8')),filename);return m.exports;}
async function run(command='resume',flags={}){
 const entry=flags.entryTransform?fresh('../lifecycle-operator-entry',flags.entryTransform):E;
 const trace=[],instances=[],metadata=protocol(),peers=['api','evaluator','realtime','tenant-admin'].map((role,i)=>({id:'peer_'+i,roles:[role],namespaces:['clinical_'+i],endpoint:{socketPath:'/synthetic/peer_'+i+'.sock',maxBytes:100000,timeoutMs:1000}}));
 let statusCalls=0,now=0,working,changed=false;
 const tenantBindings=[];
 const durable={phase:'suspended',claim_id:CLAIM,artifact_digest:'a'.repeat(64),generation:'2',lock_key:'41',auditState:flags.dataReplaced?'restored':'suspended',resumes:[],clearance:[]};
 const clients={lifecycleParticipant(endpoint){const i=peers.findIndex(p=>p.endpoint.socketPath===endpoint.socketPath),peer=peers[i];return {
  async getStatus({request}){statusCalls++;if(flags.missing)throw Object.assign(Error('missing'),{code:'SOCKET_IPC_UNAVAILABLE'});let identity={...protocol.identity};if(flags.partial)delete identity.clearanceOid;
   return {version:1,participant:peer.id,incarnation:(flags.stale&&statusCalls>8?'bbbbbbbb':'aaaaaaaa')+'-1111-4111-8111-111111111111',namespace:'synthetic_window',roles:peer.roles,tenants:['registry:synthetic_registry'],namespaces:peer.namespaces,identity,datastore:DATA,backends:[{pid:100+i,role:'synthetic_'+i,birth:'birth_'+i}],request};},
  async getOperations(body){return {request:body.request,tenant:body.tenant,participant:peer.id,incarnation:body.incarnation,operations:flags.liveOperation?[OP]:[]};},
  async invalidateTenant(body){trace.push('invalidate:'+body.tenant);const reply=await this.getStatus(body);return {...reply,tenant:body.tenant};}
 };}};
 const original=Module._load;
 Module._load=function(name,...args){if(name==='../internal-api/clients')return clients;return original.call(this,name,...args);};
 const cohort=fresh('../../../lib/server/serve/operation-cohort',flags.cohortTransform);Module._load=original;
 const admission=fresh('../../../lib/storage/connection-admission',flags.admissionTransform);
 class Stream extends EventEmitter{constructor(){super();this.writable=true;this.destroyed=false;}write(bytes,callback){if(bytes[0]===88)trace.push('Terminate');callback?.();return true;}end(){this.writable=false;if(!flags.noEOF)queueMicrotask(()=>{this.emit('end');this.emit('close',false);});}destroy(error){this.destroyed=true;this.writable=false;queueMicrotask(()=>this.emit('close',!!error));return this;}}
 class Client extends pg.Client{
  constructor(options){super(options);instances.push(this);this.connection.stream=new Stream();const c=this.connection,s=c.stream;c.connect=function(){this._connecting=true;s.on('error',e=>this.emit('error',e));s.once('close',()=>this.emit('end'));queueMicrotask(()=>{if(flags.authLate)now=31000000000;this.emit('readyForQuery',{status:'I'});});};}
  async query(query,values=[]){const callback=typeof values==='function'?values:null;const text=typeof query==='string'?query:query.text;if(typeof query!=='string')values=query.values||[];trace.push(text);
   if(text.startsWith('SELECT pg_catalog.current_database()')){const result={rows:[{database:flags.wrongPhysicalDatabase?'other':'synthetic',databaseOid:flags.wrongPhysicalOid?'16385':'16384'}]};assert.equal(typeof callback,'function');queueMicrotask(()=>callback(null,result));return;}
   if(text.startsWith('SELECT current_user'))return {rows:[{role:flags.wrongPrincipal?'wrong':'synthetic_operator',roleOid:flags.wrongRoleOid?'32':'31',database:'synthetic',databaseOid:flags.wrongDatabaseOid?'16385':'16384',epoch:flags.wrongEpoch?'new':'epoch',pid:50,birth:'operator-birth'}]};
   const ready=metadata(text,values);if(ready)return ready;
   if(text==='SELECT '+lower.datastoreSQL)return {rows:[DATA]};
   if(text==='SELECT pg_catalog.pg_stat_clear_snapshot()')return {rows:[]};
   if(text.includes('restore-cohort-actors'))return {rows:[...peers.map((p,i)=>({pid:100+i,role:'synthetic_'+i,birth:'birth_'+i})),...(flags.unknownActor?[{pid:999,role:'unknown',birth:'unknown',clinical:true}]:[])]};
   if(text==='BEGIN'){working=structuredClone(durable);return {rows:[],command:'BEGIN'};}
   if(text==='ROLLBACK'){working=undefined;return {rows:[],command:'ROLLBACK'};}
   if(text==='COMMIT'){Object.assign(durable,working);working=undefined;if(flags.commitLate)now=31000000000;if(flags.lostCommit)throw Object.assign(Error('lost'),{code:'ECONNRESET'});return {rows:[],command:'COMMIT'};}
   if(text.includes('set_config')){assert.equal(values[0],A,'REQUESTED_TENANT_TRANSACTION');tenantBindings.push(values[0]);return {rows:[]};}
   if(text.includes('resume-refresh'))return {rows:[]};
   if(text.includes('resume-current-authority'))return {rows:[{active:!flags.revoked}]};
   if(text.includes('resume-window'))return {rows:[{...working||durable}]};
   if(text.includes('resume-audit'))return {rows:[{generation:'2',artifact_digest:'a'.repeat(64),state:durable.auditState,owner_present:flags.ownerUnknown?null:false,resumed:false}]};
   if(text.includes('resume-pending'))return {rows:command==='clear-operations'?[{operation_id:OP,generation:'1',owner_pid:7,owner_birth:'old',gone:flags.backendLive?false:true}]:[]};
   if(text.includes('resume-exclusive'))return {rows:[{held:true}]};
   if(text.startsWith('UPDATE ')){assert(text.includes("WHERE tenant_id=$1 AND phase='suspended'"),'TENANT_ROW_PREDICATE');assert.equal(values[0],A,'REQUESTED_TENANT_UPDATE');tenantBindings.push(values[0]);changed=true;working.phase='active';return {rows:[],rowCount:1};}
   if(text.startsWith('INSERT ')&&text.includes('restore_resume')){assert.equal(values[0],A,'REQUESTED_TENANT_AUDIT');tenantBindings.push(values[0]);working.resumes.push(values);if(flags.beforeCommit)now=31000000000;return {rows:[],rowCount:1};}
   if(text.startsWith('INSERT ')&&text.includes('operation_clearance')){assert.equal(values[0],A,'REQUESTED_TENANT_CLEARANCE');tenantBindings.push(values[0]);working.clearance.push(values);return {rows:[],rowCount:1};}
   throw Error('Unexpected fixture SQL '+text);
  }
 }
 const source=flags.admittedTicket?.source||{coreCommit:'a'.repeat(40),deployCommit:'b'.repeat(40)},expected={source,project:'synthetic',workingDirectory:'/synthetic',imageId:'sha256:'+'c'.repeat(64)};
 const intent={version:1,command,tenant:flags.wrongTenant?CLAIM:A,...(command==='resume'?{claimId:flags.wrongClaim?OP:CLAIM}:{})};
 const row={incarnation:'d'.repeat(32),nonce:'e'.repeat(32),intent,intentSha256:B.hash(intent)},plan={source,sha256:'f'.repeat(64),resource:{pgResourceId:'synthetic-pg',aliases:['synthetic-pg:5432'],systemIdentifier:'123',postmasterStartedAt:'epoch'},lifecycleOperator:{principal:{role:'synthetic_operator',roleOid:'31',database:'synthetic',databaseOid:'16384'}}};
 let ticket=O.ticket(plan,row,expected,{});const container={...expected,service:O.NAME,cid:'a'.repeat(64),startedAt:'start'};let gate={version:1,incarnation:row.incarnation,nonce:row.nonce,intentSha256:row.intentSha256,container};
 if(flags.fresh){
  intent.version=2;const freshBody={...plan,version:2,workerDatabase:{database:'synthetic',databaseOid:'16384'},slots:[],lifecycleOperator:{version:2},resource:{...plan.resource,allowances:{controlRecovery:2}},controlRecovery:{version:1,classes:Object.fromEntries(C.CLASSES.map(c=>[c,{principal:{...plan.lifecycleOperator.principal,...(c==='restore-commissioner'?{role:'synthetic_ddl',roleOid:'32'}:{})}}]))}};delete freshBody.sha256;
  const freshPlan={...freshBody,sha256:B.hash(freshBody)},book=C.ledger(freshPlan),freshRow=C.allocate(freshPlan,book,{class:O.NAME,intentSha256:B.hash(intent)});
  ticket=C.ticket(freshPlan,book,freshRow,expected,{'action.json':'1'.repeat(64)});C.bound(freshPlan,book,freshRow,container,expected);gate=C.gate(freshPlan,book,freshRow);
 }
 if(flags.admittedTicket){ticket=structuredClone(flags.admittedTicket);gate=structuredClone(flags.admittedGate);}
 const credential=new URL('postgresql://'+plan.resource.aliases[0]);credential.username=plan.lifecycleOperator.principal.role;credential.password=require('node:crypto').randomBytes(16).toString('hex');credential.pathname='/'+plan.lifecycleOperator.principal.database;credential.searchParams.set('sslmode','disable');
 if(flags.wrongSource)ticket.source={...source,coreCommit:'b'.repeat(40)};if(flags.wrongImage)gate.container.imageId='sha256:'+'e'.repeat(64);if(flags.workerTicket)ticket.processInstanceId='api';
 if(flags.malformed){const keys=flags.malformed.split('.'),field=keys.pop();let target=keys.shift()==='gate'?gate:ticket;for(const key of keys)target=target[key];target[field]=[target[field]];}
 ticket=JSON.parse(JSON.stringify(ticket));gate=JSON.parse(JSON.stringify(gate));
 const config={control:{namespace:'synthetic_window',registry:{namespace:'synthetic_registry'},locks:[{tenant:A,key:'41'},{tenant:BID,key:'42'}],participants:peers}};
 Module._load=function(name,...args){if(name==='./lifecycle-operator-entry')return entry;if(['../../lib/server/serve/operation-cohort','../server/serve/operation-cohort'].includes(name))return cohort;return original.call(this,name,...args);};
 let receipt,error;
 try{const work=entry.execute({ticket,gate,action:flags.fresh?intent:undefined,config,env:{NS_SOURCE_COMMIT:source.coreCommit,NS_OPERATOR_PG:credential.toString()},admission,pg:{Pool:pg.Pool,Client},clock:()=>BigInt(now)});
  if(flags.noEOF){await new Promise(resolve=>setImmediate(resolve));assert.equal(admission.health().liveConnections,1);assert.equal(admission.health().unconfirmedCleanup,false);instances[0].connection.stream.emit('close',true);}
  receipt=await work;
 }catch(cause){error=cause;}finally{Module._load=original;}
 return {receipt,error,durable,tenantBindings,trace,instances,admission,statusCalls,changed};
}
test('actual core admitted Pool/driver/restore/cohort chain commits append-only resume and clean Terminate+EOF',async()=>{const f=await run();assert.ifError(f.error);assert.equal(f.receipt.outcome,'COMPLETED');assert.equal(f.durable.phase,'active');assert.equal(f.durable.resumes.length,1);assert.equal(f.instances.length,1);assert(f.trace.includes('Terminate'));assert(f.tenantBindings.length>=3&&f.tenantBindings.every(tenant=>tenant===A),'SOURCE_SQL_SCOPED_TO_A');assert(f.statusCalls>=16);});
test('diagnostic inspect omits unavailable peers and writes no audit',async()=>{const f=await run('inspect',{missing:true});assert.ifError(f.error);assert.equal(f.receipt.outcome,'COMPLETED');assert.equal(f.statusCalls,0);assert.equal(f.durable.resumes.length,0);assert(!f.trace.includes('COMMIT'));});
test('both mutations refuse unavailable/partial/stale/unknown actor/current authority before durable audit',async()=>{for(const command of ['resume','clear-operations'])for(const flags of [{missing:true},{partial:true},{stale:true},{unknownActor:true},{revoked:true}]){const f=await run(command,flags);assert.ifError(f.error);assert.equal(f.receipt.outcome,'REFUSED',JSON.stringify(flags));assert.equal(f.durable.resumes.length+f.durable.clearance.length,0);assert(!f.trace.includes('COMMIT'));}});
test('live/unknown owners retained; orphan-only clearance appends and leaves restore audit intact',async()=>{for(const flags of [{},{backendLive:true},{liveOperation:true}]){const f=await run('clear-operations',flags);assert.ifError(f.error);assert.equal(f.durable.clearance.length,flags.backendLive||flags.liveOperation?0:1);assert.equal(f.durable.auditState,'suspended');}const unknown=await run('resume',{ownerUnknown:true});assert.equal(unknown.receipt.outcome,'REFUSED');});
test('wrong backend principal/epoch/claim refuses; finite auth/SQL/COMMIT lease and missing EOF stay uncertain',async()=>{for(const flags of [{wrongPrincipal:true},{wrongRoleOid:true},{wrongDatabaseOid:true},{wrongEpoch:true},{wrongClaim:true}]){const f=await run('resume',flags);assert.ifError(f.error);assert.equal(f.receipt.outcome,'REFUSED');assert.equal(f.durable.resumes.length,0);}for(const flags of [{authLate:true},{beforeCommit:true},{commitLate:true},{lostCommit:true},{noEOF:true}]){const f=await run('resume',flags);assert.equal(f.error?.code,'LIFECYCLE_OPERATOR_OUTCOME_UNCERTAIN',JSON.stringify(flags));assert.equal(f.receipt,undefined);if(flags.beforeCommit||flags.authLate)assert(!f.trace.includes('COMMIT'));}});

test('actual cohort unknown-actor exemption mutant reaches mutation and fails refusal oracle; restored remains closed',async()=>{
 const original=fs.readFileSync(require.resolve('../../../lib/server/serve/operation-cohort'),'utf8');const transform=s=>s.replace("throw fail('RESTORE_COHORT_UNKNOWN_BACKEND');",'continue;');assert.notEqual(transform(original),original);
 const mutant=await run('resume',{unknownActor:true,cohortTransform:transform});assert.ifError(mutant.error);assert.throws(()=>assert.equal(mutant.receipt.outcome,'REFUSED'),/COMPLETED/);
 const restored=await run('resume',{unknownActor:true});assert.equal(restored.receipt.outcome,'REFUSED');assert.equal(restored.durable.resumes.length,0);
});

test('source/image/unconfigured tenant/worker ticket substitutions refuse before backend construction',async()=>{for(const flags of [{wrongSource:true},{wrongImage:true},{wrongTenant:true},{workerTicket:true}]){const f=await run('inspect',flags);assert(f.error,JSON.stringify(flags));assert.equal(f.instances.length,0);assert.equal(f.durable.resumes.length,0);}});
test('backend-principal fence mutant fails wrong-principal oracle and restored source refuses',async()=>{const transform=s=>s.replace('r.rows[0].role===op.principal.role','true');const source=fs.readFileSync(require.resolve('../lifecycle-operator-entry'),'utf8');assert.notEqual(transform(source),source);const mutant=await run('resume',{wrongPrincipal:true,entryTransform:transform});assert.ifError(mutant.error);assert.throws(()=>assert.equal(mutant.receipt.outcome,'REFUSED'),/COMPLETED/);const restored=await run('resume',{wrongPrincipal:true});assert.equal(restored.receipt.outcome,'REFUSED');assert.equal(restored.durable.resumes.length,0);});

test('physical2 lifecycle ticket reaches actual driver admission, then principal verification, then restore-resume',async()=>{const f=await run('resume',{fresh:true});assert.ifError(f.error);assert.equal(f.receipt.version,2);assert.equal(f.receipt.kind,'controlled-operation-complete');assert.equal(f.receipt.class,O.NAME);assert.equal(f.durable.resumes.length,1);assert.equal(f.instances.length,1);const database=f.trace.findIndex(t=>t.startsWith('SELECT pg_catalog.current_database()')),principal=f.trace.findIndex(t=>t.startsWith('SELECT current_user'));assert(database>=0&&principal>database);assert(f.trace.includes('Terminate'));});
test('physical2 wrong database name/OID has no receipt or mutation; actual admission preserves uncertainty',async()=>{for(const flags of [{wrongPhysicalDatabase:true},{wrongPhysicalOid:true}]){const f=await run('resume',{fresh:true,...flags});assert.equal(f.error?.code,'LIFECYCLE_OPERATOR_OUTCOME_UNCERTAIN');assert.equal(f.receipt,undefined);assert.equal(f.durable.resumes.length,0);assert.equal(f.instances.length,1);assert.equal(f.admission.health().unconfirmedCleanup,true);assert(!f.trace.some(t=>t.startsWith('SELECT current_user')));}});
test('physical2 late auth/SQL/COMMIT and missing EOF never publish completion',async()=>{for(const flags of [{authLate:true},{beforeCommit:true},{commitLate:true},{lostCommit:true},{noEOF:true}]){const f=await run('resume',{fresh:true,...flags});assert.equal(f.error?.code,'LIFECYCLE_OPERATOR_OUTCOME_UNCERTAIN',JSON.stringify(flags));assert.equal(f.receipt,undefined);}});

test('physical2 core database-OID gate ablation fails the actual entry no-completion oracle; restored stays uncertain',async()=>{const transform=s=>s.replace('identity.databaseOid !== expected.databaseOid','false');assert.notEqual(transform(fs.readFileSync(require.resolve('../../../lib/storage/connection-admission'),'utf8')),fs.readFileSync(require.resolve('../../../lib/storage/connection-admission'),'utf8'));const altered=await run('resume',{fresh:true,wrongPhysicalOid:true,admissionTransform:transform});assert.ifError(altered.error);assert.equal(altered.receipt.outcome,'COMPLETED');assert.throws(()=>assert.equal(altered.receipt,undefined));const restored=await run('resume',{fresh:true,wrongPhysicalOid:true});assert.equal(restored.error?.code,'LIFECYCLE_OPERATOR_OUTCOME_UNCERTAIN');assert.equal(restored.receipt,undefined);});

test('serialized physical2 ticket/control/gate malformed authority refuses before any actual driver constructor',async()=>{for(const malformed of ['ticket.incarnation','ticket.nonce','ticket.source.deployCommit','ticket.control.intentSha256','ticket.control.principal.role','ticket.control.principal.roleOid','ticket.control.expected.project','ticket.control.expected.imageId','ticket.control.resourceEpoch.0','gate.incarnation','gate.nonce','gate.container.cid','gate.container.imageId']){const f=await run('inspect',{fresh:true,malformed});assert.equal(f.error?.code,'CONNECTION_BUDGET_PHYSICAL_TICKET',malformed);assert.equal(f.instances.length,0,malformed);assert.equal(f.receipt,undefined);assert.equal(f.trace.length,0);}});
