'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { documents, files, BASE } = require('./platform-startup');
const { writePrivate } = require('./bootstrap');
function fixture() {
  const roles = ['api', 'evaluator', 'realtime'];
  const docs = { configs: Object.fromEntries([...roles, 'tenant-admin'].map(role => [role, { version: 1 }])),
    environments: Object.fromEntries(roles.map(role => [role, { NS_LIFETIME_PG: role + '-synthetic-private',
      MULTITENANT_OPERATION_CONFIG: '/run/ns-config/operation.json',
      ...(role === 'api' ? { MULTITENANT_PREVIEW_CONFIG: '/run/ns-config/config.json', MULTITENANT_EVALUATOR_CONFIG: '/run/ns-config/evaluator-metadata.json' } :
        { [role === 'evaluator' ? 'MULTITENANT_EVALUATOR_CONFIG' : 'MULTITENANT_REALTIME_CONFIG']: '/run/ns-config/config.json' }) }])),
    operations: Object.fromEntries(roles.map(role => [role, { version: 2, connectionEnv: 'NS_LIFETIME_PG', participantId: role }])),
    admin: { config: {}, environment: {} } };
  return documents(docs, { prefix: 'synthetic' }, { platform_verifier: 'writer-synthetic-private' });
}
test('only admin receives the verification writer capability; serving roles carry an explicit selection', () => {
  const docs = fixture();
  assert.equal(docs.admin.environment.NS_PLATFORM_VERIFY_PG, 'writer-synthetic-private');
  for (const role of ['api', 'evaluator', 'realtime']) {
    assert.deepEqual(docs.configs[role].platformVerification, { namespace: 'synthetic_platform_verification', role });
    assert.equal(docs.environments[role].NS_PLATFORM_VERIFY_PG, undefined);
  }
  assert.equal(docs.configs['tenant-admin'].platformVerification, undefined);
});
test('admin verification retains each actual role credential and exact operation config in private files', () => {
  const docs = fixture(), output = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-platform-docs-'));
  try {
    files({ output, docs, writePrivate, own: {}, compact: { compact: true } });
    const targets = docs.admin.config.platformVerification.targets;
    assert.equal(new Set(targets.map(row => row.role)).size, 3);
    for (const target of targets) {
      const local = file => file.replace('/run/ns-config', path.join(output, 'admin'));
      const config = JSON.parse(fs.readFileSync(local(target.configFile))), operation = JSON.parse(fs.readFileSync(local(target.operationConfigFile))), env = JSON.parse(fs.readFileSync(local(target.environmentFile)));
      assert.equal(config.platformVerification.role, target.role);
      assert.equal(operation.participantId, target.role); assert.equal(env[operation.connectionEnv], target.role + '-synthetic-private');
      assert.equal(env.MULTITENANT_OPERATION_CONFIG, BASE + '/' + target.role + '.operation.json');
      if (target.role === 'api') assert.equal(env.MULTITENANT_EVALUATOR_CONFIG, BASE + '/evaluator.config.json');
      for (const key of ['configFile', 'operationConfigFile', 'environmentFile']) assert.equal(fs.statSync(local(target[key])).mode & 0o777, 0o600);
    }
  } finally { fs.rmSync(output, { recursive: true, force: true }); }
});

test('a missing role context refuses before copying any neighboring credential; restoration succeeds', () => {
  const docs = fixture(), evaluator = docs.environments.evaluator, output = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-platform-missing-'));
  try {
    delete docs.environments.evaluator;
    assert.throws(() => files({ output, docs, writePrivate, own: {}, compact: { compact: true } }), { code: 'PLATFORM_VERIFICATION_CONTEXT_REQUIRED' });
    assert.deepEqual(fs.readdirSync(output), []);
    docs.environments.evaluator = evaluator;
    files({ output, docs, writePrivate, own: {}, compact: { compact: true } });
    const env = JSON.parse(fs.readFileSync(path.join(output, 'admin/verification/evaluator.env.json')));
    assert.equal(env.NS_LIFETIME_PG, 'evaluator-synthetic-private');
  } finally { fs.rmSync(output, { recursive: true, force: true }); }
});
test('generated admin targets load the actual product role configs with each owned operation credential', () => {
  const plan = require('./config'), { loadTarget } = require('../../lib/server/serve/platform-verification-admin');
  const layout = plan.layout(), urls = Object.fromEntries(Object.entries(layout.roles).map(([name, role]) => [name, 'postgres://' + role + ':synthetic-only@postgres:5432/nightscout_compose_test']));
  const docs = plan.documents({ layout, urls, tokens: [], publicKeys: [], managementKeys: [], vaultAddress: 'https://vault:8200' });
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-platform-load-'));
  try {
    files({ output, docs, writePrivate, own: {}, compact: { compact: true } });
    for (const configured of docs.admin.config.platformVerification.targets) {
      const target = Object.fromEntries(Object.entries(configured).map(([key, value]) => [key, key === 'role' ? value : value.replace('/run/ns-config', path.join(output, 'admin'))]));
      const env = JSON.parse(fs.readFileSync(target.environmentFile));
      for (const [key, value] of Object.entries(env)) if (typeof value === 'string') env[key] = value.replace('/run/ns-config', path.join(output, 'admin'));
      fs.writeFileSync(target.environmentFile, JSON.stringify(env));
      const loaded = loadTarget(target, docs.admin.environment);
      assert.equal(loaded.role, configured.role); assert.equal(loaded.config.connectionString, urls[configured.role]);
      assert.equal(loaded.config.platformVerification.namespace, layout.prefix + '_platform_verification');
      assert.equal(loaded.source.NS_LIFETIME_PG, urls['lifetime_' + configured.role]);
      assert.equal(loaded.source.NS_PLATFORM_VERIFY_PG, urls.platform_verifier);
      const operation = require('../../lib/server/serve/operation-cohort-config').load(loaded.source);
      assert.equal(operation.poolOptions.user, layout.roles['lifetime_' + configured.role]);
      assert.equal(operation.poolOptions.database, 'nightscout_compose_test');
      assert.equal(operation.poolOptions.password, 'synthetic-only');
    }
  } finally { fs.rmSync(output, { recursive: true, force: true }); }
});
