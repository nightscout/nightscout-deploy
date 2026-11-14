'use strict';

// The runtime roster and keys come from the registry. The seed remains input
// to the operator provisioning adapter; it is not copied into role authority.
const clinical = ['entries','treatments','devicestatus','profile','food','activity'];
function leaseSessions(source = process.env) {
  const raw = source.NS_OPERATION_LEASE_SESSIONS === undefined ? '4' : source.NS_OPERATION_LEASE_SESSIONS;
  const maximum = require('../../lib/server/serve/pool-config').pool('operation', source).max;
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw) || Number(raw) > maximum) throw new TypeError('NS_OPERATION_LEASE_SESSIONS must fit the selected operation pool');
  return Number(raw);
}
function provisioningNamespaces(ns) {
  return { registry: ns.registry, legacy: ns.legacy, secrets: ns.secrets, authorization: ns.authorization,
    access: ns.access, clock: ns.clock, control: ns.control, settings: ns.display_settings, operatorPolicy: ns.operator_policy };
}
function checkpoints(docs, ns) {
  const rows=[['rt_checkpoint','realtime','realtime-current-rows-v1'],['eval_checkpoint','evaluator','clinical-current-rows-v1']].map(([kind, role, projectionVersion]) => {
    const document = docs.configs[role];
    const replay = require('../../lib/storage/postgres-durable-replay')({ connection: { query() { throw new Error('CONSTRUCTOR_ONLY'); }, snapshotTransaction() { throw new Error('CONSTRUCTOR_ONLY'); } },
      checkpointTable: ns[kind] + '.tenant_consumer_checkpoint', clockTable: ns.clock + '.tenant_write_clock', consumer: document.consumer,
      domains: Object.fromEntries(clinical.map(name => [name, ns[name] + '.' + name])), projectionVersion, pageSize: document.pageSize, maxRows: document.maxRows });
    return { namespace: ns[kind], consumer: document.consumer, digest: replay.digest };
  });
  if(docs.configs.evaluator.pgstream){const document=docs.configs.evaluator;const output=require('../../lib/pgstream/checkpoint').create({typed:true,connection:{},namespace:ns.eval_checkpoint,consumer:document.consumer,maxBytes:document.maxBytes*2,timeIntervalMs:document.timeIntervalMs});rows.push({namespace:ns.eval_checkpoint,consumer:output.consumer,digest:output.digest});}
  return rows;
}
function expand(docs, { layout, urls, vaultAddress }) {
  const ns = layout.namespaces, registry = { namespace: ns.registry, maxTenants: 10000, refreshMs: 2000 };
  const settings = { connectionEnv: 'NS_DISPLAY_PG', namespaces: { settings: ns.display_settings, operatorPolicy: ns.operator_policy } };
  const activity = { connectionEnv: 'NS_ACTIVITY_PG', namespace: ns.control };
  for (const [role, config] of Object.entries(docs.configs)) {
    delete config.tenants; config.registry = { ...registry };
    if (role === 'api' || role === 'evaluator' || role === 'realtime') config.tenantSettings = settings;
    if (role === 'api' || role === 'evaluator' || role === 'realtime') config.activity = activity;
    if (role === 'api') {
      config.vault = { address: vaultAddress, mount: layout.mount, timeoutMs: 5000, tokenFile: '/run/ns-config/vault-token' };
      delete config.accessTokens.keys;
      delete config.socketForwarding.admissionFileEnv;
      config.socketForwarding.maxTenants = 10000;
    }
    if (role === 'tenant-admin') delete config.management.keys;
    if (role === 'evaluator' || role === 'realtime') {
      config.maxTenants = 10000;
      config.trustedWorker = { activity: ns.control, clock: ns.clock, settings: ns.display_settings, operatorPolicy: ns.operator_policy };
    }
    if (role === 'realtime') delete config.admissionFileEnv;
    const env = docs.environments[role];
    for (const name of Object.keys(env)) if (/^NS_VAULT_\d+$/.test(name) || name === 'NS_ADMISSION_FILE') delete env[name];
    if (role === 'api' || role === 'evaluator' || role === 'realtime') env.NS_DISPLAY_PG = urls.display_reader;
    if (role === 'api' || role === 'evaluator' || role === 'realtime') env.NS_ACTIVITY_PG = urls.activity_reader;
    delete docs.operations[role].locks; docs.operations[role].leaseSessions = leaseSessions(); docs.operations[role].registry = { namespace: ns.registry };
  }
  // LISTEN only carries hints. Its raw transport client has no clinical grant;
  // tenant-bound truth remains on each role's registered storage connection.
  for (const role of ['evaluator','realtime']) {
    docs.environments[role].NS_FEED_LISTENER_PG = urls.feed_listener;
    docs.configs[role].changeFeed = { connectionEnv: 'NS_FEED_LISTENER_PG', channel: layout.prefix + '_changes', pageSize: 256, degradedPages: 4, intervalMs: 1000, heartbeatTimeoutMs: feedHeartbeat(), ...feedSweep() };
  }
  docs.feed = { config: { connectionEnv: 'NS_FEED_PG', namespace: ns.feed, clockNamespace: ns.clock, activityNamespace: ns.control, settingsNamespace: ns.display_settings, policyNamespace: ns.operator_policy,
    slot: layout.prefix + '_feed_slot', publication: layout.prefix + '_feed_publication', owner: layout.feedOwner, channel: layout.prefix + '_changes',
    pollMs: 50, heartbeatMs: 1000, targetChanges: 128, maxMessages: 10000, maxBytes: 1048576, statementTimeoutMs: 2000, rssRefuseBytes: 268435456 },
    environment: { MULTITENANT_FEED_CONFIG: '/run/ns-config/config.json', NS_FEED_PG: urls.feed_reader } };
  require('./pgstream').configure(docs,layout);
  // Recompute manifest coverage from the selected product configuration.
  const protectedNamespaces = require('../../lib/server/serve/operation-cohort').protectedNamespaces;
  const participants = Object.entries(docs.configs).map(([role, config]) => ({ id: role, roles: [role],
    namespaces: [...new Set([...protectedNamespaces(config), ...(role === 'api' ? [ns.outbox] : [])])].filter(name => name !== ns.control).sort(), maxMessageBytes: 1048576, timeoutMs: 10000 }));
  for (const value of Object.values(docs.operations)) value.participants = participants;
  docs.remote = participants.map(peer => ({ id: peer.id, roles: peer.roles, namespaces: peer.namespaces,
    endpoint: { socketPath: '/run/ns-ipc/' + peer.id + '.sock', maxBytes: peer.maxMessageBytes, timeoutMs: peer.timeoutMs } }));
  docs.locks = docs.locks.map(row => ({ tenant: row.tenant, key: require('../../lib/tenant-registry/rules').lockKey(row.tenant) }));
  docs.admin = { config: { version: 1, maxBytes: 1048576, timeoutMs: 60000,
    managementSessions: { connectionEnv: 'NS_MANAGEMENT_SESSIONS_PG',
      namespaces: { registry: ns.registry, authorization: ns.authorization, access: ns.access, control: ns.control },
      issuer: 'nightscout-compose-management', audience: 'nightscout-management', consumer: 'compose-owner', maxLifetimeSeconds: 600,
      vault: { address: vaultAddress, mount: layout.mount, tokenFile: '/run/ns-config/management-vault-token', timeoutMs: 10000 },
      operator: { principal: 'compose-operator', consumer: 'compose-management' } },
    ownership: { connectionEnv: 'NS_OWNERSHIP_PG', namespace: ns.authorization, lifecycleNamespace: ns.control,
      registry: { ...registry }, operator: { principal: 'compose-operator', consumer: 'compose-ownership' } },
    connectorSources: { connectionEnv: 'NS_CONNECTOR_SOURCES_PG', namespaces: { settings: ns.display_settings, registry: ns.registry, secrets: ns.secrets, control: ns.control },
      operator: { principal: 'compose-operator', consumer: 'compose-connectors' } },
    provisioning: { connectionEnv: 'NS_PROVISIONER_PG', namespaces: provisioningNamespaces(ns), checkpoints: checkpoints(docs, ns),
      vault: { address: vaultAddress, mount: layout.mount, tokenFile: '/run/ns-config/vault-token', timeoutMs: 10000 },
      ownerPolicy: { catalogue: ['*'] }, operator: { principal: 'compose-operator', consumer: 'compose-provisioning' } } },
    environment: { ADMIN_HOSTNAME: 'admin', ADMIN_PORT: '1342', ADMIN_INSECURE_BIND_ACKNOWLEDGED: 'true', MULTITENANT_ADMIN_CONFIG: '/run/ns-config/config.json', NS_PROVISIONER_PG: urls.provisioner, NS_OWNERSHIP_PG: urls.ownership_operator, NS_CONNECTOR_SOURCES_PG: urls.connector_writer, NS_MANAGEMENT_SESSIONS_PG: urls.management_issuer } };
  docs.ui = { version: 2, registry: { connectionEnv: 'NS_UI_REGISTRY_PG', namespace: ns.registry, maxTenants: 10000, refreshMs: 2000 }, theme: 'default' };
  docs.uiEnvironment = { NS_UI_REGISTRY_PG: urls.ui_registry };
  delete docs.admission;
  return docs;
}
// NS_FEED_SWEEP_MS (off when empty): the period in which the healthy lost-hint rotation of the
// evaluator and realtime feed consumers covers the whole roster (core changeFeed.sweepMs). Needs a
// core that accepts the field; 1000..30000 here, because the evaluator's evaluation-gap alert bound
// (60 s by default) must hold two sweeps and a tick is 1000 ms.
function feedSweep (source = process.env) {
  const raw = source.NS_FEED_SWEEP_MS;
  if (raw === undefined || raw === '') return {};
  if (!/^[1-9][0-9]{3,4}$/.test(raw) || Number(raw) < 1000 || Number(raw) > 30000) throw Object.assign(new Error('NS_FEED_SWEEP_MS must be 1000..30000'), { code: 'FEED_SWEEP_INVALID' });
  return { sweepMs: Number(raw) };
}
// Explicit per-deployment consumer heartbeat horizon for bounded experiments.
// Default remains 5000; this does not change reader cadence or any role clock.
function feedHeartbeat (source = process.env) {
  const raw = source.NS_FEED_HEARTBEAT_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 5000;
  if (typeof raw !== 'string' || !/^[1-9][0-9]{2,5}$/.test(raw) || Number(raw) < 100 || Number(raw) > 300000) throw Object.assign(new Error('NS_FEED_HEARTBEAT_TIMEOUT_MS must be 100..300000'), { code: 'FEED_HEARTBEAT_INVALID' });
  return Number(raw);
}
module.exports = { expand, provisioningNamespaces, checkpoints, leaseSessions, feedSweep, feedHeartbeat };
