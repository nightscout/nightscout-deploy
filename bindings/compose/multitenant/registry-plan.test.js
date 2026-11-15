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
    assert.equal(docs.configs['tenant-admin'].ownerCredentials.connectionEnv,'NS_OWNER_CREDENTIALS_PG');
    assert.equal(docs.configs.api.localDataAuthentication, 'node');
    assert.equal(docs.configs.api.accessTokens.issuer, 'nightscout-compose-demo');
    assert.equal(docs.configs.api.accessTokens.audience, 'nightscout-data');
    assert.equal(docs.configs.api.tenantSettings.namespaces.settings.endsWith('_display_settings'), true);
    assert.deepEqual(docs.configs.realtime.tenantSettings, docs.configs.api.tenantSettings);
    assert.equal(docs.environments.realtime.NS_DISPLAY_PG, docs.environments.api.NS_DISPLAY_PG);
    assert.equal(docs.admin.environment.ADMIN_HOSTNAME, 'admin');
    assert.equal(docs.admin.environment.ADMIN_INSECURE_BIND_ACKNOWLEDGED, 'true');
    assert.equal(docs.configs.api.postgres.namespaces.settings.endsWith('_settings'), true);
    assert.equal(docs.admin.config.provisioning.checkpoints.length, 3);
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
  assert.match(grants,/GRANT SELECT ON "nsdemo_secrets"."schema_migrations" TO "nsdemo_owner_credentials"/);
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
  assert(inventory.catalogues.find(row => row.kind === 'legacy').tables.includes('legacy_data_keys'));
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

test('maintained capture and typed completed delivery replace the retired feed roles and configuration',()=>{
  const {layout,docs}=generated(),evaluator=docs.configs.evaluator,realtime=docs.configs.realtime;
  assert.equal(layout.roles.feed_reader,undefined);assert.equal(layout.roles.feed_listener,undefined);
  assert.equal(evaluator.pgstream.streamRole,layout.roles.pgstream);
  assert.equal(realtime.completedOutput.namespace,layout.namespaces.eval_checkpoint);
  assert.equal(realtime.completedOutput.consumer,evaluator.consumer);
  assert.deepEqual(Object.keys(realtime.postgres.namespaces).sort(),['checkpoint','clock']);
  for(const role of ['evaluator','realtime']){
    const config=docs.configs[role];
    for(const key of ['changeFeed','recoveryIntervalMs','settingsRefreshMs'])assert.equal(Object.hasOwn(config,key),false,role+': '+key);
    assert.equal(Object.hasOwn(config.postgres.namespaces,'changeStamps'),false);
    assert.equal(Object.keys(docs.environments[role]).some(key=>key.startsWith('NS_FEED_')),false);
  }
  assert.equal(Object.hasOwn(realtime,'pageSize'),false);assert.equal(Object.hasOwn(realtime,'socketOrderDomains'),false);
  const routes=require('../../lib/pgstream/evaluator').routes({...evaluator,namespaces:evaluator.postgres.namespaces});
  assert.deepEqual(routes.map(row=>row.kind).sort(),['activity','clock','heartbeat','lifecycle','policy','settings']);
  assert.equal(routes.some(row=>row.table==='tenant_consumer_checkpoint'),false,'completed output is handed off after commit rather than recaptured');
  const typed=docs.admin.config.provisioning.checkpoints.find(row=>row.consumer===evaluator.consumer+'-completed');
  const receipt=docs.admin.config.provisioning.checkpoints.find(row=>row.consumer===realtime.consumer);
  assert.equal(typed.namespace,realtime.completedOutput.namespace);
  assert.equal(receipt.namespace,realtime.postgres.namespaces.checkpoint);
  assert.equal(receipt.digest,require('../../lib/pgstream/realtime-receipt').contractDigest(receipt.namespace,receipt.consumer));
});

test('realtime base grants retain narrow metadata reads and revoke raw clinical and immutable cursor privileges',()=>{
  const {layout}=generated(),role='"'+layout.roles.realtime+'"';
  const rows=plan.grants(layout).filter(sql=>sql.endsWith(' TO '+role)||sql.endsWith(' FROM '+role));
  const clinical=['entries','treatments','devicestatus','profile','food','activity'];
  for(const domain of clinical){
    const table='"'+layout.namespaces[domain]+'"."'+domain+'"';
    assert(rows.includes('REVOKE SELECT ON '+table+' FROM '+role));
    assert.equal(rows.some(sql=>sql.startsWith('GRANT ')&&sql.includes('ON '+table+' ')),false,'raw clinical SELECT is not a realtime capability');
  }
  assert(rows.includes('GRANT SELECT ON "'+layout.namespaces.rt_checkpoint+'"."tenant_consumer_checkpoint" TO '+role));
  assert(rows.includes('REVOKE UPDATE(checkpoint,projection,contract_digest) ON "'+layout.namespaces.rt_checkpoint+'"."tenant_consumer_checkpoint" FROM '+role));
});

test('placement publication has readonly control metadata and registry enumeration, without maintenance identity',()=>{
  const {layout}=generated(),grants=plan.grants(layout).filter(sql=>sql.includes('"'+layout.roles.placement_publisher+'"'));
  assert.notEqual(layout.roles.placement_publisher,layout.roles.operator);
  assert.ok(grants.some(sql=>sql.includes('tenant_registry_tenants')));
  assert.ok(grants.some(sql=>sql.includes('tenant_lifecycle_windows')));
  for(const sql of grants){assert.ok(!/INSERT|UPDATE|DELETE|REPLICATION|tenant_lifecycle_backend_birth|ALL TABLES/.test(sql),sql);}
});

test('maintained capture health bounds are distinct from evaluator due work and realtime delivery retries',()=>{
  const {docs}=generated(),evaluator=docs.configs.evaluator,realtime=docs.configs.realtime;
  const bounds=evaluator.pgstream.bounds;
  assert(bounds.heartbeatMs>0&&bounds.stallMs>=bounds.heartbeatMs);
  assert(bounds.stepMs>0&&bounds.recoveryMs>=bounds.stepMs&&bounds.pendingMs>0);
  assert.equal(evaluator.timeIntervalMs,60000);
  assert.equal(Object.hasOwn(realtime,'pgstream'),false,'one evaluator-owned input capture');
  assert.equal(Object.hasOwn(realtime,'recoveryIntervalMs'),false,'realtime drains addressed durable work');
  const directory=files(docs);try{plan.validateFiles(directory,docs);}finally{fs.rmSync(directory,{recursive:true,force:true});}
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

test('owner credential preparation accounts for its two actual private pools',()=>{
 const {docs}=generated(),budget=require('./connection-budget'),pools=require('../../lib/server/serve/pool-config');
 const selected=budget.describe(docs,pools).find(row=>row.roles[0]==='tenant-admin');
 assert.equal(selected.capabilities['nightscout-secrets'].requestedMaximum,4);
 assert.equal(selected.capabilities['nightscout-legacy-authority'].requestedMaximum,4);
 delete docs.configs['tenant-admin'].ownerCredentials;
 const baseline=budget.describe(docs,pools).find(row=>row.roles[0]==='tenant-admin');
 const max=row=>Object.values(row.capabilities).reduce((n,c)=>n+(c.requestedMaximum||0),0);
 assert.equal(max(selected)-max(baseline),8);
});
