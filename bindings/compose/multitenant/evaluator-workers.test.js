'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const workers = require('./evaluator-workers'), plan = require('./config');
function selected(fn) {
  const before = process.env.NS_EVALUATOR_WORKERS;
  process.env.NS_EVALUATOR_WORKERS = '3';
  try { return fn(); } finally { if(before===undefined)delete process.env.NS_EVALUATOR_WORKERS;else process.env.NS_EVALUATOR_WORKERS=before; }
}
function generated() {
  const layout = plan.layout(), urls = Object.fromEntries(Object.keys(layout.roles).map(kind => [kind, 'postgres://' + layout.roles[kind] + ':' + crypto.randomBytes(20).toString('hex') + '@postgres/nightscout_compose_test']));
  return { layout, urls, docs: plan.documents({ layout, urls, tokens: [], publicKeys: [], managementKeys: [], vaultAddress: 'https://vault:8200', registryMode: true }) };
}
test('fixed evaluator pool is opt-in and strictly bounded independently of other roles',()=>{
  assert.equal(workers.selection({}),null);
  for(const raw of ['0','17','2x','',2])assert.throws(()=>workers.selection({NS_EVALUATOR_WORKERS:raw}));
  assert.deepEqual(workers.services(workers.selection({NS_EVALUATOR_WORKERS:'3'})),['evaluator','evaluator-2','evaluator-3']);
});
test('maintained pgstream deployment explicitly refuses a partitioned evaluator before runtime files or database work',()=>selected(()=>{
  assert.throws(()=>generated(),/PGSTREAM_EVALUATOR_PARTITION_UNQUALIFIED/);
}));
test('pure evaluator roster planning retains idle members, exact private instances and distinct operator capability',()=>{
  const {layout,urls,docs}=generated();
  layout.namespaces.pool='synthetic_pool';
  urls.pool_member='postgres://synthetic_member:synthetic@postgres/nightscout_compose_test';
  urls.pool_operator='postgres://synthetic_operator:synthetic@postgres/nightscout_compose_test';
  // Explicit metadata planner only. This output is not an admitted product
  // configuration: maintained deployment rejects partition selection above.
  const expanded=workers.expand(docs,{layout,urls},{workers:3});
  assert.deepEqual(workers.services(expanded.evaluatorPool),['evaluator','evaluator-2','evaluator-3']);
  assert.deepEqual(expanded.operations.api.participants.filter(row=>row.roles.includes('evaluator')).map(row=>row.id),['evaluator-1','evaluator-2','evaluator-3']);
  assert.deepEqual(expanded.remote.filter(row=>row.roles.includes('evaluator')).map(row=>row.endpoint.socketPath),['/run/ns-ipc/evaluator-1.sock','/run/ns-ipc/evaluator-2.sock','/run/ns-ipc/evaluator-3.sock']);
  assert.deepEqual(workers.services(expanded.evaluatorPool).map(role=>expanded.environments[role].MULTITENANT_POOL_EVALUATOR_ORDINAL),['0','1','2']);
  assert.deepEqual(expanded.admin.config.pools.kinds,['evaluator']);assert.equal(expanded.admin.environment.NS_POOL_OPERATOR_PG,urls.pool_operator);
  for(const role of workers.services(expanded.evaluatorPool)){
    assert.equal(expanded.environments[role].MULTITENANT_POOL_EVALUATOR_DATABASE_URL,urls.pool_member);
    assert.notEqual(expanded.environments[role].MULTITENANT_POOL_EVALUATOR_DATABASE_URL,urls.pool_operator);
    assert(expanded.operations[role].participants.find(peer=>peer.id===expanded.operations[role].participantId).namespaces.includes('synthetic_pool'));
  }
});
test('operator uses existing private protocol, refuses implicit resize and count outside fixed roster',async()=>{
  const {configure}=require('./evaluator-pool');let desired=null,calls=0;
  const client={async getPool(){return {desired};},async setPoolMembers(body){calls++;desired={members:body.members};return {outcome:'applied',desired};}};
  const config={evaluatorPool:{workers:3}};
  assert.equal((await configure(config,'initialize',undefined,client)).outcome,'applied');
  await configure(config,'initialize',undefined,client);assert.equal(calls,1);
  await configure(config,'set','2',client);
  await assert.rejects(configure(config,'initialize',undefined,client),{code:'EVALUATOR_POOL_ALREADY_CONFIGURED'});
  await assert.rejects(configure(config,'set','4',client),{code:'EVALUATOR_POOL_MEMBERS_OUTSIDE_ROSTER'});
  assert.equal(calls,2);
});
