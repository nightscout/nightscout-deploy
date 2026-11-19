'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const bootstrap = require('./vault-agent-bootstrap'), launch = require('./launch');
const sourceCommit = 'a'.repeat(40), deployCommit = 'b'.repeat(40);
function fixture (replicas = 1, mode = 'registry', tenants = 2) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-agent-test-'));
  const write = (file, value) => { const target = path.join(output, file); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, JSON.stringify(value) + '\n', { mode: 0o600 }); };
  const names = bootstrap.apiNames(replicas), ids = replicas === 1 ? ['api'] : names.map((_, i) => 'api-' + (i + 1));
  const config = { version: 1, vault: { address: 'https://vault:8200', mount: 'synthetic_transit' } };
  const env = { MULTITENANT_PREVIEW_CONFIG: '/run/ns-config/config.json', OLD_CONTROL: 'synthetic-unused-credential' };
  if (mode === 'registry') { config.registry = { namespace: 'synthetic_registry' }; config.vault.tokenFile = '/run/ns-config/vault-token'; }
  else {
    config.tenants = Array.from({ length: tenants }, (_, i) => ({ id: 'synthetic-' + i, vault: { tokenEnv: 'NS_VAULT_' + i } }));
    for (let i = 0; i < tenants; i++) env['NS_VAULT_' + i] = 'synthetic-unused-' + i;
  }
  write('bootstrap/complete.json', { version: 2, sourceCommit, deployCommit, ...(mode === 'registry' ? { registryMode: true } : {}) });
  write('bootstrap/layout.json', { mount: 'synthetic_transit', prefix: 'synthetic' });
  write('bootstrap/vault-init.json', { root_token: 'synthetic-fixture-only' });
  for (const [index, name] of names.entries()) {
    write(name + '/config.json', config); write(name + '/env.json', env);
    write(name + '/operation.json', { participantId: ids[index], participants: names.map((service, i) => ({ id: ids[i], roles: ['api'], ...(replicas > 1 ? { address: { url: 'http://' + service + ':7001' } } : {}) })) });
  }
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
      for (const name of bootstrap.apiNames(replicas)) assert.equal(f.read(name + '/config.json').vault.tokenFile, bootstrap.SINK);
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
test('static conversion policy bytes and Vault request count remain constant at2/1000/10000 tenants', async () => {
  let policy, count;
  for (const n of [2, 1000, 10000]) {
    const f = fixture(1, 'static', n), v = vault();
    try {
      await bootstrap.run('provision', f.options);
      const selected = v.calls.find(row => row.resource.startsWith('sys/policies/') && row.method === 'PUT').body.policy;
      if (policy === undefined) { policy = selected; count = v.calls.length; } else { assert.equal(selected, policy); assert.equal(v.calls.length, count); }
      assert.equal(Object.keys(f.read('api/env.json')).some(key => /^NS_VAULT_/.test(key)), false);
      assert.equal(f.read('api/config.json').tenants.at(-1).vault.tokenFile, bootstrap.SINK);
    } finally { v.close(); f.close(); }
  }
});
for (const problem of ['source', 'replicas', 'mixed', 'file-symlink', 'directory-symlink', 'wide-file', 'wide-directory', 'partial']) test('invalid ' + problem + ' refuses before any Vault mutation', async () => {
  const f = fixture(2), v = vault();
  try {
    if (problem === 'source') f.options.sourceCommit = 'c'.repeat(40);
    if (problem === 'replicas') f.options.replicas = 1;
    if (problem === 'mixed') { const cfg = f.read('api-2/config.json'); delete cfg.registry; cfg.tenants = [{ id: 'synthetic', vault: { tokenEnv: 'NS_VAULT_0' } }]; f.write('api-2/config.json', cfg); }
    if (problem === 'file-symlink') { fs.renameSync(path.join(f.output, 'api/config.json'), path.join(f.output, 'api/real.json')); fs.symlinkSync('real.json', path.join(f.output, 'api/config.json')); }
    if (problem === 'directory-symlink') { fs.renameSync(path.join(f.output, 'api'), path.join(f.output, 'hidden')); fs.symlinkSync('hidden', path.join(f.output, 'api')); }
    if (problem === 'wide-file') fs.chmodSync(path.join(f.output, 'api/env.json'), 0o644);
    if (problem === 'wide-directory') fs.chmodSync(path.join(f.output, 'api'), 0o755);
    if (problem === 'partial') f.write('vault-agent/started.json', {});
    await assert.rejects(bootstrap.run('provision', f.options)); assert.equal(v.calls.length, 0);
  } finally { v.close(); f.close(); }
});
for (const problem of ['config', 'environment', 'operation', 'source', 'ttl', 'roster', 'role-material']) test('repeated-state guard rejects changed ' + problem + ' before requests', async () => {
  const f = fixture(2), v = vault();
  try {
    await bootstrap.run('provision', f.options); const calls = v.calls.length;
    if (problem === 'config') { const cfg = f.read('api/config.json'); cfg.version = 99; f.write('api/config.json', cfg); }
    if (problem === 'environment') { const env = f.read('api-2/env.json'); env.EXTRA = 'synthetic-change'; f.write('api-2/env.json', env); }
    if (problem === 'operation') { const cfg = f.read('api/operation.json'); cfg.extra = true; f.write('api/operation.json', cfg); }
    if (problem === 'source') f.options.deployCommit = 'c'.repeat(40);
    if (problem === 'ttl') f.options.ttl = '11s';
    if (problem === 'roster') f.options.replicas = 1;
    if (problem === 'role-material') fs.writeFileSync(path.join(f.output, 'vault-agent/creds/role_id'), 'synthetic-change', { mode: 0o600 });
    await assert.rejects(bootstrap.run('provision', f.options)); assert.equal(v.calls.length, calls);
  } finally { v.close(); f.close(); }
});
test('role policy permits serving operations only; identity includes exact fixed roster; no key management', () => {
  const registry = bootstrap.policyRules({ mount: 'synthetic_transit', prefix: 'synthetic' }, 'registry');
  assert.equal(registry.split('\n').length, 6); assert.ok(registry.includes('decrypt/tenant-data-*')); assert.ok(registry.includes('sign/tenant-access-*'));
  assert.equal(/keys\/|management|encrypt\/|create|delete|list/.test(registry), false);
  assert.throws(() => bootstrap.policyRules({ mount: '../bad', prefix: 'synthetic' }, 'registry'));
  assert.throws(() => bootstrap.apiNames(0)); assert.throws(() => bootstrap.apiNames(17));
});
test('shipping plan verifies and starts serving workers before the independent lab client', () => {
  const selected = { base: '/synthetic/core/deploy/multitenant', project: 'synthetic-agent', envFile: '/synthetic/.env', files: ['base.yaml'], stdin: 'services: {}',
    apis: ['api', 'api-2', 'api-3', 'api-4'], realtime: ['realtime', 'realtime-2', 'socket-edge'], evaluators: ['evaluator', 'evaluator-2'], state: '/synthetic/state' };
  const steps = launch.commands(selected, 'up').map(row => row.args.join(' '));
  assert.ok(steps[1].endsWith('run --rm bootstrap'));
  assert.ok(steps[3].includes('platform-verify.js'));
  assert.ok(steps[5].endsWith('vault-agent'));
  assert.ok(steps[6].endsWith('api api-2 api-3 api-4 realtime realtime-2 socket-edge evaluator evaluator-2 pgstream tenant-admin ui nginx'));
  assert.equal(steps.length,7);
  const lab = launch.commands(selected, 'prime').map(row => row.args.join(' '));
  assert.ok(lab[0].includes('prime.js provision')); assert.ok(lab[1].includes('commission-restore.js'));
  assert.ok(lab[2].includes('prime.js prime')); assert.ok(lab[3].includes('publish-primer.js'));
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
