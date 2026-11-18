'use strict';
// Run only in a joined source fixture. Actual admission, pg driver/pool,
// restore-resume, readiness, and operator adapter; recording IO, no PG/RLS.
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const E=require('../lifecycle-operator-entry'),O=require('../lifecycle-operator'),B=require('../connection-budget'),C=require('../control-recovery');
const pg=require('pg'),protocol=require('../../../tests/fixtures/operation-window-admission-protocol'),lower=require('../../../lib/storage/postgres-connection');
const A='11111111-1111-4111-8111-111111111111',BID='22222222-2222-4222-8222-222222222222',CLAIM='33333333-3333-4333-8333-333333333333',OP='44444444-4444-4444-8444-444444444444';
const DATA={database:'synthetic',database_oid:'16384',server_address:'127.0.0.1',server_port:5432,postmaster_birth:'1700000000.000000'};
function fresh(relative,transform=s=>s){const filename=require.resolve(relative),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m._compile(transform(fs.readFileSync(filename,'utf8')),filename);return m.exports;}
async function run(command='resume',flags={}){
 const pipeline=['capture','restore'].includes(command),commissioner=command==='commission';
 const artifactIO=require('../lifecycle-artifact-catalogue'),artifactRoot=pipeline?(flags.artifactRoot||fs.mkdtempSync(path.join(require('node:os').tmpdir(),'ns-path-b-artifact-'))):null;
 if(artifactRoot&&!flags.artifactRoot)fs.chmodSync(artifactRoot,0o700);
 const logical=pipeline?require('../../../tests/fixtures/logical-restore-protocol').fixture():null;
 if(logical){logical.catalogues=logical.catalogues.filter(r=>['activity','clock'].includes(r.kind));logical.artifact=require('../../../lib/tenant-lifecycle/artifact').buildArtifact({tenant:A,sourceCommit:flags.admittedTicket?.source.coreCommit||'a'.repeat(40),exportedAt:1700000000000,catalogues:logical.artifact.manifest.catalogues.filter(r=>['activity','clock'].includes(r.kind)).map(r=>({...r,tables:r.tables.map(t=>({...t,rows:logical.artifact.tables[r.kind+'.'+t.table]}))}))});if(command==='restore'&&!flags.artifactRoot)await artifactIO.saveCapture(logical.artifact,artifactRoot);}
 const entry=flags.entryTransform?fresh('../lifecycle-operator-entry',flags.entryTransform):E;
 const trace=[],instances=[],metadata=protocol();
 let now=0,working,changed=false;
 const tenantBindings=[];
 const durable={phase:'suspended',claim_id:CLAIM,artifact_digest:'a'.repeat(64),generation:'2',lock_key:'41',auditState:flags.dataReplaced?'restored':'suspended',resumes:[],clearance:[]};
 const restoreState={window:{lock_key:'41',phase:'active',generation:'1',claim_id:null,artifact_digest:null},audit:null},setupRows=[];let restoreWorking;
 const restoreCurrent=()=>restoreWorking||restoreState;
 const original=Module._load;
 const admission=fresh('../../../lib/storage/connection-admission',flags.admissionTransform);
 class Stream extends EventEmitter{constructor(){super();this.writable=true;this.destroyed=false;}write(bytes,callback){if(bytes[0]===88)trace.push('Terminate');callback?.();return true;}end(){this.writable=false;if(!flags.noEOF)queueMicrotask(()=>{this.emit('end');this.emit('close',false);});}destroy(error){this.destroyed=true;this.writable=false;queueMicrotask(()=>this.emit('close',!!error));return this;}}
 class Client extends pg.Client{
  constructor(options){super(options);instances.push(this);this.connection.stream=new Stream();const c=this.connection,s=c.stream;c.connect=function(){this._connecting=true;s.on('error',e=>this.emit('error',e));s.once('close',()=>this.emit('end'));queueMicrotask(()=>{if(flags.authLate)now=31000000000;if(flags.errorBeforeReady)this.emit('errorMessage',Object.assign(Error('recorded authentication refusal'),{code:'28000'}));this.emit('readyForQuery',{status:'I'});});};}
  // Recording wire completion emits the actual protocol ReadyForQuery event;
  // pg's real handler and core's observer own both readiness states.
  async query(query,values=[]){
   const result=await this.recordedQuery(query,values);
   if(!flags.noReady)this.connection.emit('readyForQuery',{status:working||restoreWorking?'T':'I'});
   return result;
  }
  async recordedQuery(query,values=[]){const callback=typeof values==='function'?values:null;const text=typeof query==='string'?query:query.text;if(typeof query!=='string')values=query.values||[];trace.push(text);
   if(text.startsWith('SELECT pg_catalog.current_database()')){const result={rows:[{database:flags.wrongPhysicalDatabase?'other':'synthetic',databaseOid:flags.wrongPhysicalOid?'16385':'16384'}]};assert.equal(typeof callback,'function');queueMicrotask(()=>callback(null,result));return;}
   if(text.startsWith('SELECT current_user'))return {rows:[{role:flags.wrongPrincipal?'wrong':commissioner?'synthetic_ddl':'synthetic_operator',roleOid:flags.wrongRoleOid?'99':commissioner?'32':'31',database:'synthetic',databaseOid:flags.wrongDatabaseOid?'16385':'16384',epoch:flags.wrongEpoch?'new':'epoch',pid:50,birth:'operator-birth',superuser:!!flags.elevated,bypass:commissioner?!flags.commissionNoBypass:!!flags.bypass}]};
   if(commissioner){
    if(text===require('../restore-commissioner-authority').SQL){const raw=require('./restore-commissioner-authority-fixture').recorded(text,config,ticket.control.principal);if(flags.commissionPublicExtra){raw.relations.push({namespace:'synthetic_clinical',relation:'entries',...Object.fromEntries(require('../restore-commissioner-authority').PRIV.map(k=>[k,k==='select'||k==='columnSelect']))});}return {rows:[raw]};}
    if(text.includes('FROM pg_catalog.pg_roles WHERE rolname=$1'))return {rows:[{oid:flags.commissionWrongOid?'99':'31',rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false}]};
    if(text.includes('tenant_registry r JOIN'))return {rows:[{state:'active',phase:'active'}]};
    if(text.startsWith('SELECT active'))return {rows:flags.revoked?[{active:false}]:[]};
    if(text.startsWith('INSERT INTO')){setupRows.push(values);return {rowCount:1,rows:[]};}
    if(text.includes('set_config'))return {rows:[]};
   }
   if(pipeline&&command==='capture'&&text.includes('capture-bound-columns'))return {rows:[{byteaoutput:'hex',columns:'3',bytes:'128',unsupported:flags.captureUnsupported?'1':'0',tenantcolumns:'1'}]};
   if(pipeline&&command==='capture'&&text.includes('capture-bound-rows')){assert.deepEqual(values,[A]);return {rows:[{rows:'1',bytes:flags.captureOversized?String(17*1024*1024):'512'}]};}
   const ready=metadata(text,values);if(ready)return ready;
   if(pipeline){
    if(text.includes('rolsuper')&&!text.includes('logical-restore'))return {rows:[{rolsuper:false,rolbypassrls:false}]};
    if(text.includes('restore-current-authority'))return {rows:[{active:!flags.revoked}]};
    if(text.includes('restore-backend'))return {rows:[{pid:50,birth:'operator-birth',role_oid:'31'}]};
    if(text.includes('restore-window-claim')||text.includes('restore-window-current'))return {rows:[structuredClone(restoreCurrent().window)]};
    if(text.includes('restore-audit-current'))return {rows:[structuredClone(restoreCurrent().audit)]};
    if(text.includes('restore-preflight')||text.includes('restore-pending'))return {rows:[]};
    if(text.includes('restore-exclusive')||text.includes('suspension-generation-lock'))return {rows:[{held:true}]};
    if(text.includes('pg_advisory_unlock'))return {rows:[{released:true}]};
    if(text.startsWith('UPDATE ')&&text.includes('tenant_lifecycle_windows')){const w=restoreCurrent().window;if(text.includes("SET phase='suspended'")){Object.assign(w,{phase:'suspended',generation:values[1],claim_id:values[2],artifact_digest:values[3]});}else{assert.equal(restoreState.audit.state,'restored');Object.assign(w,{phase:'active',claim_id:null,artifact_digest:null});}return {rowCount:1,rows:[]};}
    if(text.startsWith('INSERT INTO ')&&text.includes('tenant_lifecycle_restore_audit')){restoreCurrent().audit={generation:values[2],artifact_digest:values[3],role_oid:'31',owner_pid:50,owner_birth:'operator-birth',state:'suspended'};return {rowCount:1,rows:[]};}
    if(text.startsWith('UPDATE ')&&text.includes('tenant_lifecycle_restore_audit')){restoreCurrent().audit.state=text.includes("SET state='restored'")?'restored':'activated';return {rowCount:1,rows:[]};}
    if(text.startsWith('BEGIN')){assert(!restoreWorking);restoreWorking=structuredClone(restoreState);logical.begin();return {command:'BEGIN',rows:[]};}
    if(text==='ROLLBACK'){restoreWorking=undefined;logical.rollback();return {command:text,rows:[]};}
    if(text==='COMMIT'){Object.assign(restoreState,restoreWorking);restoreWorking=undefined;await logical.commit();if(flags.commitLate)now=31000000000;if(flags.lostCommit)throw Object.assign(Error('lost'),{code:'ECONNRESET'});return {command:text,rows:[]};}
    if(text.includes('set_config'))return {rows:[]};
    if(command==='capture'&&text.startsWith('SELECT')&&text.includes('FROM "logical_clock"."tenant_write_clock"'))return {rows:[{tenant_id:A,last_stamp:logical.durable.clock[A],last_delete_stamp:'0'}]};
    if(text.includes('pg_attribute')&&!text.includes('logical-restore')){const table=logical.artifact.manifest.catalogues.flatMap(c=>c.tables.map(t=>({...t,namespace:c.namespace}))).find(t=>values[0]==='"'+t.namespace+'"."'+t.table+'"');assert(table,'EXACT_EXPORT_TABLE');return {rows:table.columns.map(c=>({...c,identity:false}))};}
    return logical.connection.query(text,values);
   }
   if(text==='SELECT '+lower.datastoreSQL)return {rows:[DATA]};
   if(text==='SELECT pg_catalog.pg_stat_clear_snapshot()')return {rows:[]};
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
 const intent=commissioner?{version:2,command:'commission'}:{version:1,command,tenant:flags.wrongTenant?CLAIM:A,...(command==='resume'?{claimId:flags.wrongClaim?OP:CLAIM}:command==='restore'?{artifactDigest:flags.artifactDigest||logical.artifact.digest}:{})};
 const row={incarnation:'d'.repeat(32),nonce:'e'.repeat(32),intent,intentSha256:B.hash(intent)},plan={source,sha256:'f'.repeat(64),resource:{pgResourceId:'synthetic-pg',aliases:['synthetic-pg:5432'],systemIdentifier:'123',postmasterStartedAt:'epoch'},lifecycleOperator:{principal:{role:'synthetic_operator',roleOid:'31',database:'synthetic',databaseOid:'16384'}}};
 let ticket=O.ticket(plan,commissioner?{...row,intent:{version:1,command:'inspect',tenant:A},intentSha256:B.hash({version:1,command:'inspect',tenant:A})}:row,expected,{});const container={...expected,service:O.NAME,cid:'a'.repeat(64),startedAt:'start'};let gate={version:1,incarnation:row.incarnation,nonce:row.nonce,intentSha256:row.intentSha256,container};
 if(flags.fresh){
  intent.version=2;const freshBody={...plan,version:2,workerDatabase:{database:'synthetic',databaseOid:'16384'},slots:[],lifecycleOperator:{version:2},resource:{...plan.resource,allowances:{controlRecovery:2}},controlRecovery:{version:1,classes:Object.fromEntries(C.CLASSES.map(c=>[c,{principal:{...plan.lifecycleOperator.principal,...(c==='restore-commissioner'?{role:'synthetic_ddl',roleOid:'32'}:{})}}]))}};delete freshBody.sha256;
  const freshPlan={...freshBody,sha256:B.hash(freshBody)},book=C.ledger(freshPlan),freshRow=C.allocate(freshPlan,book,{class:commissioner?'restore-commissioner':O.NAME,intentSha256:B.hash(intent)});
  ticket=C.ticket(freshPlan,book,freshRow,expected,{'action.json':'1'.repeat(64)});C.bound(freshPlan,book,freshRow,{...container,service:commissioner?'restore-commissioner':O.NAME},expected);gate=C.gate(freshPlan,book,freshRow);
 }
 if(flags.admittedTicket){ticket=structuredClone(flags.admittedTicket);gate=structuredClone(flags.admittedGate);}
 const credential=new URL('postgresql://'+(flags.admittedTicket?.resourceAliases[0]||plan.resource.aliases[0]));credential.username=commissioner?'synthetic_ddl':plan.lifecycleOperator.principal.role;credential.password=require('node:crypto').randomBytes(16).toString('hex');credential.pathname='/'+plan.lifecycleOperator.principal.database;credential.searchParams.set('sslmode','disable');
 if(flags.wrongSource)ticket.source={...source,coreCommit:'b'.repeat(40)};if(flags.wrongImage)gate.container.imageId='sha256:'+'e'.repeat(64);if(flags.workerTicket)ticket.processInstanceId='api';
 if(flags.malformed){const keys=flags.malformed.split('.'),field=keys.pop();let target=keys.shift()==='gate'?gate:ticket;for(const key of keys)target=target[key];target[field]=[target[field]];}
 ticket=JSON.parse(JSON.stringify(ticket));gate=JSON.parse(JSON.stringify(gate));
 let config={control:{namespace:'synthetic_window',registry:{namespace:'synthetic_registry'},locks:[{tenant:A,key:'41'},{tenant:BID,key:'42'}]}};
 if(pipeline)Object.assign(config,{tenants:[{id:A},{id:BID}],namespaces:logical.namespaces,catalogues:logical.catalogues,drainTimeoutMs:1000});
 if(commissioner)config={version:1,operatorPrincipal:plan.lifecycleOperator.principal,tenants:[A,BID],namespace:'synthetic_window',registryNamespace:'synthetic_registry'};
 Module._load=function(name,...args){if(name==='./lifecycle-snapshot'&&flags.snapshotTransform)return fresh('../lifecycle-snapshot',flags.snapshotTransform);if(name==='./config'&&pipeline)return {layout(){return {};},lifecycle(){return {catalogues:logical.catalogues};}};if(name==='./lifecycle-artifact-catalogue'&&pipeline)return {...artifactIO,saveCapture(artifact){return artifactIO.saveCapture(artifact,artifactRoot);},load(ignored,digest){return artifactIO.load(artifactRoot,digest);}};if(name==='./lifecycle-operator-entry')return entry;return original.call(this,name,...args);};
 let receipt,error;
 try{const work=entry.execute({ticket,gate,action:flags.fresh?intent:undefined,config,env:{NS_SOURCE_COMMIT:source.coreCommit,[commissioner?'NS_COMMISSIONER_PG':'NS_OPERATOR_PG']:credential.toString()},admission,pg:{Pool:pg.Pool,Client},clock:()=>BigInt(now)});
  if(flags.noEOF){await new Promise(resolve=>setImmediate(resolve));assert.equal(admission.health().liveConnections,1);assert.equal(admission.health().unconfirmedCleanup,false);instances[0].connection.stream.emit('close',true);}
  receipt=await work;
 }catch(cause){error=cause;}finally{Module._load=original;}
 if(artifactRoot&&!flags.artifactRoot)fs.rmSync(artifactRoot,{recursive:true,force:true});
 return {receipt,error,durable,tenantBindings,trace,instances,admission,changed,restoreState,logicalState:logical?.durable,setupRows};
}
test('actual core admitted Pool/driver/restore chain commits append-only resume and clean Terminate+EOF',async()=>{const f=await run();assert.ifError(f.error);assert.equal(f.receipt.outcome,'COMPLETED');assert.equal(f.durable.phase,'active');assert.equal(f.durable.resumes.length,1);assert.equal(f.instances.length,1);assert(f.trace.includes('Terminate'));assert(f.tenantBindings.length>=3&&f.tenantBindings.every(tenant=>tenant===A),'SOURCE_SQL_SCOPED_TO_A');});
test('diagnostic inspect reports durable state and writes no audit',async()=>{const f=await run('inspect');assert.ifError(f.error);assert.equal(f.receipt.outcome,'COMPLETED');assert.equal(f.durable.resumes.length,0);assert(!f.trace.includes('COMMIT'));});
test('resume refuses revoked authority and unknown restore owner before activation',async()=>{
 for(const flags of [{revoked:true},{ownerUnknown:true}]){
  const f=await run('resume',flags);assert.ifError(f.error);assert.equal(f.receipt.outcome,'REFUSED');
  assert.equal(f.durable.resumes.length,0);assert(!f.trace.includes('COMMIT'));
 }
});
test('wrong backend principal/epoch/claim refuses; finite auth/SQL/COMMIT lease and missing EOF stay uncertain',async()=>{for(const flags of [{wrongPrincipal:true},{wrongRoleOid:true},{wrongDatabaseOid:true},{wrongEpoch:true},{wrongClaim:true}]){const f=await run('resume',flags);assert.ifError(f.error);assert.equal(f.receipt.outcome,'REFUSED');assert.equal(f.durable.resumes.length,0);}for(const flags of [{authLate:true},{beforeCommit:true},{commitLate:true},{lostCommit:true},{noEOF:true}]){const f=await run('resume',flags);assert.equal(f.error?.code,'LIFECYCLE_OPERATOR_OUTCOME_UNCERTAIN',JSON.stringify(flags));assert.equal(f.receipt,undefined);if(flags.beforeCommit||flags.authLate)assert(!f.trace.includes('COMMIT'));}});

test('source/image/unconfigured tenant/worker ticket substitutions refuse before backend construction',async()=>{for(const flags of [{wrongSource:true},{wrongImage:true},{wrongTenant:true},{workerTicket:true}]){const f=await run('inspect',flags);assert(f.error,JSON.stringify(flags));assert.equal(f.instances.length,0);assert.equal(f.durable.resumes.length,0);}});
test('backend-principal fence mutant fails wrong-principal oracle and restored source refuses',async()=>{const transform=s=>s.replace('r.rows[0].role===op.principal.role','true');const source=fs.readFileSync(require.resolve('../lifecycle-operator-entry'),'utf8');assert.notEqual(transform(source),source);const mutant=await run('resume',{wrongPrincipal:true,entryTransform:transform});assert.ifError(mutant.error);assert.throws(()=>assert.equal(mutant.receipt.outcome,'REFUSED'),/COMPLETED/);const restored=await run('resume',{wrongPrincipal:true});assert.equal(restored.receipt.outcome,'REFUSED');assert.equal(restored.durable.resumes.length,0);});

test('physical2 lifecycle ticket reaches actual driver admission, then principal verification, then restore-resume',async()=>{const f=await run('resume',{fresh:true});assert.ifError(f.error);assert.equal(f.receipt.version,2);assert.equal(f.receipt.kind,'controlled-operation-complete');assert.equal(f.receipt.class,O.NAME);assert.equal(f.durable.resumes.length,1);assert.equal(f.instances.length,1);const database=f.trace.findIndex(t=>t.startsWith('SELECT pg_catalog.current_database()')),principal=f.trace.findIndex(t=>t.startsWith('SELECT current_user'));assert(database>=0&&principal>database);assert(f.trace.includes('Terminate'));});
test('physical2 wrong database name/OID has no receipt or mutation; actual admission preserves uncertainty',async()=>{for(const flags of [{wrongPhysicalDatabase:true},{wrongPhysicalOid:true}]){const f=await run('resume',{fresh:true,...flags});assert.equal(f.error?.code,'LIFECYCLE_OPERATOR_OUTCOME_UNCERTAIN');assert.equal(f.receipt,undefined);assert.equal(f.durable.resumes.length,0);assert.equal(f.instances.length,1);assert.equal(f.admission.health().unconfirmedCleanup,true);assert(!f.trace.some(t=>t.startsWith('SELECT current_user')));}});
test('physical2 late auth/SQL/COMMIT and missing EOF never publish completion',async()=>{for(const flags of [{authLate:true},{beforeCommit:true},{commitLate:true},{lostCommit:true},{noEOF:true}]){const f=await run('resume',{fresh:true,...flags});assert.equal(f.error?.code,'LIFECYCLE_OPERATOR_OUTCOME_UNCERTAIN',JSON.stringify(flags));assert.equal(f.receipt,undefined);}});

test('physical2 core database-OID gate ablation fails the actual entry no-completion oracle; restored stays uncertain',async()=>{const transform=s=>s.replace('identity.databaseOid !== expected.databaseOid','false');assert.notEqual(transform(fs.readFileSync(require.resolve('../../../lib/storage/connection-admission'),'utf8')),fs.readFileSync(require.resolve('../../../lib/storage/connection-admission'),'utf8'));const altered=await run('resume',{fresh:true,wrongPhysicalOid:true,admissionTransform:transform});assert.ifError(altered.error);assert.equal(altered.receipt.outcome,'COMPLETED');assert.throws(()=>assert.equal(altered.receipt,undefined));const restored=await run('resume',{fresh:true,wrongPhysicalOid:true});assert.equal(restored.error?.code,'LIFECYCLE_OPERATOR_OUTCOME_UNCERTAIN');assert.equal(restored.receipt,undefined);});

test('serialized physical2 ticket/control/gate malformed authority refuses before any actual driver constructor',async()=>{for(const malformed of ['ticket.incarnation','ticket.nonce','ticket.source.deployCommit','ticket.control.intentSha256','ticket.control.principal.role','ticket.control.principal.roleOid','ticket.control.expected.project','ticket.control.expected.imageId','ticket.control.resourceEpoch.0','gate.incarnation','gate.nonce','gate.container.cid','gate.container.imageId']){const f=await run('inspect',{fresh:true,malformed});assert.equal(f.error?.code,'CONNECTION_BUDGET_PHYSICAL_TICKET',malformed);assert.equal(f.instances.length,0,malformed);assert.equal(f.receipt,undefined);assert.equal(f.trace.length,0);}});

test('fresh actual class refuses elevated backend and missing Ready response keeps uncertainty sticky',async()=>{for(const flags of [{elevated:true},{bypass:true},{noReady:true}]){const f=await run('inspect',{fresh:true,...flags});if(flags.noReady){assert.equal(f.error?.code,'LIFECYCLE_OPERATOR_OUTCOME_UNCERTAIN');assert.equal(f.receipt,undefined);}else{assert.ifError(f.error);assert.equal(f.receipt.outcome,'REFUSED');}assert.equal(f.durable.resumes.length,0);}});

test('fresh fixed commissioner entry uses actual admitted driver and current role-OID setup action',async()=>{for(const flags of [{},{revoked:true},{commissionWrongOid:true},{commitLate:true}]){const f=await run('commission',{fresh:true,...flags});assert.equal(f.instances.length,1);if(flags.commitLate){assert.equal(f.error?.code,'LIFECYCLE_OPERATOR_OUTCOME_UNCERTAIN');assert.equal(f.receipt,undefined);}else{assert.ifError(f.error);assert.equal(f.receipt.class,'restore-commissioner');assert.equal(f.receipt.outcome,flags.revoked||flags.commissionWrongOid?'REFUSED':'COMPLETED');}if(flags.revoked||flags.commissionWrongOid)assert.equal(f.setupRows.length,0);else assert.equal(f.setupRows.length,2);}});
test('fresh admitted capture exports actual bounded activity/clock core artifact on one snapshot backend',async()=>{const f=await run('capture',{fresh:true});assert.ifError(f.error);assert.equal(f.receipt.outcome,'COMPLETED',JSON.stringify(f.receipt.result));assert.equal(f.receipt.result.tenant,A);assert(/^[a-f0-9]{64}$/.test(f.receipt.result.digest));assert.equal(f.instances.length,1);assert(f.trace.includes('BEGIN ISOLATION LEVEL REPEATABLE READ'));assert(f.trace.includes('COMMIT'));assert(f.trace.includes('Terminate'));});
test('fresh admitted restore traverses actual maintenance suspension/data/activation and actual logical activity restore',async()=>{const f=await run('restore',{fresh:true});assert.ifError(f.error);assert.equal(f.receipt.outcome,'COMPLETED',JSON.stringify(f.receipt.result));assert.equal(f.restoreState.window.phase,'active');assert.equal(f.restoreState.audit.state,'activated');assert.equal(f.instances.length,1);assert(f.trace.some(t=>t.includes('logical-restore-row')));assert(f.trace.includes('Terminate'));});

test('recorded error before Ready cannot be cleared by later Ready on actual fresh driver',async()=>{const f=await run('inspect',{fresh:true,errorBeforeReady:true});assert.equal(f.error?.code,'LIFECYCLE_OPERATOR_OUTCOME_UNCERTAIN');assert.equal(f.receipt,undefined);assert.equal(f.durable.resumes.length,0);assert(!f.trace.some(q=>q.startsWith('SELECT current_user')));});

test('commissioner actual entry rejects wrong bypass state or public application access before authority writes',async()=>{for(const flags of [{commissionNoBypass:true},{commissionPublicExtra:true}]){const f=await run('commission',{fresh:true,...flags});assert.ifError(f.error);assert.equal(f.receipt.outcome,'REFUSED');assert.equal(f.setupRows.length,0);assert(!f.trace.includes('COMMIT'));}});

test('actual capture same-client preflight refuses oversized/unknown type before core row materialization, rolls back and retires cleanly',async()=>{for(const flags of [{captureOversized:true},{captureUnsupported:true}]){const f=await run('capture',{fresh:true,...flags});assert.ifError(f.error);assert.equal(f.receipt.outcome,'REFUSED');assert.equal(f.receipt.result.error,flags.captureOversized?'LIFECYCLE_ARTIFACT_BOUND':'LIFECYCLE_CAPTURE_TYPE_UNBOUNDED');assert.equal(f.instances.length,1);assert(f.trace.includes('BEGIN ISOLATION LEVEL REPEATABLE READ'));assert(f.trace.includes('ROLLBACK'));assert(!f.trace.includes('COMMIT'));assert(!f.trace.some(t=>t.includes('reviewed-relation-inventory')));assert(f.trace.includes('Terminate'));}});

test('actual admitted core-export preflight ablation fails oversized refusal oracle; restored one-backend source refuses',async()=>{const from="    if(capture){await require('./lifecycle-capture-preflight').run(query,capture,id);active();}",source=fs.readFileSync(require.resolve('../lifecycle-snapshot'),'utf8');assert(source.includes(from));const mutant=await run('capture',{fresh:true,captureOversized:true,snapshotTransform:s=>s.replace(from,'')});assert.ifError(mutant.error);assert.equal(mutant.receipt.outcome,'COMPLETED');assert.throws(()=>assert.equal(mutant.receipt.outcome,'REFUSED'));const restored=await run('capture',{fresh:true,captureOversized:true});assert.ifError(restored.error);assert.equal(restored.receipt.outcome,'REFUSED');assert.equal(restored.receipt.result.error,'LIFECYCLE_ARTIFACT_BOUND');assert.equal(restored.instances.length,1);});
