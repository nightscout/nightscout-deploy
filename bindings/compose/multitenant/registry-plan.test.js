'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const plan = require('./config');
function generated() {
  const layout=plan.layout(),settings=require('../../lib/server/serve/deployment-settings');
  const env={NS_VAULT_ADDR:'https://vault:8200',NS_PROVISIONER_PG:'synthetic'};
  const configs=Object.fromEntries(plan.serviceRoles.map(role=>[role,settings.configuration(role,env)]));
  return {layout,docs:{configs,environments:Object.fromEntries(plan.serviceRoles.map(role=>[role,{}])),admin:{config:settings.configuration('admin',env)}}};
}
test('provisioning identity and read-only settings/activity capabilities are distinct from serving', () => {
  const { layout } = generated();
  assert.equal(new Set([layout.roles.api, layout.roles.provisioner, layout.roles.display_reader, layout.roles.activity_reader]).size, 4);
  const grants = plan.grants(layout).join('\n');
  assert.match(grants, /GRANT SELECT ON "nsdemo_control"\."tenant_activity" TO "nsdemo_api"/);
  assert.match(grants,/GRANT SELECT ON "nsdemo_secrets"."schema_migrations" TO "nsdemo_owner_credentials"/);
  assert.match(grants, /REVOKE ALL ON FUNCTION \"nsdemo_display_settings\"\.tenant_settings_values_valid\(jsonb\) FROM PUBLIC/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION \"nsdemo_display_settings\"\.tenant_settings_values_valid\(jsonb\) TO \"nsdemo_provisioner\"/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION "nsdemo_registry"\.tenant_registry_lookup\(text, text\) TO "nsdemo_realtime"/);
  assert(!grants.split('\n').some(sql => /GRANT SELECT ON "nsdemo_registry"\.tenant_registry(?:,|_keys)/.test(sql) && /TO "nsdemo_realtime"/.test(sql)), 'realtime uses reviewed resolver/enumerator functions without raw registry rows');
  assert.match(grants, /tenant_registry_lookup/); assert.match(grants, /tenant_settings_history/);
  assert(!grants.split('\n').some(sql => /INSERT|UPDATE|DELETE/.test(sql) && /TO "nsdemo_display_reader"/.test(sql)));
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

test('maintained capture and typed completed delivery replace the retired feed roles and configuration',()=>{
  const {layout,docs}=generated(),evaluator=docs.configs.evaluator,realtime=docs.configs.realtime;
  assert.equal(layout.roles.feed_reader,undefined);assert.equal(layout.roles.feed_listener,undefined);
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

test('maintained startup bounds and durable clinical pending bounds have no synthetic heartbeat',()=>{
  const {docs}=generated(),evaluator=docs.configs.evaluator,realtime=docs.configs.realtime;
  const bounds=evaluator.pgstream.bounds;
  assert.deepEqual(Object.keys(bounds).sort(),['pendingMs','recoveryMs','stepMs']);
  assert(bounds.stepMs>0&&bounds.recoveryMs>=bounds.stepMs&&bounds.pendingMs>0);
  assert.equal(evaluator.timeIntervalMs,60000);
  assert.equal(Object.hasOwn(realtime,'pgstream'),false,'one evaluator-owned input capture');
  assert.equal(Object.hasOwn(realtime,'recoveryIntervalMs'),false,'realtime drains addressed durable work');
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

test('ordinary deployment delegates its SQL and provisioning namespace composition to the product', () => {
  const shared = require('../../lib/server/ordinary-deployment-grants');
  assert.equal(plan.grants, shared.grants);
  assert.equal(plan.insertionGrants, shared.insertionGrants);
});
