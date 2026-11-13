'use strict';
// Run against a prepared joined source tree, never a substituted core module.
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module');
const source={coreCommit:'074eab44ee75b9175c951b6a8add3df3e9554af7',deployCommit:'b'.repeat(40)};
const B=require('../connection-budget'),P=require('../connection-budget-profile'),poolConfig=require('../../../lib/server/serve/pool-config');
const {input}=require('./connection-budget-source-fixture');
test('actual expanded source configuration derives all role limits and fixed/direct/headroom; no PG constructed',()=>{
 const keys=['NS_API_REPLICAS','NS_REALTIME_WORKERS','NS_REALTIME_SHARDS','NS_EVALUATOR_WORKERS'],before=Object.fromEntries(keys.map(k=>[k,process.env[k]])),load=Module._load;let constructed=0;
 Module._load=function(name,...args){if(name==='pg')return{Client:class{constructor(){constructed++;throw Error('PG forbidden in preparation');}},Pool:class{constructor(){constructed++;throw Error('PG forbidden in preparation');}}};return load.call(this,name,...args);};
 try{Object.assign(process.env,{NS_API_REPLICAS:'2',NS_REALTIME_WORKERS:'2',NS_REALTIME_SHARDS:'4',NS_EVALUATOR_WORKERS:'3'});
 const docs=P.sourceDocuments(),profile=input(docs),resolved=P.resolve(profile,{source});
 assert.deepEqual(resolved.slots.sort(),['admin','api','api-2','evaluator','evaluator-2','evaluator-3','feed-reader','realtime','realtime-2','socket-edge','tenant-admin','ui']);
 assert(resolved.requiredMaximum>100);assert.equal(resolved.profile.resource.serverMaximum,resolved.requiredMaximum);assert.equal(constructed,0);
 const low=structuredClone(profile);low.resource.serverMaximum=100;assert.throws(()=>P.resolve(low,{source}),/OVERCOMMITTED/);
 const omitted=structuredClone(profile);delete omitted.slots.find(x=>x.processInstanceId==='evaluator-3').capabilities['settings-readiness'];assert.throws(()=>P.resolve(omitted,{source}),/CONSTRUCTOR_COVERAGE/);
 const render=require('../connection-budget-compose').render({state:'/private/synthetic',services:resolved.slots,serverMaximum:resolved.requiredMaximum});const yaml=require('js-yaml').load(render);assert.equal(Object.keys(yaml.services).filter(s=>resolved.slots.includes(s)).length,resolved.slots.length);assert.equal(yaml.services.demo.environment.NS_CONNECTION_BUDGET_UNPLANNED_PROCESS,'1');assert(render.includes('max_connections='+resolved.requiredMaximum));assert.deepEqual(yaml.services.postgres.healthcheck.test,['CMD','/usr/local/bin/gosu','postgres','/bin/sh','/run/ns-budget-health/postgres-ready.sh']);assert(render.includes('socket-edge/claims:/run/ns-budget-claims:rw'));assert(yaml.services.bootstrap.volumes.includes('/private/synthetic/connection-budget:/run/ns-budget-profile:ro'));for(const slot of resolved.slots){assert(yaml.services[slot].volumes.includes('/private/synthetic/connection-budget/plan-view:/run/ns-budget-plan:ro'));assert(!yaml.services[slot].volumes.includes('/private/synthetic/connection-budget:/run/ns-budget-plan:ro'));}
 }finally{Module._load=load;for(const k of keys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}}
});
