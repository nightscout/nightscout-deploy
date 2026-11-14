'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const plan = require('./config');
const replicas = require('./replicas');
function base() {
  const layout = plan.layout();
  const urls = Object.fromEntries(Object.keys(layout.roles).map(kind => [kind, 'postgres://' + layout.roles[kind] + ':' + crypto.randomBytes(16).toString('hex') + '@postgres/nightscout_compose_test']));
  const keys = () => [plan.A, plan.B].map(tenant => ({ tenant, kid: 'key1', publicKey: Buffer.from(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64') }));
  return plan.documents({ layout, urls, tokens: [crypto.randomBytes(16).toString('hex'), crypto.randomBytes(16).toString('hex')], publicKeys: keys(), managementKeys: keys(), vaultAddress: 'https://vault:8200' });
}
function files(docs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-replica-docs-'));
  for (const role of Object.keys(docs.configs)) {
    const own = path.join(dir, role); fs.mkdirSync(own);
    const bundle = { 'config.json': docs.configs[role], 'operation.json': docs.operations[role], ...((role === 'api' || role.startsWith('api-')) ? { 'evaluator-metadata.json': docs.configs.evaluator } : {}) };
    for (const [name, value] of Object.entries(bundle)) fs.writeFileSync(path.join(own, name), JSON.stringify(value));
  }
  return dir;
}
test('equal API replicas pass real product parsers with exact instance roster and separate service routing', () => {
  const docs = replicas.expand(base(), 2), dir = files(docs);
  try {
    plan.validateFiles(dir, docs);
    assert.deepEqual(docs.configs.api, docs.configs['api-2']);
    assert.equal(docs.environments.realtime.NS_API_INTERNAL_URL, replicas.service);
    assert.deepEqual(docs.operations.api.participants.filter(row => row.roles.includes('api')).map(row => row.id), ['api-1', 'api-2']);
    assert.deepEqual(docs.remote.filter(row => row.roles.includes('api')).map(row => row.endpoint.url), ['http://api:7001/', 'http://api-2:7001/']);
    assert.equal(docs.operations['api-2'].participantId, 'api-2');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('control: a service-aliased maintenance instance refuses; restored exact instance passes', () => {
  const docs = replicas.expand(base(), 2);
  const row = docs.operations.realtime.participants.find(row => row.id === 'api-2');
  const original = row.address; row.address = { url: replicas.service };
  let dir = files(docs);
  try { assert.throws(() => plan.validateFiles(dir, docs), /invalid explicit tenant operation configuration/); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  row.address = original; dir = files(docs);
  try { plan.validateFiles(dir, docs); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('replica count is bounded synthetic deployment input and default placement stays singular', () => {
  assert.equal(replicas.count({}), 1);
  for (const raw of ['0', '17', '2.5', 'x']) assert.throws(() => replicas.count({ NS_API_REPLICAS: raw }));
  assert.equal(replicas.count({ NS_API_REPLICAS: '2' }), 2);
  assert.equal(replicas.compose(1), '# Generated fixed-roster API placement.\nservices:\n  api: {}\n');
  assert.match(replicas.compose(2), /api-2:/);
  assert.match(replicas.compose(2), /aliases: \[api-internal\]/);
});
