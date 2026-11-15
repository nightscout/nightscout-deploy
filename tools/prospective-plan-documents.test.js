'use strict';
// Runs overlaid on core (tools/compose-overlay.sh), like the other plan tests here:
//   node --test deploy/multitenant/plan-documents.test.js
// The acceptance of these documents by core is tools/plan-contract-check.sh; this file holds the
// shape of what is handed over.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { documentSet, generated } = require('./prospective-plan-documents');

function withEnv (values, run) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return run(); } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test('one entry per role process, with the files its environment names and no credential outside the environment', () => {
  const set = documentSet(generated());
  assert.equal(set.contract, 1);
  assert.deepEqual(set.processes.map(entry => entry.name), ['api', 'realtime', 'evaluator', 'tenant-admin', 'admin']);
  for (const entry of set.processes) {
    const named = Object.values(entry.environment).filter(value => Object.hasOwn(entry.files, value));
    assert(named.length >= 1, entry.name);
    assert.equal(JSON.stringify(entry.files).includes('placeholder@'), false, entry.name);
    assert.equal(Object.hasOwn(entry.environment, 'MULTITENANT_STATIC_TENANTS'), false, entry.name);
  }
  const api = set.processes[0];
  assert.deepEqual(Object.keys(api.files).sort(), ['/run/ns-config/config.json', '/run/ns-config/evaluator-metadata.json', '/run/ns-config/operation.json']);
  assert.equal(api.environment.MULTITENANT_EVALUATOR_CONFIG, '/run/ns-config/evaluator-metadata.json');
});

test('replicas and evaluator workers are their own entries under the product role', () => {
  const set = withEnv({ NS_API_REPLICAS: '2', NS_EVALUATOR_WORKERS: '2' }, () => documentSet(generated()));
  assert.deepEqual(set.processes.map(entry => entry.name + ':' + entry.roles.join(',')),
    ['api:api', 'realtime:realtime', 'evaluator:evaluator', 'tenant-admin:tenant-admin', 'api-2:api', 'evaluator-2:evaluator', 'admin:admin']);
});

test('control: a selected realtime placement is refused, not silently left out', () => {
  assert.throws(() => withEnv({ NS_REALTIME_WORKERS: '2', NS_REALTIME_SHARDS: '8' }, () => generated()), /PLAN_DOCUMENTS_PLACEMENT_UNSUPPORTED/);
  assert.throws(() => documentSet({ ...generated(), realtimePlacement: { workers: [] } }), /PLAN_DOCUMENTS_PLACEMENT_UNSUPPORTED/);
});
