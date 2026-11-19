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
const { provisioningNamespaces } = require('../../lib/server/ordinary-deployment-grants');
function checkpoints(docs, ns) {
  const document=docs.configs.evaluator;
  const replay=require('../../lib/storage/postgres-durable-replay')({connection:{query(){throw new Error('CONSTRUCTOR_ONLY');},snapshotTransaction(){throw new Error('CONSTRUCTOR_ONLY');}},checkpointTable:ns.eval_checkpoint+'.tenant_consumer_checkpoint',clockTable:ns.clock+'.tenant_write_clock',consumer:document.consumer,domains:Object.fromEntries(clinical.map(name=>[name,ns[name]+'.'+name])),projectionVersion:'clinical-current-rows-v1',pageSize:document.pageSize,maxRows:document.maxRows});
  const output=require('../../lib/pgstream/checkpoint').create({typed:true,connection:{},namespace:ns.eval_checkpoint,consumer:document.consumer,maxBytes:document.maxBytes*2,timeIntervalMs:document.timeIntervalMs});
  const rows=[{namespace:ns.rt_checkpoint,consumer:docs.configs.realtime.consumer,digest:require('../../lib/pgstream/realtime-receipt').contractDigest(ns.rt_checkpoint,docs.configs.realtime.consumer)},
    {namespace:ns.eval_checkpoint,consumer:document.consumer,digest:replay.digest},{namespace:ns.eval_checkpoint,consumer:output.consumer,digest:output.digest}];
  return rows;
}
function expand(docs, { layout, urls, vaultAddress }) {
  const ns = layout.namespaces, registry = { namespace: ns.registry, refreshMs: 2000 };
  const settings = { connectionEnv: 'NS_DISPLAY_PG', namespaces: { settings: ns.display_settings, operatorPolicy: ns.operator_policy } };
  const activity = { connectionEnv: 'NS_ACTIVITY_PG', namespace: ns.control };
  for (const [role, config] of Object.entries(docs.configs)) {
    config.registry = { ...registry };
    if (role === 'api' || role === 'evaluator' || role === 'realtime') config.tenantSettings = settings;
    if (role === 'api') config.activity = { namespace: ns.control };
    if (role === 'evaluator') config.activity = activity;
    if(role==='realtime')config.activity={namespace:ns.control};
    if (role === 'api') {
      config.localDataAuthentication = 'node';
      config.vault = { address: vaultAddress, mount: layout.mount, timeoutMs: 5000, tokenFile: '/run/ns-config/vault-token' };
    }
    if (role === 'tenant-admin') {
      config.ownerCredentials={connectionEnv:'NS_OWNER_CREDENTIALS_PG',namespace:ns.secrets,vault:{address:vaultAddress,mount:layout.mount,timeoutMs:5000,tokenFile:'/run/ns-config/vault-token'}};
    }
    if (role === 'evaluator' || role === 'realtime') {
      config.trustedWorker = { activity: ns.control, clock: ns.clock, settings: ns.display_settings, operatorPolicy: ns.operator_policy };
    }
    const env = docs.environments[role];
    if (role === 'api' || role === 'evaluator' || role === 'realtime') env.NS_DISPLAY_PG = urls.display_reader;
    if (role === 'evaluator') env.NS_ACTIVITY_PG = urls.activity_reader;
    if (role === 'api') delete env.NS_ACTIVITY_PG;
    if(role==='evaluator')env.NS_STREAM_RECOVERY_PG=urls.pgstream;
    if(role==='tenant-admin')env.NS_OWNER_CREDENTIALS_PG=urls.owner_credentials;
    docs.operations[role].leaseSessions = leaseSessions(); docs.operations[role].registry = { namespace: ns.registry };
  }
  require('./pgstream').configure(docs,layout);
  // Recompute manifest coverage from the selected product configuration.
  const protectedNamespaces = require('../../lib/server/serve/role-topology').protectedNamespaces;
  const participants = Object.entries(docs.configs).map(([role, config]) => ({ id: role, roles: [role],
    namespaces: [...new Set([...protectedNamespaces(config), ...(role === 'api' ? [ns.outbox] : [])])].filter(name => name !== ns.control).sort(), maxMessageBytes: 1048576, timeoutMs: 10000 }));
  for (const value of Object.values(docs.operations)) value.participants = participants;
  docs.remote = participants.map(peer => ({ id: peer.id, roles: peer.roles, namespaces: peer.namespaces,
    endpoint: { socketPath: '/run/ns-ipc/' + peer.id + '.sock', maxBytes: peer.maxMessageBytes, timeoutMs: peer.timeoutMs } }));
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
  docs.ui = { version: 2, registry: { connectionEnv: 'NS_UI_REGISTRY_PG', namespace: ns.registry, refreshMs: 2000 }, theme: 'default' };
  docs.uiEnvironment = { NS_UI_REGISTRY_PG: urls.ui_registry };
  return docs;
}
module.exports = { expand, provisioningNamespaces, checkpoints, leaseSessions };
