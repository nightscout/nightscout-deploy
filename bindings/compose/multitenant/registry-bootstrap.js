'use strict';

// Vault infrastructure only. Tenant rows and keys are provisioned later through the admin REST
// API. The role tokens carry the ids seeded before apply (credentials.js), so the documents
// rendered before apply already name them; nothing is written back for a role to read.
async function finish ({ request, rootToken, layout: l, tokens }) {
  await request('sys/mounts/' + l.mount, { type: 'transit' }, rootToken);
  const rule = (route, caps) => 'path "' + l.mount + '/' + route + '" { capabilities = [' + caps.map(cap => '"' + cap + '"').join(',') + '] }';
  const policies = {
    api: [rule('decrypt/tenant-data-*', ['update']), rule('hmac/tenant-signing-*', ['update']), rule('verify/tenant-signing-*', ['update']), rule('sign/tenant-access-*', ['update'])],
    'owner-credentials': [rule('decrypt/tenant-data-*', ['update'])],
    'management-issuer': [rule('keys/tenant-management-*', ['read']), rule('sign/tenant-management-*', ['update'])],
    provisioner: [rule('keys/tenant-*', ['create', 'read', 'update']), rule('encrypt/tenant-data-*', ['update'])],
  };
  for (const [name, rules] of Object.entries(policies)) {
    await request('sys/policies/acl/' + l.prefix + '_' + name, { policy: rules.join('\n') }, rootToken);
    // A root caller may choose the token id (Vault auth/token/create `id`).
    await request('auth/token/create', { id: tokens[name], policies: [l.prefix + '_' + name], no_default_policy: true, renewable: true, ttl: '24h' }, rootToken);
  }
  return { state: 'synthetic-infrastructure-ready' };
}
module.exports = { finish };
