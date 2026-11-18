'use strict';
const assert=require('node:assert/strict');
const helper=require('../../../tests/fixtures/lifecycle-domain-profile');
const {A,B}=helper,C='33333333-3333-4333-8333-333333333333';
describe('Compose restore generation domain',function(){
 it('canonical operator strict parser returns a safe profile and preserves unselected config',()=>{const bridge=require('../restore'),p=helper.profile(),value={version:1,tenants:[{id:A,host:'a.example.test',tokenEnv:'A_TOKEN'},{id:B,host:'b.example.test',tokenEnv:'B_TOKEN'}],apiOrigin:'http://api:1337',control:{namespace:'synthetic_window',locks:[{tenant:A,key:'17'},{tenant:B,key:'19'}],participants:[{}]},namespaces:{entries:'synthetic_entries'},catalogues:[{kind:'entries',candidate:{}}],drainTimeoutMs:100},env={A_TOKEN:'synthetic',B_TOKEN:'synthetic',NS_OPERATOR_PG:'postgresql://synthetic:synthetic@127.0.0.1/disposable_test',NS_SOURCE_COMMIT:'a'.repeat(40)};assert.deepEqual(bridge.validateConfig(value,env),value);const result=bridge.validateConfig({...value,intakeProfile:{...p,assignment:{owner:()=>0}}},env);assert.equal(result.intakeProfile.digest,p.digest);assert.throws(()=>result.intakeProfile.assignment.owner(C));assert.throws(()=>bridge.validateConfig({...value,intakeProfile:helper.profile({lifecycleNamespace:'other_window'})},env),{code:'COMPOSE_OPERATOR_CONFIG_REFUSED'});assert.throws(()=>bridge.validateConfig({...value,maximum:'9223372036854775807'},env),{code:'COMPOSE_OPERATOR_CONFIG_REFUSED'});});
});

it('refuses selected restore without an independently verified evaluator contract',()=>{
 const bridge=require('../restore');
 assert.throws(()=>bridge.selectionOptions({intakeProfile:helper.profile()}),{code:'COMPOSE_OPERATOR_SELECTION_UNVERIFIED'});
});
