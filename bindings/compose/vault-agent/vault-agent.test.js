'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const bootstrap = require('./vault-agent-bootstrap'), launch = require('./launch');
const sourceCommit = 'a'.repeat(40), deployCommit = 'b'.repeat(40);
function fixture (replicas = 1, mode = 'registry', tenants = 2) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-agent-test-'));
  const write = (file, value) => { const target = path.join(output, file); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, JSON.stringify(value) + '\n', { mode: 0o600 }); };
  const names = bootstrap.apiNames(replicas);
  write('bootstrap/complete.json', { version: 2, sourceCommit, deployCommit, ...(mode === 'registry' ? { registryMode: true } : {}) });
  write('bootstrap/layout.json', { mount: 'synthetic_transit', prefix: 'synthetic' });
  write('bootstrap/vault-init.json', { root_token: 'synthetic-fixture-only' });
  for (const name of names) fs.mkdirSync(path.join(output,name),{mode:0o700});
  const options = { output, sourceCommit, deployCommit, vault: new URL('https://vault:8200'), ttl: '10s', maxTtl: '30s', replicas, project: 'owned-agent-fixture', keepEnvTokens: false, validateApi: () => {} };
  return { output, options, write, read: file => JSON.parse(fs.readFileSync(path.join(output, file), 'utf8')), close: () => fs.rmSync(output, { recursive: true, force: true }) };
}
function vault () {
  const original = global.fetch, calls = [];
  global.fetch = async (url, options) => {
    const resource = new URL(url).pathname.slice(4); calls.push({ resource, method: options.method, ...(options.body ? { body: JSON.parse(options.body) } : {}) });
    const data = resource === 'sys/auth' ? {} : resource.endsWith('/role-id') ? { data: { role_id: 'synthetic-role-material' } } : resource.endsWith('/secret-id') ? { data: { secret_id: 'synthetic-secret-material' } } : null;
    return data ? new Response(JSON.stringify(data), { status: 200 }) : new Response(null, { status: 204 });
  };
  return { calls, close: () => { global.fetch = original; } };
}
test('registry1/2/4 API instances all use sink; one fixed policy/AppRole, no tenant-policy reads; repeated state is read-only', async () => {
  for (const replicas of [1, 2, 4]) {
    const f = fixture(replicas), v = vault();
    try {
      const before = fs.readdirSync(f.output).sort(); await bootstrap.run('plan', f.options); assert.deepEqual(fs.readdirSync(f.output).sort(), before); assert.equal(v.calls.length, 0);
      assert.equal((await bootstrap.run('provision', f.options)).state, 'vault-agent-provisioned');
      for (const name of bootstrap.apiNames(replicas)) assert.deepEqual(fs.readdirSync(path.join(f.output,name)), []);
      assert.equal(v.calls.filter(row => row.resource.startsWith('sys/policies/')).length, 1);
      assert.equal(v.calls.filter(row => /auth\/approle\/role\/[^/]+$/.test(row.resource)).length, 1);
      const machineRole = v.calls.find(row => /auth\/approle\/role\/[^/]+$/.test(row.resource)).body;
      assert.equal(machineRole.secret_id_ttl, 0); assert.equal(machineRole.secret_id_num_uses, 0);
      assert.equal(machineRole.token_ttl, '10s'); assert.equal(machineRole.token_max_ttl, '30s');
      assert.equal(v.calls.some(row => /tenant|lease/.test(row.resource)), false);
      const calls = v.calls.length; assert.equal((await bootstrap.run('provision', f.options)).state, 'existing-vault-agent-provisioned'); assert.equal(v.calls.length, calls);
      fs.unlinkSync(path.join(f.output, 'vault-agent/creds/secret_id')); await bootstrap.run('secret-id', f.options);
      assert.equal(fs.statSync(path.join(f.output, 'vault-agent/creds/secret_id')).mode & 0o777, 0o600);
    } finally { v.close(); f.close(); }
  }
});
test('bootstrap rejects changed credentials and partially provisioned Vault state', async () => {
  const f=fixture(),v=vault();
  try {
    await bootstrap.run('provision',f.options);
    const count=v.calls.length;
    f.write('vault-agent/creds/role_id','different-credential');
    await assert.rejects(bootstrap.run('provision',f.options),{code:'VAULT_AGENT_STATE_CHANGED'});
    assert.equal(v.calls.length,count);
  } finally {v.close();f.close();}
});
test('role policy permits serving operations only; identity includes exact fixed roster; no key management', () => {
  const registry = bootstrap.policyRules({ mount: 'synthetic_transit', prefix: 'synthetic' }, 'registry');
  assert.equal(registry.split('\n').length, 3); assert.ok(registry.includes('decrypt/tenant-data-*'));
  // Signing is in process from the deployment signing secret (decision deployment-signing-secret).
  assert.equal(/keys\/|management|encrypt\/|create|delete|list|hmac\/|verify\/|sign\/|tenant-signing|tenant-access/.test(registry), false);
  assert.throws(() => bootstrap.policyRules({ mount: '../bad', prefix: 'synthetic' }, 'registry'));
  assert.throws(() => bootstrap.apiNames(0)); assert.throws(() => bootstrap.apiNames(17));
});
test('shipping plan starts serving workers before the independent lab client', () => {
  const selected = { base: '/synthetic/core/deploy/multitenant', project: 'synthetic-agent', envFile: '/synthetic/.env', files: ['base.yaml'], stdin: 'services: {}',
    apis: ['api', 'api-2', 'api-3', 'api-4'], realtime: ['realtime', 'realtime-2', 'socket-edge'], evaluators: ['evaluator', 'evaluator-2'], state: '/synthetic/state' };
  const steps = launch.commands(selected, 'up').map(row => row.args.join(' '));
  assert.ok(steps[1].endsWith('run --rm bootstrap'));
  assert.ok(!steps.some(step => step.includes('platform-verify.js')));
  assert.ok(steps[4].endsWith('vault-agent'));
  assert.ok(steps[5].endsWith('api api-2 api-3 api-4 realtime realtime-2 socket-edge evaluator evaluator-2 pgstream tenant-admin ui nginx'));
  assert.equal(steps.length,6);
  const lab = launch.commands(selected, 'prime').map(row => row.args.join(' '));
  assert.ok(lab[0].includes('prime.js provision')); assert.ok(lab[1].includes('prime.js prime')); assert.ok(lab[2].includes('publish-primer.js'));
  assert.ok(!lab.some(step => step.includes('commission-restore.js')));
  const demo = launch.commands(selected, 'demo').map(row => row.args.join(' '));
  assert.ok(demo[3].includes('commission-restore.js')); assert.ok(demo[4].endsWith('run --rm --no-deps demo'));
});

test('image build and read-only commands do not create runtime ownership state', () => {
  const f = fixture();
  try {
    const selected = { sourceCommit, deployCommit, project: 'synthetic', state: f.output, base: '/synthetic/core', apis: ['api'], realtime: ['realtime'], evaluators: ['evaluator'], ttl: '10s', maxTtl: '30s', stdin: 'services: {}' };
    const before = fs.readdirSync(f.output).sort();
    for (const command of ['plan', 'config', 'status', 'build']) launch.custody(selected, command, {});
    assert.deepEqual(fs.readdirSync(f.output).sort(), before);
  } finally { f.close(); }
});
