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
  docs.admin.config.platformVerification = { namespace, maxAgeMs: 300000, refreshMs: 60000, connectionEnv: 'NS_PLATFORM_VERIFY_PG',
    targets: ROLES.map(role => ({ role, configFile: BASE + '/' + role + '.config.json',
      environmentFile: BASE + '/' + role + '.env.json', operationConfigFile: BASE + '/' + role + '.operation.json' })) };
  docs.admin.environment.NS_PLATFORM_VERIFY_PG = urls.platform_verifier;
  return docs;
}
function selection(docs) {
  const { namespace, maxAgeMs, refreshMs } = docs.admin.config.platformVerification;
  return { namespace, maxAgeMs, refreshMs, roles: [...ROLES] };
}
async function install(admin, layout) {
  return require('../../lib/server/serve/platform-verification').install(admin, {
    namespace: layout.prefix + '_platform_verification', writer: layout.roles.platform_verifier,
    readers: [layout.roles.api, layout.roles.readiness, layout.roles.evaluator, layout.roles.realtime]
  });
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
module.exports = { ROLES, BASE, documents, selection, install, files };
