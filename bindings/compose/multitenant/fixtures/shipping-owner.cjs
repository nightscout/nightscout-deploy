'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Runs in the shipping primer on the private Compose network. The helper
// reports only the result. The management bearer stays inside the primer.
async function qualify({tenant, adminOrigin, request, session, requestId, phase}) {
  assert.ok(['before', 'after'].includes(phase));
  assert.match(requestId, /^[0-9a-f-]{36}$/);
  assert.ok(['primer', 'renew'].includes(session));
  // Management sessions live at most 600 s and are not kept in the roster:
  // both phases issue one from the owner subject (same request id: same session).
  let token;
  {
    const issued = await request(adminOrigin, '/v1/tenants/' + tenant.id + '/management-sessions', {
      method: 'POST', classification: 'management-session-create', headers: {'idempotency-key': requestId},
      body: {subjectId: tenant.ownerSubject, requestId}
    });
    assert.ok([200, 201].includes(issued.status) && typeof issued.body.token === 'string', 'owner session issuance refused');
    token = issued.body.token;
  }
  const name = 'restore-' + phase + '-' + requestId;
  const result = await request('http://tenant-admin:1341', '/api/v2/authorization/roles', {
    method: 'POST', headers: {host: tenant.host, authorization: 'Bearer ' + token},
    body: {name, permissions: []}
  });
  assert.equal(result.status, 200, 'private owner role creation refused');
  assert.equal(result.body.name, name);
  assert.deepEqual(result.body.permissions, []);
}

if (require.main === module) {
  const primer = require('/opt/app/deploy/multitenant/prime');
  const directory = process.env.NS_PRIMER_STATE;
  const [phase, session, requestId] = process.argv.slice(2);
  const config = primer.load(path.join(directory, 'config.json'));
  const [tenant] = JSON.parse(fs.readFileSync(path.join(directory, 'tenants.json'))).tenants;
  qualify({tenant, adminOrigin: config.adminOrigin, request: primer.request, session, requestId, phase})
    .then(() => console.log('SHIPPING_OWNER_ROLE_CREATED'))
    .catch(error => { console.error('SHIPPING_OWNER_REFUSED', Number.isInteger(error.actual) ? error.actual : 'unavailable'); process.exitCode = 1; });
}

module.exports = {qualify};
