'use strict';
// Source-only generated declaration/loader/grant controls. Native SQL is separate.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const plan=require('../config'),binding=require('../native-lifecycle'),native=require('../../../lib/tenant-lifecycle/native-selection');
function fixture(){const layout=plan.layout('nsnative'),urls=Object.fromEntries(Object.entries(layout.roles).map(([kind,role])=>[kind,'postgres://'+role+':synthetic@postgres:5432/nightscout_compose_test']));const docs=plan.documents({layout,urls,tokens:[],publicKeys:[],managementKeys:[],vaultAddress:'https://vault:8200',realtimeOwnership:require('../realtime-workers').initial(require('../realtime-workers').selection())});const source={system_id:'42',timeline:1,database:'nightscout_compose_test',slot:docs.configs.evaluator.pgstream.slot},selection=binding.select(layout,docs,source);binding.attach(docs,selection);return{layout,docs,selection,source};}
function criterion(implementation=binding){const f=fixture(),sql=implementation.grants(f.layout,f.selection);for(const role of ['api','evaluator','realtime','owner_writer','owner_reader','outbox','suppression','display_reader','activity_reader','owner_credentials',...plan.serviceRoles.map(role=>'lifetime_'+role.replace('-','_'))])assert(sql.some(row=>row.includes('tenant_lifecycle_recommission')&&row.endsWith('TO "'+f.layout.roles[role]+'"')),'NATIVE_SELECTED_LINK_READ_REQUIRED');assert(sql.filter(row=>row.includes('pg_control_system')).every(row=>row.endsWith('TO "'+f.layout.roles.operator+'"')));return f;}
test('generated source and actual serving generation select exact native catalogue/grants, retaining default fixture catalogue',()=>{
 const f=criterion();assert.equal(f.selection.binding.generation,f.docs.configs.evaluator.pgstream.generation);assert.equal(f.selection.binding.source.slot,f.docs.configs.evaluator.pgstream.slot);
 assert.notEqual(f.selection.binding.generation,require('../pgstream').descriptor(f.layout).pgstream.generation);
 assert.deepEqual(plan.catalogues({nativeSelection:f.selection}).control,native.catalogue(f.selection));assert.deepEqual(plan.catalogues().control,require('../../../lib/tenant-lifecycle/postgres-candidate.json'));
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-bind-docs-'));
 try{for(const [role,config]of Object.entries(f.docs.configs)){const own=path.join(directory,role);fs.mkdirSync(own);for(const [name,value]of Object.entries({'config.json':config,'operation.json':f.docs.operations[role],...((role==='api'||role.startsWith('api-'))?{'evaluator-metadata.json':f.docs.configs.evaluator}:{})}))fs.writeFileSync(path.join(own,name),JSON.stringify(value));assert.deepEqual(f.docs.operations[role].nativeSelection,f.selection.binding);assert.equal(f.docs.operations[role].participantId,role);}
 plan.validateFiles(directory,f.docs);
 const role=Object.keys(f.docs.operations).find(role=>role==='api'||role.startsWith('api-')),operation=f.docs.operations[role],operationFile=path.join(directory,role,'operation.json'),saved=structuredClone(operation);
 for(const mutate of [value=>{delete value.nativeSelection;},value=>{value.nativeSelection.generation='foreign-generation';}]){mutate(operation);fs.writeFileSync(operationFile,JSON.stringify(operation));assert.throws(()=>plan.validateFiles(directory,f.docs),/COMPOSE_NATIVE_SELECTION_MISMATCH/);Object.assign(operation,structuredClone(saved));fs.writeFileSync(operationFile,JSON.stringify(operation));plan.validateFiles(directory,f.docs);}
 const schema=require('../../../lib/server/serve/plan-contract'),validator=require('../../../lib/server/serve/plan-contract/json-schema');
 for(const operation of Object.values(f.docs.operations))assert.deepEqual(validator.validate(schema.schema('operation'),operation),[]);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('wrong private native raw shape/scope and old placement selector refuse before external effects',async()=>{
 const f=fixture(),bridge=require('../restore'),life=plan.lifecycle(f.layout),value={version:2,tenants:[plan.A,plan.B].map((id,i)=>({id,host:plan.tenantAlias(i),tokenEnv:'TOKEN_'+i})),apiOrigin:'http://api:1337',control:{namespace:f.layout.namespaces.control,locks:f.docs.locks,participants:f.docs.remote},...life,drainTimeoutMs:1000,nativeSelection:structuredClone(f.selection.binding)},env={TOKEN_0:'synthetic',TOKEN_1:'synthetic',NS_OPERATOR_PG:'postgres://operator:synthetic@postgres/nightscout_compose_test',NS_SOURCE_COMMIT:'a'.repeat(40)};
 const good=bridge.validateConfig(value,env);assert(native.isNative(good.nativeSelection));assert.doesNotThrow(()=>bridge.lifecycleFor(good));
 for(const mutate of [v=>{delete v.nativeSelection;},v=>{delete v.nativeSelection.source;},v=>{delete v.nativeSelection.generation;},v=>{v.nativeSelection.namespace='foreign_checkpoint';},v=>{v.nativeSelection.lifecycleNamespace='foreign_control';},v=>{v.nativeSelection.source.path='./foreign.js';},v=>{v.intakeProfile={};}]){const bad=structuredClone(value);mutate(bad);assert.throws(()=>bridge.validateConfig(bad,env),{code:'COMPOSE_OPERATOR_CONFIG_REFUSED'});}
 await assert.rejects(bridge.ready(good,{MULTITENANT_REALTIME_PLACEMENT:'/old/placement.json'}),{code:'COMPOSE_LEGACY_PLACEMENT_RETIRED'});
});
test('serving link-grant omission fails exact generated grant oracle; restored source passes',()=>{
 const file=require.resolve('../native-lifecycle'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const source=fs.readFileSync(file,'utf8'),needle='native.servingGrants({namespace:layout.namespaces.control,role})';assert.equal(source.split(needle).length,2);m._compile(source.replace(needle,'[]'),file);assert.throws(()=>criterion(m.exports),/NATIVE_SELECTED_LINK_READ_REQUIRED/);criterion();
});
test('selected static replicas share source selection while retaining each real participant and ordinal',()=>{
 const names=['NS_API_REPLICAS','NS_EVALUATOR_WORKERS','NS_REALTIME_WORKERS'],saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-bind-roster-'));
 try{
  for(const name of names)process.env[name]='2';
  const f=fixture();assert.equal(Object.keys(f.docs.configs).length,7);
  const ids=new Set();
  for(const [role,config]of Object.entries(f.docs.configs)){
   const operation=f.docs.operations[role],participant=operation.participants.find(row=>row.id===operation.participantId);assert(participant);assert(!ids.has(operation.participantId));ids.add(operation.participantId);assert.deepEqual(operation.nativeSelection,f.selection.binding);
   if(role==='realtime'||role.startsWith('realtime-'))assert.deepEqual(participant.slice,JSON.parse(f.docs.environments[role].NS_REALTIME_SLICE));
   const own=path.join(directory,role);fs.mkdirSync(own);for(const [name,value]of Object.entries({'config.json':config,'operation.json':operation,...((role==='api'||role.startsWith('api-'))?{'evaluator-metadata.json':f.docs.configs.evaluator}:{})}))fs.writeFileSync(path.join(own,name),JSON.stringify(value));
  }
  plan.validateFiles(directory,f.docs);assert.equal(ids.size,7);
 }finally{for(const name of names){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}fs.rmSync(directory,{recursive:true,force:true});}
});
