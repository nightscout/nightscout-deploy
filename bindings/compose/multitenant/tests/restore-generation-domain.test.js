'use strict';
const assert=require('node:assert/strict');
const helper=require('../../../tests/fixtures/lifecycle-domain-profile');
const {A,B}=helper,C='33333333-3333-4333-8333-333333333333';
describe('Compose restore generation domain',function(){
 it('canonical operator strict parser returns a safe profile and preserves unselected config',()=>{const bridge=require('../restore'),p=helper.profile(),value={version:1,tenants:[{id:A,host:'a.example.test',tokenEnv:'A_TOKEN'},{id:B,host:'b.example.test',tokenEnv:'B_TOKEN'}],apiOrigin:'http://api:1337',control:{namespace:'synthetic_window',locks:[{tenant:A,key:'17'},{tenant:B,key:'19'}],participants:[{}]},namespaces:{entries:'synthetic_entries'},catalogues:[{kind:'entries',candidate:{}}],drainTimeoutMs:100},env={A_TOKEN:'synthetic',B_TOKEN:'synthetic',NS_OPERATOR_PG:'postgresql://synthetic:synthetic@127.0.0.1/disposable_test',NS_SOURCE_COMMIT:'a'.repeat(40)};assert.deepEqual(bridge.validateConfig(value,env),value);const result=bridge.validateConfig({...value,intakeProfile:{...p,assignment:{owner:()=>0}}},env);assert.equal(result.intakeProfile.digest,p.digest);assert.throws(()=>result.intakeProfile.assignment.owner(C));assert.throws(()=>bridge.validateConfig({...value,intakeProfile:helper.profile({lifecycleNamespace:'other_window'})},env),{code:'COMPOSE_OPERATOR_CONFIG_REFUSED'});assert.throws(()=>bridge.validateConfig({...value,maximum:'9223372036854775807'},env),{code:'COMPOSE_OPERATOR_CONFIG_REFUSED'});});
});

it('actual restore and recovery propagate the regenerated profile; removal control fails', async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),file=require.resolve('../restore'),source=fs.readFileSync(file,'utf8');
 async function exercise(text){
  const profile=helper.profile(),seen=[],closed=[];
  const config={tenants:[{id:A},{id:B}],control:{namespace:'synthetic_window',locks:[],participants:[]},catalogues:[],namespaces:{},drainTimeoutMs:100,intakeProfile:profile};
  const cohort={close:async()=>closed.push('cohort')};
  const ports={
   './config':{layout:()=>({}),lifecycle:()=>({catalogues:[]})},
   '../../lib/storage/tenant-scope':{setTenancyMode:()=>{}},
   '../../lib/tenant-lifecycle':{createLifecycle:()=>({restoreLogical:async(connection,artifact,options)=>{await options.onCommitted({});return{restored:true};}})},
   '../../lib/server/serve/operation-cohort':{createRemote:async options=>{assert.equal(options.intakeProfile,profile);seen.push('cohort');return cohort;}},
   '../../lib/tenant-lifecycle/maintenance-window':{create:options=>{assert.equal(options.intakeProfile,profile);seen.push('maintenance');return{withRestore:async(tenant,metadata,work)=>work({connection:{},maintenanceClaim:{}})};}},
   pg:{Pool:class{async end(){closed.push('pool');}}}
  };
  const module={exports:{}},loader=id=>Object.hasOwn(ports,id)?ports[id]:require(id);
  vm.runInNewContext(text,{module,exports:module.exports,require:loader,process,Buffer,URL,Object,structuredClone,__dirname:require('node:path').dirname(file)},{filename:file});
  await module.exports.ready(config);
  const recovery=await module.exports.recoveryCohort(config,{});await recovery.close();
  assert.deepEqual(await module.exports.restore(config,{manifest:{tenant:A},digest:'a'.repeat(64)},{}),{restored:true});
  assert.deepEqual(seen,['cohort','cohort','cohort','maintenance']);
  assert.equal(closed.filter(value=>value==='pool').length,1);
 }
 await exercise(source);
 const broken=source.replaceAll('intakeProfile: config.intakeProfile','intakeProfile: undefined').replaceAll('intakeProfile:config.intakeProfile','intakeProfile:undefined');
 assert.notEqual(broken,source);
 await assert.rejects(exercise(broken),{code:'ERR_ASSERTION'});
 await exercise(source);
});
