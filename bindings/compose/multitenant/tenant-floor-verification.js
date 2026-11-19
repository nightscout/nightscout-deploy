'use strict';

// Operator-to-admin postcondition. No DATA or proof writer credential leaves
// admin: restore waits for this private operation before activating the tenant.
const fail = code => Object.assign(new Error(code), { code });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function selection (value) {
  if (!value || Object.keys(value).sort().join(',') !== 'adminOrigin,namespace' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(value.namespace || '') || ['public', 'information_schema'].includes(value.namespace) || value.namespace.startsWith('pg_')) throw fail('COMPOSE_OPERATOR_FLOOR_VERIFICATION_REQUIRED');
  let origin;
  try { origin = new URL(value.adminOrigin); } catch { throw fail('COMPOSE_OPERATOR_FLOOR_VERIFICATION_REQUIRED'); }
  if (origin.origin !== value.adminOrigin || origin.protocol !== 'http:' || origin.username || origin.password ||
      !['admin', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw fail('COMPOSE_OPERATOR_FLOOR_VERIFICATION_REQUIRED');
  return { namespace: value.namespace, adminOrigin: origin.origin };
}
async function verify (config, tenant, { request = require('./prime').request } = {}) {
  const selected = selection(config.floorVerification);
  if (!UUID.test(tenant || '')) throw fail('COMPOSE_OPERATOR_FLOOR_VERIFICATION_REQUIRED');
  const response = await request(selected.adminOrigin, '/v1/platform-verification/tenants/' + tenant,
    { method: 'POST', body: {}, timeoutMs: 60000, classification: 'platform-verify' });
  if (response.status !== 200) throw fail('COMPOSE_OPERATOR_FLOOR_VERIFICATION_REFUSED');
  const value = response.body;
  if (value?.version !== 1 || value.namespace !== selected.namespace || value.tenant !== tenant || value.status !== 'verified' ||
      typeof value.generation !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.generation)) throw fail('COMPOSE_OPERATOR_FLOOR_VERIFICATION_RECEIPT');
  return value;
}
module.exports = { selection, verify };
