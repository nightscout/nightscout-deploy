'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { waitForTenant } = require('./prime');
async function upstream(answer, run) {
  let calls = 0;
  const methods = [];
  const server = http.createServer((req, res) => {
    methods.push(req.method);
    const reply = answer(++calls);
    res.writeHead(reply.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run('http://127.0.0.1:' + server.address().port, () => calls, methods); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
test('cold tenant GET retries only explicit warming until the actual role list is ready', async () => {
  await upstream(count => count < 3 ? { status: 503, body: { error: 'TENANT_WARMING' } } : { status: 200, body: [] }, async (origin, count, methods) => {
    assert.deepEqual(await waitForTenant(origin, {}, { timeoutMs: 5000, pollMs: 1 }), []);
    assert.equal(count(), 3); assert.deepEqual(methods, ['GET','GET','GET']);
  });
});
test('unknown unavailability and authority refusals stop without a retry', async () => {
  for (const status of [403,503]) await upstream(() => ({ status, body: { error: 'ACTIVITY_STATE_UNAVAILABLE' } }), async (origin, count) => {
    await assert.rejects(waitForTenant(origin, {}), { code: 'PRIMER_DATA_API_REFUSED_' + status }); assert.equal(count(), 1);
  });
});
test('persistent warming reaches its deadline without a later role-list request', async () => {
  let at = 0;
  await upstream(count => count <= 4 ? { status: 503, body: { error: 'TENANT_WARMING' } } : { status: 422, body: {} }, async (origin, count) => {
    await assert.rejects(waitForTenant(origin, {}, { timeoutMs: 4000, pollMs: 1000, now: () => at, delay: async ms => { at += ms; } }), { code: 'PRIMER_TENANT_WARM_TIMEOUT' });
    assert.equal(at, 4000); assert.equal(count(), 4);
  });
});


test('refusal diagnostics retain fixed class and safe code without echoing private values', () => {
  const { refusal, requestClass } = require('./prime');
  const error = refusal({ status: 503, body: { error: 'TENANT_WARM_FAILED', token: 'private-canary' } }, requestClass('/api/v2/authorization/subjects', 'POST'));
  assert.equal(error.requestClass, 'subjects-create');
  assert.equal(error.responseError, 'TENANT_WARM_FAILED');
  assert.equal(JSON.stringify(error).includes('private-canary'), false);
  const opaque = refusal({ status: 503, body: { error: 'PRIVATE_CANARY' } }, requestClass('/private-canary/path', 'POST'));
  assert.equal(opaque.requestClass, 'other-data-create');
  assert.equal(opaque.responseError, 'UNCLASSIFIED');
  assert.equal(JSON.stringify(opaque).includes('CANARY'), false);
});


test('fixed published storage and authority refusals preserve class without body details', () => {
  const { refusal, requestClass } = require('./prime');
  for (const code of ['STORAGE_UNAVAILABLE', 'AUTHORITY_UNAVAILABLE', 'SUBJECT_ADMIN_STORE_UNAVAILABLE', 'SUBJECT_ADMIN_STORE_UNSAFE']) {
    const result = refusal({ status: 503, body: { error: code, message: 'private-canary', token: 'private-token' } }, requestClass('/api/v1/entries', 'POST'));
    assert.equal(result.responseError, code);
    assert.equal(result.requestClass, 'entries-create');
    assert.equal(JSON.stringify(result).includes('private-'), false);
  }
  assert.equal(refusal({ status: 503, body: { error: 'STORAGE_UNAVAILABLE private-canary' } }, 'entries-create').responseError, 'UNCLASSIFIED');
});

test('lab provisioning generates its requested cohort from a tenant-free document', async () => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { provision, load } = require('./prime');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-lab-client-'));
  const batches = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.url, '/v1/tenants/batch');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { tenants } = JSON.parse(Buffer.concat(chunks));
    batches.push(tenants);
    res.end(JSON.stringify({ results: tenants.map(({ id }) => ({ id, outcome: 'created', rootSecret: 'synthetic' })) }));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port, file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({version: 1, adminOrigin: origin, apiOrigin: origin, ownerConsumer: 'test'}));
    await provision(load(file), dir, { tenantCount: '101' });
    assert.deepEqual(batches.map(rows => rows.length), [100, 1]);
    assert.equal(new Set(batches.flat().map(row => row.id)).size, 101);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'provisioned.json'))).length, 101);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
