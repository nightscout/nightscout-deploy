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

test('placement publication has readonly control metadata and registry enumeration, without maintenance identity',()=>{
  const {layout}=generated(),grants=plan.grants(layout).filter(sql=>sql.includes('"'+layout.roles.placement_publisher+'"'));
  assert.notEqual(layout.roles.placement_publisher,layout.roles.operator);
  assert.ok(grants.some(sql=>sql.includes('tenant_registry_tenants')));
  assert.ok(grants.some(sql=>sql.includes('tenant_lifecycle_windows')));
  for(const sql of grants){assert.ok(!/INSERT|UPDATE|DELETE|REPLICATION|tenant_lifecycle_backend_birth|ALL TABLES/.test(sql),sql);}
});

test('NS_FEED_SWEEP_MS is off when empty and selects a bounded healthy rotation period for both feed consumers', () => {
  const { feedSweep } = require('./registry-plan');
  assert.deepEqual(feedSweep({}), {}); assert.deepEqual(feedSweep({ NS_FEED_SWEEP_MS: '' }), {});
  assert.deepEqual(feedSweep({ NS_FEED_SWEEP_MS: '30000' }), { sweepMs: 30000 });
  for (const raw of ['999', '30001', '0', '1e4', '10000.5', 'on']) assert.throws(() => feedSweep({ NS_FEED_SWEEP_MS: raw }), { code: 'FEED_SWEEP_INVALID' });
  const saved = process.env.NS_FEED_SWEEP_MS;
  try {
    delete process.env.NS_FEED_SWEEP_MS;
    const off = generated().docs.configs;
    for (const role of ['evaluator', 'realtime']) assert.equal(Object.hasOwn(off[role].changeFeed, 'sweepMs'), false, 'unset leaves the generated configuration as it was');
    process.env.NS_FEED_SWEEP_MS = '30000';
    const on = generated().docs.configs;
    for (const role of ['evaluator', 'realtime']) assert.equal(on[role].changeFeed.sweepMs, 30000);
    assert.equal(on.evaluator.changeFeed.pageSize, 256); assert.equal(on.evaluator.changeFeed.degradedPages, 4);
  } finally { if (saved === undefined) delete process.env.NS_FEED_SWEEP_MS; else process.env.NS_FEED_SWEEP_MS = saved; }
});

test('explicit consumer heartbeat horizon preserves default and is parsed by actual product config',()=>{
 const compose=require('js-yaml').load(fs.readFileSync(path.join(__dirname,'compose.yaml'),'utf8'));assert.equal(compose.services.bootstrap.environment.NS_FEED_HEARTBEAT_TIMEOUT_MS,'${NS_FEED_HEARTBEAT_TIMEOUT_MS:-}');
 const {feedHeartbeat}=require('./registry-plan');assert.equal(feedHeartbeat({}),5000);assert.equal(feedHeartbeat({NS_FEED_HEARTBEAT_TIMEOUT_MS:''}),5000);
 for(const raw of ['100','5000','300000'])assert.equal(feedHeartbeat({NS_FEED_HEARTBEAT_TIMEOUT_MS:raw}),Number(raw));
 for(const raw of ['99','300001','0','0100','1e3','100.5','true',false,100,null])assert.throws(()=>feedHeartbeat({NS_FEED_HEARTBEAT_TIMEOUT_MS:raw}),{code:'FEED_HEARTBEAT_INVALID'});
 const saved=process.env.NS_FEED_HEARTBEAT_TIMEOUT_MS;
 try{
  delete process.env.NS_FEED_HEARTBEAT_TIMEOUT_MS;const off=generated().docs;for(const role of ['evaluator','realtime'])assert.equal(off.configs[role].changeFeed.heartbeatTimeoutMs,5000);
  process.env.NS_FEED_HEARTBEAT_TIMEOUT_MS='300000';const on=generated().docs,directory=files(on);
  try{for(const role of ['evaluator','realtime']){assert.equal(on.configs[role].changeFeed.heartbeatTimeoutMs,300000);assert.equal(on.configs[role].changeFeed.intervalMs,1000);assert.equal(on.configs[role].changeFeed.pageSize,256);assert.equal(Object.hasOwn(on.configs[role].changeFeed,'sweepMs'),Object.hasOwn(off.configs[role].changeFeed,'sweepMs'));}plan.validateFiles(directory,on);}finally{fs.rmSync(directory,{recursive:true,force:true});}
 }finally{if(saved===undefined)delete process.env.NS_FEED_HEARTBEAT_TIMEOUT_MS;else process.env.NS_FEED_HEARTBEAT_TIMEOUT_MS=saved;}
});
test('trusted workers receive ordinary cross-tenant metadata SELECT; public roles keep tenant policies', () => {
  const { layout, docs } = generated(), ns = layout.namespaces;
  const expected = { activity: ns.control, clock: ns.clock, settings: ns.display_settings, operatorPolicy: ns.operator_policy };
  for (const role of ['evaluator','realtime']) assert.deepEqual(docs.configs[role].trustedWorker, expected);
  assert.equal(docs.configs.api.trustedWorker, undefined);
  const policies = plan.grants(layout).filter(sql => /^CREATE POLICY "trusted_worker_/.test(sql));
  assert.equal(policies.length, 8);
  for (const sql of policies) {
    assert.ok(sql.includes('TO "' + layout.roles.evaluator + '"') || sql.includes('TO "' + layout.roles.realtime + '"'));
    assert.match(sql, /FOR SELECT .* USING \(true\)$/);
    assert.ok(!sql.includes('PUBLIC') && !sql.includes(layout.roles.api) && !sql.includes(layout.roles.display_reader));
  }
});
