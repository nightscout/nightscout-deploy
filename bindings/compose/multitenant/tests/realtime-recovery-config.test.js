'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Config=require('../realtime-recovery-config'),{lab}=require('./realtime-recovery-control-fixture');
function value(f){return{version:1,ownershipVersion:2,consumer:'realtime-synthetic',namespaces:{control:'synthetic_control',registry:'synthetic_registry'},plan:f.plan,roster:f.prepared,desired:f.context.desired,policy:f.context.policy,execution:{timeoutMs:10000,readinessTimeoutMs:5000,maxRegistryTenants:10}};}
test('fresh exact physical2/roster/policy config and private URI role/database are immutable metadata only',()=>{
 const f=lab();try{const raw=value(f),config=Config.normalize(raw,f.internal);raw.execution.timeoutMs=1;assert.equal(config.execution.timeoutMs,10000);assert(Object.isFrozen(config.plan));const principal=config.plan.controlRecovery.classes['realtime-recovery'].principal,env={NS_SOURCE_COMMIT:f.plan.source.coreCommit,NS_REALTIME_RECOVERY_PG:'postgres://'+principal.role+':synthetic@pg:5432/'+principal.database},copy=Config.environment(env,config);env.NS_SOURCE_COMMIT='f'.repeat(40);assert.notEqual(copy.NS_SOURCE_COMMIT,env.NS_SOURCE_COMMIT);assert(Object.isFrozen(copy));
  assert.throws(()=>Config.environment({...copy,NS_REALTIME_RECOVERY_PG:'postgres://wrong:synthetic@pg:5432/'+principal.database},config),{code:'REALTIME_RECOVERY_ENV_PRINCIPAL'});
 }finally{f.close();}
});
test('legacy conversion, namespace alias, broad timeout/work bounds, source/digest/role metadata and unknown fields refuse',()=>{
 const f=lab();try{for(const mutate of [v=>{v.plan.version=1;},v=>{v.namespaces.registry=v.namespaces.control;},v=>{v.namespaces.control='public';},v=>{v.execution.timeoutMs=900001;},v=>{v.execution.maxRegistryTenants=9;},v=>{v.plan.sha256='f'.repeat(64);},v=>{v.plan.controlRecovery.classes['realtime-recovery'].principal.roleOid=['33'];},v=>{v.execute='arbitrary';}]){const raw=structuredClone(value(f));mutate(raw);assert.throws(()=>Config.normalize(raw,f.internal));}}finally{f.close();}
});
