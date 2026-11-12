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
