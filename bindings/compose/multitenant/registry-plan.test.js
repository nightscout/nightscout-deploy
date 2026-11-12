'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const plan = require('./config');
function generated() {
  const layout = plan.layout(), urls = Object.fromEntries(Object.keys(layout.roles).map(kind => [kind, 'postgres://' + layout.roles[kind] + ':' + crypto.randomBytes(20).toString('hex') + '@postgres/nightscout_compose_test']));
  return { layout, urls, docs: plan.documents({ layout, urls, tokens: [], publicKeys: [], managementKeys: [], vaultAddress: 'https://vault:8200', registryMode: true }) };
}
function files(docs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-registry-plan-'));
  for (const role of Object.keys(docs.configs)) {
    const own = path.join(directory, role); fs.mkdirSync(own);
    for (const [name, value] of Object.entries({ 'config.json': docs.configs[role], 'operation.json': docs.operations[role], 'evaluator-metadata.json': docs.configs.evaluator })) fs.writeFileSync(path.join(own, name), JSON.stringify(value));
  }
  return directory;
}
test('registry role documents have no static roster or per-tenant key lists and pass product parsers', () => {
  const { docs } = generated(), directory = files(docs);
  try {
    plan.validateFiles(directory, docs);
    require('../../lib/server/serve/admin-config').parse(docs.admin.config, docs.admin.environment);
    for (const [role, config] of Object.entries(docs.configs)) {
      assert(!Object.hasOwn(config, 'tenants'), role);
      assert(!Object.hasOwn(docs.operations[role], 'locks'), role);
      assert(!Object.keys(docs.environments[role]).some(name => /^NS_VAULT_\d+$/.test(name)), role);
    }
    assert.equal(docs.configs.api.tenantSettings.namespaces.settings.endsWith('_display_settings'), true);
    assert.deepEqual(docs.configs.realtime.tenantSettings, docs.configs.api.tenantSettings);
    assert.equal(docs.environments.realtime.NS_DISPLAY_PG, docs.environments.api.NS_DISPLAY_PG);
    assert.equal(docs.admin.environment.ADMIN_HOSTNAME, 'admin');
    assert.equal(docs.admin.environment.ADMIN_INSECURE_BIND_ACKNOWLEDGED, 'true');
    assert.equal(docs.configs.api.postgres.namespaces.settings.endsWith('_settings'), true);
    assert.equal(docs.admin.config.provisioning.checkpoints.length, 2);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('control: restoring a static list into registry authority is refused, restoration passes', () => {
  const { docs } = generated(); docs.configs.api.tenants = [];
  let directory = files(docs);
  try { assert.throws(() => plan.validateFiles(directory, docs), /refuses a tenants list/); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  delete docs.configs.api.tenants; directory = files(docs);
  try { plan.validateFiles(directory, docs); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('provisioning identity and read-only settings/activity capabilities are distinct from serving', () => {
  const { layout } = generated();
  assert.equal(new Set([layout.roles.api, layout.roles.provisioner, layout.roles.display_reader, layout.roles.activity_reader]).size, 4);
  const grants = plan.grants(layout).join('\n');
  assert.match(grants, /tenant_registry_lookup/); assert.match(grants, /tenant_settings_history/);
  assert(!grants.split('\n').some(sql => /INSERT|UPDATE|DELETE/.test(sql) && /TO "nsdemo_display_reader"/.test(sql)));
});
