'use strict';

// Offline test of ops/vault-kubernetes-auth.js against a recorded fake Vault (global fetch).
// Synthetic state only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { input, provision } = require('../ops/vault-kubernetes-auth');

function state () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-k8s-auth-'));
  const put = (file, value) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(dir, file), JSON.stringify(value), { mode: 0o600 }); };
  put('bootstrap/complete.json', { version: 1 });
  put('bootstrap/vault-init.json', { root_token: 'synthetic-root-token' });
  put('bootstrap/layout.json', { prefix: 'nsdemo', mount: 'nsdemo_transit' });
  put('api/config.json', { tenants: [{ id: 'a', vault: { tokenEnv: 'NS_VAULT_0' } }, { id: 'b', vault: { tokenEnv: 'NS_VAULT_1' } }] });
  put('api/env.json', { NS_VAULT_0: 'synthetic-0', NS_VAULT_1: 'synthetic-1', NS_API_PG: 'synthetic' });
  return dir;
}
function fakeVault ({ missingPolicy = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const resource = new URL(url).pathname.replace(/^\/v1\//, '');
    calls.push({ resource, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const m = /^sys\/policies\/acl\/nsdemo_tenant_(\d)$/.exec(resource);
    if (m && init.method === 'GET') {
      if (missingPolicy) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ data: { policy: 'path "nsdemo_transit/encrypt/tenant-' + m[1] + '-data" { capabilities = ["update"] }' } }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  };
  return calls;
}
const options = output => input({ NS_VAULT_K8S_AUTH: '1', NS_BOOTSTRAP_OUTPUT: output, NS_VAULT_K8S_NAMESPACE: 'nightscout-preview',
  NS_VAULT_K8S_SERVICE_ACCOUNT: 'ns-cohort', NS_VAULT_K8S_AUDIENCE: 'vault', VAULT_ADDR: 'https://vault:8200' });

test('binds the deployment role to the cohort service account and moves api to the sink', async () => {
  const dir = state(), calls = fakeVault();
  const result = await provision(options(dir));
  assert.strictEqual(result.method, 'kubernetes');
  assert.ok(!calls.some(c => /approle/.test(c.resource)), 'no AppRole material');
  assert.deepStrictEqual(calls.find(c => c.resource === 'sys/auth/kubernetes').body, { type: 'kubernetes' });
  const role = calls.find(c => c.resource === 'auth/kubernetes/role/nsdemo_vault_agent').body;
  assert.deepStrictEqual([role.bound_service_account_names, role.bound_service_account_namespaces, role.audience, role.token_policies],
    [['ns-cohort'], ['nightscout-preview'], 'vault', ['nsdemo_vault_agent']]);
  const policy = calls.find(c => c.resource === 'sys/policies/acl/nsdemo_vault_agent').body.policy;
  assert.match(policy, /tenant-0-data/); assert.match(policy, /tenant-1-data/); assert.match(policy, /renew-self/);
  const api = JSON.parse(fs.readFileSync(path.join(dir, 'api/config.json'), 'utf8'));
  assert.deepStrictEqual(api.tenants.map(t => t.vault), [{ tokenFile: '/run/ns-vault/token' }, { tokenFile: '/run/ns-vault/token' }]);
  const env = JSON.parse(fs.readFileSync(path.join(dir, 'api/env.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(env), ['NS_API_PG'], 'environment tokens dropped');
  for (const f of ['api/config.json', 'api/env.json', 'vault-agent/complete.json']) assert.strictEqual(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
  assert.deepStrictEqual(await provision(options(dir)), { state: 'existing-vault-agent-provisioned' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing tenant policy refuses before any auth change', async () => {
  const dir = state(), calls = fakeVault({ missingPolicy: true });
  await assert.rejects(provision(options(dir)), { code: 'VAULT_K8S_AUTH_VAULT_REFUSED' });
  assert.ok(!calls.some(c => c.resource.startsWith('sys/auth') || c.resource.startsWith('auth/')));
  assert.ok(!fs.existsSync(path.join(dir, 'vault-agent/complete.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('input refuses plain http and a bad service-account name', () => {
  assert.throws(() => input({ NS_VAULT_K8S_AUTH: '1', NS_BOOTSTRAP_OUTPUT: '/state', NS_VAULT_K8S_NAMESPACE: 'n', NS_VAULT_K8S_SERVICE_ACCOUNT: 's', VAULT_ADDR: 'http://vault:8200' }), { code: 'BOOTSTRAP_VAULT_HTTPS_REQUIRED' });
  assert.throws(() => input({ NS_VAULT_K8S_AUTH: '1', NS_BOOTSTRAP_OUTPUT: '/state', NS_VAULT_K8S_NAMESPACE: 'n', NS_VAULT_K8S_SERVICE_ACCOUNT: 'Bad_Name' }), { code: 'VAULT_K8S_BINDING_INVALID' });
});
