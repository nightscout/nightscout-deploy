'use strict';

// Platform verification is an admin capability. Orchestration receives only
// the private HTTP endpoint; database credentials remain in admin's own mount.
const path = require('node:path');
const ROLES = Object.freeze(['api', 'evaluator', 'realtime']);
const BASE = '/run/ns-config/verification';
function documents(docs, layout, urls) {
  const namespace = layout.prefix + '_platform_verification';
  for (const [name, config] of Object.entries(docs.configs)) {
    const role = name.split('-')[0];
    if (ROLES.includes(role)) config.platformVerification = { namespace, role };
  }
  // The proof has no lease: the pre-start step issues it once and serving
  // roles check it at start (core decision platform-application-boundary).
  docs.admin.config.platformVerification = { namespace, connectionEnv: 'NS_PLATFORM_VERIFY_PG',
    targets: ROLES.map(role => ({ role, configFile: BASE + '/' + role + '.config.json',
      environmentFile: BASE + '/' + role + '.env.json', operationConfigFile: BASE + '/' + role + '.operation.json' })) };
  docs.admin.environment.NS_PLATFORM_VERIFY_PG = urls.platform_verifier;
  return docs;
}
function selection(docs) {
  const { namespace } = docs.admin.config.platformVerification;
  return { namespace, roles: [...ROLES] };
}
function platformRoles(layout) {
  return {
    namespace: layout.prefix + '_platform_verification', writer: layout.roles.platform_verifier,
    readers: [layout.roles.api, layout.roles.readiness, layout.roles.evaluator, layout.roles.realtime],
    floorReaders: [layout.roles.api]
  };
}
async function install(admin, layout) {
  await require('../../lib/server/serve/platform-verification').install(admin, platformRoles(layout));
  await floorEnumeration(admin, layout);
}
async function upgrade(admin, layout) {
  const result = await require('../../lib/server/serve/platform-verification').upgrade(admin, platformRoles(layout));
  await floorEnumeration(admin, layout);
  return result;
}
async function main(args) {
  if (args.length !== 1 || args[0] !== 'upgrade-tenant-floor-v1') throw new Error('PLATFORM_UPGRADE_USAGE');
  const { pg } = require('./bootstrap').input();
  const layout = require('./config').layout();
  const admin = new (require('pg').Client)({ connectionString: pg.toString(), connectionTimeoutMillis: 10000, statement_timeout: 10000 });
  try {
    await admin.connect();
    return await upgrade(admin, layout);
  } finally { await admin.end(); }
}
if (require.main === module) main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result)), error => {
  console.error(JSON.stringify(require('./bootstrap').report(error)));
  process.exitCode = 1;
});
async function floorEnumeration(admin, layout) {
  // Admin enumerates tenant IDs for migration postconditions; serving API
  // retains its existing host resolver authority and cannot enumerate.
  const quote = name => '"' + name + '"';
  const registry = quote(layout.namespaces.registry), writer = quote(layout.roles.platform_verifier);
  await admin.query('GRANT USAGE ON SCHEMA ' + registry + ' TO ' + writer);
  await admin.query('GRANT EXECUTE ON FUNCTION ' + registry + '.tenant_registry_revision(),' + registry + '.tenant_registry_tenants(uuid,integer) TO ' + writer);
}
function files({ output, docs, writePrivate, own, compact }) {
  for (const role of ROLES) if (!docs.configs[role] || !docs.operations[role] || !docs.environments[role]) {
    throw Object.assign(new Error('PLATFORM_VERIFICATION_CONTEXT_REQUIRED'), { code: 'PLATFORM_VERIFICATION_CONTEXT_REQUIRED' });
  }
  for (const role of ROLES) {
    const target = path.join(output, 'admin/verification', role);
    const environment = Object.fromEntries(Object.entries(docs.environments[role]).map(([key, value]) => [key,
      typeof value === 'string' ? value.replaceAll('/run/ns-config/config.json', BASE + '/' + role + '.config.json')
        .replaceAll('/run/ns-config/evaluator-metadata.json', BASE + '/evaluator.config.json')
        .replaceAll('/run/ns-config/operation.json', BASE + '/' + role + '.operation.json') : value]));
    writePrivate(target + '.config.json', docs.configs[role], own, compact);
    writePrivate(target + '.operation.json', docs.operations[role], own, compact);
    writePrivate(target + '.env.json', environment, own, compact);
  }
}
module.exports = { ROLES, BASE, documents, selection, install, upgrade, files };
