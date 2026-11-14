'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
test('two API/two realtime documents pass actual product parsers with exact placement and idle-worker coverage', () => {
  const core = process.env.NS_UI_TEST_CORE; assert.ok(core, 'Explicit joined source required');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(),'ns-realtime-product-plan-'));
  const saved = process.env.NS_API_REPLICAS; process.env.NS_API_REPLICAS = '2';
  try {
    for (const name of ['lib','migrations','node_modules']) fs.symlinkSync(path.join(core,name),path.join(scratch,name),'dir');
    const binding = path.join(scratch,'deploy/multitenant'); fs.mkdirSync(binding,{recursive:true});
    for (const name of ['config.js','registry-plan.js','replicas.js','realtime-workers.js','evaluator-workers.js','pgstream.js','ui.js','ui-registry.js']) fs.copyFileSync(path.join(__dirname,name),path.join(binding,name));
    const plan = require(path.join(binding,'config')), workers = require(path.join(binding,'realtime-workers'));
    const layout = plan.layout(), map = workers.initial({ workers: 2, shards: 8 });
    const urls = Object.fromEntries(Object.keys(layout.roles).map(name => [name,'postgres://' + layout.roles[name] + ':synthetic@postgres/nightscout_compose_test']));
    const docs = plan.documents({ layout,urls,tokens:[],publicKeys:[],managementKeys:[],vaultAddress:'https://vault:8200',registryMode:true,realtimePlacement:map });
    const state = path.join(scratch,'state'); fs.mkdirSync(path.join(state,'placement'),{recursive:true});
    for (const name of ['backend','routes']) fs.writeFileSync(path.join(state,'placement',name+'.json'),JSON.stringify(map),{mode:0o600});
    for (const role of Object.keys(docs.configs)) {
      const own = path.join(state,role); fs.mkdirSync(own);
      for (const [name,value] of Object.entries({ 'config.json':docs.configs[role], 'operation.json':docs.operations[role], 'evaluator-metadata.json':docs.configs.evaluator })) fs.writeFileSync(path.join(own,name),JSON.stringify(value),{mode:0o600});
    }
    plan.validateFiles(state,docs);
    assert.equal(docs.configs.realtime.consumer,docs.configs['realtime-2'].consumer);
    const peer = docs.operations.api.participants.find(row => row.worker === 'realtime-2');
    const original = peer.worker; peer.worker = 'missing-worker';
    for (const role of Object.keys(docs.configs)) fs.writeFileSync(path.join(state,role,'operation.json'),JSON.stringify(docs.operations[role]),{mode:0o600});
    assert.throws(() => plan.validateFiles(state,docs));
    peer.worker = original;
    for (const role of Object.keys(docs.configs)) fs.writeFileSync(path.join(state,role,'operation.json'),JSON.stringify(docs.operations[role]),{mode:0o600});
    plan.validateFiles(state,docs);
  } finally { if (saved === undefined) delete process.env.NS_API_REPLICAS; else process.env.NS_API_REPLICAS = saved; fs.rmSync(scratch,{recursive:true,force:true}); }
});
