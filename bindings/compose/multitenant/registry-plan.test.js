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
    assert.equal(docs.operations.api.leaseSessions, 4);
    for (const participant of docs.operations.api.participants) assert(!participant.namespaces.includes(docs.operations.api.namespace));
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
  assert.match(grants, /REVOKE ALL ON FUNCTION \"nsdemo_display_settings\"\.tenant_settings_values_valid\(jsonb\) FROM PUBLIC/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION \"nsdemo_display_settings\"\.tenant_settings_values_valid\(jsonb\) TO \"nsdemo_provisioner\"/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION "nsdemo_registry"\.tenant_registry_lookup\(text, text\) TO "nsdemo_realtime"/);
  assert(!grants.split('\n').some(sql => /GRANT SELECT ON "nsdemo_registry"\.tenant_registry(?:,|_keys)/.test(sql) && /TO "nsdemo_realtime"/.test(sql)), 'realtime uses reviewed resolver/enumerator functions without raw registry rows');
  assert.match(grants, /tenant_registry_lookup/); assert.match(grants, /tenant_settings_history/);
  assert(!grants.split('\n').some(sql => /INSERT|UPDATE|DELETE/.test(sql) && /TO "nsdemo_display_reader"/.test(sql)));
});

test('control: adding the operation control schema to protected data refuses launcher resource matching', () => {
  const { docs } = generated();
  docs.operations.api.participants.find(row => row.id === 'api').namespaces.push(docs.operations.api.namespace);
  const directory = files(docs);
  try { assert.throws(() => plan.validateFiles(directory, docs), /namespace mismatch/); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('restore inventory admits the independent evaluator checkpoint and all current product metadata families', () => {
  const inventory = plan.lifecycle(plan.layout());
  const lifecycle = require('../../lib/tenant-lifecycle').createLifecycle({ catalogues: inventory.catalogues });
  const kinds = inventory.catalogues.map(row => row.kind);
  assert(kinds.includes('checkpoint') && kinds.includes('evaluator_checkpoint'));
  assert.deepEqual(inventory.catalogues.find(row => row.kind === 'checkpoint').tables, inventory.catalogues.find(row => row.kind === 'evaluator_checkpoint').tables);
  assert(inventory.catalogues.find(row => row.kind === 'access').tables.includes('management_session_requests'));
  assert(inventory.catalogues.find(row => row.kind === 'tenant_settings').tables.includes('tenant_connector_sources'));
  for (const kind of ['registry', 'feed', 'control', 'change_stamps']) assert(!kinds.includes(kind));
  assert.equal(typeof lifecycle.exportTenant, 'function');
});
test('control: a source table absent from the admitted restore inventory refuses instead of being omitted', () => {
  const product = require('../../lib/tenant-lifecycle'), original = product.admittedCatalogue;
  product.admittedCatalogue = () => original().map(row => row.kind === 'access' ? { ...row, tables: row.tables.filter(name => name !== 'management_session_requests') } : row);
  try { assert.throws(() => plan.lifecycle(plan.layout()), /table inventory mismatch access/); }
  finally { product.admittedCatalogue = original; }
  assert.doesNotThrow(() => plan.lifecycle(plan.layout()));
});

test('bounded lifetime-session selection is explicit and cannot exceed the selected physical pool', () => {
  const select = require('./registry-plan').leaseSessions;
  assert.equal(select({}), 4); assert.equal(select({ NS_OPERATION_LEASE_SESSIONS: '8' }), 8);
  for (const raw of ['0','9','2.5','bad']) assert.throws(() => select({ NS_OPERATION_LEASE_SESSIONS: raw }));
});

test('raw LISTEN transport has a distinct login without any table, function or replication grant',()=>{
  const {layout,urls,docs}=generated();
  assert.notEqual(layout.roles.feed_listener,layout.roles.feed_reader);
  for(const role of ['realtime','evaluator']){
    assert.equal(docs.configs[role].changeFeed.connectionEnv,'NS_FEED_LISTENER_PG');
    assert.equal(docs.environments[role].NS_FEED_LISTENER_PG,urls.feed_listener);
    assert.notEqual(urls.feed_listener,urls[role]);
  }
  assert.ok(!plan.grants(layout).some(sql=>sql.includes('"'+layout.roles.feed_listener+'"')),'LISTEN needs no schema/table/function grants');
});
