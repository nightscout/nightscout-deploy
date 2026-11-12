'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const workers = require('./evaluator-workers'), plan = require('./config');
function selected(fn) {
  const before = process.env.NS_EVALUATOR_WORKERS;
  process.env.NS_EVALUATOR_WORKERS = '3';
  try { return fn(); } finally { if(before===undefined)delete process.env.NS_EVALUATOR_WORKERS;else process.env.NS_EVALUATOR_WORKERS=before; }
}
function generated() {
  const layout = plan.layout(), urls = Object.fromEntries(Object.keys(layout.roles).map(kind => [kind, 'postgres://' + layout.roles[kind] + ':' + crypto.randomBytes(20).toString('hex') + '@postgres/nightscout_compose_test']));
  return { layout, docs: plan.documents({ layout, urls, tokens: [], publicKeys: [], managementKeys: [], vaultAddress: 'https://vault:8200', registryMode: true }) };
}
function validate(docs) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ns-evaluator-binding-'));
  try {
    for(const [role,config] of Object.entries(docs.configs)){
      const own=path.join(dir,role);fs.mkdirSync(own);
      for(const [name,value]of Object.entries({'config.json':config,'operation.json':docs.operations[role],'evaluator-metadata.json':docs.configs.evaluator}))fs.writeFileSync(path.join(own,name),JSON.stringify(value));
    }
    plan.validateFiles(dir,docs);
    require('../../lib/server/serve/admin-config').parse(docs.admin.config,docs.admin.environment);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
test('fixed evaluator pool is opt-in and strictly bounded independently of other roles',()=>{
  assert.equal(workers.selection({}),null);
  for(const raw of ['0','17','2x','',2])assert.throws(()=>workers.selection({NS_EVALUATOR_WORKERS:raw}));
  assert.deepEqual(workers.services(workers.selection({NS_EVALUATOR_WORKERS:'3'})),['evaluator','evaluator-2','evaluator-3']);
});
test('actual parsers accept all members, operational catalogue and narrowly separated capabilities',()=>selected(()=>{
  const {layout,docs}=generated();validate(docs);
  assert.equal(new Set(workers.services(docs.evaluatorPool).map(role=>docs.configs[role].consumer)).size,1);
  assert.deepEqual(docs.admin.config.pools.kinds,['evaluator']);
  for(const kind of ['pool_member','pool_operator']){
    const grants=plan.grants(layout).filter(sql=>sql.endsWith('TO "'+layout.roles[kind]+'"'));
    assert(grants.length>0);
    assert(grants.every(sql=>sql.includes('"'+layout.namespaces.pool+'"')),'pool identity has no serving/control capability');
  }
  assert(!Object.values(plan.lifecycle(layout).namespaces).includes(layout.namespaces.pool));
  assert.equal(docs.operations.api.participants.filter(row=>row.roles.includes('evaluator')).length,3);
}));
test('controls reject omitted idle peer and duplicate deployment ordinal then restore',()=>selected(()=>{
  const {docs}=generated();const original=docs.operations.api.participants;
  docs.operations.api.participants=original.filter(row=>row.id!=='evaluator-3');
  assert.throws(()=>validate(docs),/pool coverage mismatch/);
  docs.operations.api.participants=original;
  const participant=docs.operations.evaluator.participants.find(row=>row.id==='evaluator-1'),namespaces=participant.namespaces;
  participant.namespaces=namespaces.filter(name=>!name.endsWith('_pool'));
  assert.throws(()=>validate(docs),/namespace mismatch/);
  participant.namespaces=namespaces;
  const env=docs.environments['evaluator-2'];env.MULTITENANT_POOL_EVALUATOR_ORDINAL='0';
  assert.throws(()=>validate(docs),/ordinal mismatch/);
  env.MULTITENANT_POOL_EVALUATOR_ORDINAL='1';validate(docs);
}));
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
