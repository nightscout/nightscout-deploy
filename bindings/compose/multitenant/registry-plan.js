'use strict';

// The runtime roster and keys come from the registry. The seed remains input
// to the operator provisioning adapter; it is not copied into role authority.
const clinical = ['entries','treatments','devicestatus','profile','food','activity'];
function provisioningNamespaces(ns) {
  return { registry: ns.registry, legacy: ns.legacy, secrets: ns.secrets, authorization: ns.authorization,
    access: ns.access, clock: ns.clock, control: ns.control, settings: ns.display_settings, operatorPolicy: ns.operator_policy };
}
function checkpoints(docs, ns) {
  return [['rt_checkpoint','realtime','realtime-current-rows-v1'],['eval_checkpoint','evaluator','clinical-current-rows-v1']].map(([kind, role, projectionVersion]) => {
    const document = docs.configs[role];
    const replay = require('../../lib/storage/postgres-durable-replay')({ connection: { query() { throw new Error('CONSTRUCTOR_ONLY'); }, snapshotTransaction() { throw new Error('CONSTRUCTOR_ONLY'); } },
      checkpointTable: ns[kind] + '.tenant_consumer_checkpoint', clockTable: ns.clock + '.tenant_write_clock', consumer: document.consumer,
      domains: Object.fromEntries(clinical.map(name => [name, ns[name] + '.' + name])), projectionVersion, pageSize: document.pageSize, maxRows: document.maxRows });
    return { namespace: ns[kind], consumer: document.consumer, digest: replay.digest };
  });
}
function expand(docs, { layout, urls, vaultAddress }) {
  const ns = layout.namespaces, registry = { namespace: ns.registry, maxTenants: 10000, refreshMs: 2000 };
  const settings = { connectionEnv: 'NS_DISPLAY_PG', namespaces: { settings: ns.display_settings, operatorPolicy: ns.operator_policy } };
  const activity = { connectionEnv: 'NS_ACTIVITY_PG', namespace: ns.control };
  for (const [role, config] of Object.entries(docs.configs)) {
    delete config.tenants; config.registry = { ...registry };
    if (role === 'api' || role === 'evaluator') config.tenantSettings = settings;
    if (role === 'api' || role === 'evaluator' || role === 'realtime') config.activity = activity;
    if (role === 'api') {
      config.vault = { address: vaultAddress, mount: layout.mount, timeoutMs: 5000, tokenFile: '/run/ns-config/vault-token' };
      delete config.accessTokens.keys;
      delete config.socketForwarding.admissionFileEnv;
      config.socketForwarding.maxTenants = 10000;
    }
    if (role === 'tenant-admin') delete config.management.keys;
    if (role === 'evaluator' || role === 'realtime') config.maxTenants = 10000;
    if (role === 'realtime') delete config.admissionFileEnv;
    const env = docs.environments[role];
    for (const name of Object.keys(env)) if (/^NS_VAULT_\d+$/.test(name) || name === 'NS_ADMISSION_FILE') delete env[name];
    if (role === 'api' || role === 'evaluator') env.NS_DISPLAY_PG = urls.display_reader;
    if (role === 'api' || role === 'evaluator' || role === 'realtime') env.NS_ACTIVITY_PG = urls.activity_reader;
    delete docs.operations[role].locks; docs.operations[role].registry = { namespace: ns.registry };
  }
  for (const role of ['evaluator','realtime']) docs.configs[role].changeFeed = { connectionEnv: role === 'evaluator' ? 'NS_EVALUATOR_PG' : 'NS_REALTIME_PG', channel: layout.prefix + '_changes', pageSize: 256, degradedPages: 4, intervalMs: 1000, heartbeatTimeoutMs: 5000 };
  docs.feed = { config: { connectionEnv: 'NS_FEED_PG', namespace: ns.feed, clockNamespace: ns.clock, activityNamespace: ns.control,
    slot: layout.prefix + '_feed_slot', publication: layout.prefix + '_feed_publication', owner: layout.feedOwner, channel: layout.prefix + '_changes',
    pollMs: 50, heartbeatMs: 1000, targetChanges: 128, maxMessages: 10000, maxBytes: 1048576, statementTimeoutMs: 2000, rssRefuseBytes: 268435456 },
    environment: { MULTITENANT_FEED_CONFIG: '/run/ns-config/config.json', NS_FEED_PG: urls.feed_reader } };
  // Recompute manifest coverage from the selected product configuration.
  const protectedNamespaces = require('../../lib/server/serve/operation-cohort').protectedNamespaces;
  const participants = Object.entries(docs.configs).map(([role, config]) => ({ id: role, roles: [role],
    namespaces: [...new Set([...protectedNamespaces(config), ...(role === 'api' ? [ns.outbox] : [])])].sort(), maxMessageBytes: 1048576, timeoutMs: 10000 }));
  for (const value of Object.values(docs.operations)) value.participants = participants;
  docs.remote = participants.map(peer => ({ id: peer.id, roles: peer.roles, namespaces: peer.namespaces,
    endpoint: { socketPath: '/run/ns-ipc/' + peer.id + '.sock', maxBytes: peer.maxMessageBytes, timeoutMs: peer.timeoutMs } }));
  docs.locks = docs.locks.map(row => ({ tenant: row.tenant, key: require('../../lib/tenant-registry/rules').lockKey(row.tenant) }));
  docs.admin = { config: { version: 1, maxBytes: 1048576, timeoutMs: 60000,
    provisioning: { connectionEnv: 'NS_PROVISIONER_PG', namespaces: provisioningNamespaces(ns), checkpoints: checkpoints(docs, ns),
      vault: { address: vaultAddress, mount: layout.mount, tokenFile: '/run/ns-config/vault-token', timeoutMs: 10000 },
      ownerPolicy: { catalogue: ['*'] }, operator: { principal: 'compose-operator', consumer: 'compose-provisioning' } } },
    environment: { ADMIN_HOSTNAME: '0.0.0.0', ADMIN_PORT: '1342', MULTITENANT_ADMIN_CONFIG: '/run/ns-config/config.json', NS_PROVISIONER_PG: urls.provisioner } };
  delete docs.admission;
  return docs;
}
module.exports = { expand, provisioningNamespaces, checkpoints };
