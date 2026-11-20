'use strict';
// Vault infrastructure written by the registry bootstrap (decision deployment-signing-secret).
// Synthetic values only; a recorded fake request function, no Vault.
const test = require('node:test');
const assert = require('node:assert');
const { finish } = require('../registry-bootstrap');

const layout = { prefix: 'synthetic', mount: 'synthetic_transit' };
const tokens = { api: '1'.repeat(64), 'owner-credentials': '2'.repeat(64), provisioner: '3'.repeat(64) };
const signing = 'a'.repeat(64);
async function run (input = {}) {
  const calls = [];
  const request = async (resource, body) => { calls.push({ resource, body }); return {}; };
  await finish({ request, rootToken: 'synthetic-root', layout, tokens, signing, ...input });
  return calls;
}

test('policies hold only the data key; no Transit sign, HMAC or verify capability', async () => {
  const calls = await run();
  const policies = Object.fromEntries(calls.filter(c => c.resource.startsWith('sys/policies/acl/')).map(c => [c.resource.split('/').pop(), c.body.policy]));
  assert.deepStrictEqual(Object.keys(policies).sort(), ['synthetic_api', 'synthetic_owner-credentials', 'synthetic_provisioner']);
  for (const policy of Object.values(policies)) {
    assert.doesNotMatch(policy, /hmac\/|verify\/|sign\/|tenant-signing|tenant-access|tenant-management|tenant-human/);
    assert.doesNotMatch(policy, /tenant-\*/);
  }
  assert.match(policies.synthetic_provisioner, /keys\/tenant-data-\*/);
  assert.equal(calls.filter(c => c.resource === 'auth/token/create').length, 3);
});

test('the deployment signing secret is written once to the KV path the Agent template reads', async () => {
  const calls = await run();
  assert.deepStrictEqual(calls.find(c => c.resource === 'sys/mounts/synthetic_kv').body, { type: 'kv', options: { version: '2' } });
  assert.deepStrictEqual(calls.find(c => c.resource === 'synthetic_kv/data/signing').body, { data: { secret: signing } });
  await assert.rejects(run({ signing: 'short' }), { code: 'BOOTSTRAP_SIGNING_SECRET_INVALID' });
});
