'use strict';
// The lab primer (decision one-call-usable-provisioning) against a stub admin
// listener: one batch call per 100 tenants, the roster written from the
// responses, no tenant DATA API call. Synthetic ids, hosts and tokens only.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { provision, prime, diagnostic, BATCH } = require('./prime');

const id = n => '10000000-0000-4000-8000-' + String(n + 1).padStart(12, '0');
const seed = count => Array.from({ length: count }, (_, n) => ({ id: id(n), hosts: ['tenant-' + n + '.example.test'], issueRootSecret: true }));
async function admin(answer, run) {
  const calls = []; let active = 0, peak = 0;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const call = { method: req.method, path: req.url, body: JSON.parse(raw || 'null') }; calls.push(call);
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    const { status = 200, body } = answer(call); active--;
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-primer-'));
  try { await run({ adminOrigin: 'http://127.0.0.1:' + server.address().port + '/', ownerConsumer: 'lab-owner', version: 1 }, dir, calls, () => peak); }
  finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
}
// A synthetic, unsigned JWT-shaped placeholder; the primer never parses it.
const jwt = spec => 'eyJ0.synthetic-' + spec.id.slice(-12) + '.sig';
const created = spec => ({ id: spec.id, outcome: 'created', rootSecret: 'r'.repeat(48),
  bootstrap: { ownerSubject: 'o' + spec.id.slice(-12), subject: 's' + spec.id.slice(-12), accessToken: 'syntheticd-' + crypto.createHash('sha1').update(spec.id).digest('hex').slice(0, 16),
    jwt: jwt(spec), jwtExpiresAt: 1800000000 } });
const roster = dir => JSON.parse(fs.readFileSync(path.join(dir, 'tenants.json'), 'utf8'));

test('one batch call per 100 tenants with the bootstrap; the roster carries id, host and data token; a re-run sends nothing', async () => {
  await admin(call => ({ body: { results: call.body.tenants.map(created) } }), async (config, dir, calls, peak) => {
    const result = await provision({ ...config, seed: seed(250) }, dir, { concurrency: 2 });
    assert.deepEqual(result, { state: 'synthetic-tenants-usable', tenants: 250 });
    assert.deepEqual(calls.map(call => [call.method, call.path, call.body.tenants.length]), [['POST', '/v1/tenants/batch', BATCH], ['POST', '/v1/tenants/batch', BATCH], ['POST', '/v1/tenants/batch', 50]]);
    assert.ok(peak() <= 2, 'bounded batch concurrency');
    assert.deepEqual(calls[0].body.tenants[0].bootstrap, { owner: { consumer: 'lab-owner', name: 'Synthetic demo owner' },
      subject: { name: 'Synthetic demo uploader', role: { name: 'demo', permissions: ['api:*:read', 'api:*:create,update,delete', 'notifications:*:ack'] } } });
    const saved = roster(dir);
    assert.equal(saved.version, 1);
    assert.deepEqual(saved.tenants.map(row => row.id), seed(250).map(row => row.id), 'seed order');
    assert.deepEqual(Object.keys(saved.tenants[0]).sort(), ['dataToken', 'host', 'hosts', 'id', 'jwt', 'jwtExpiresAt', 'ownerSubject', 'rootSecret', 'subject']);
    assert.equal(saved.tenants[0].host, 'tenant-0.example.test'); assert.match(saved.tenants[0].dataToken, /^syntheticd-/);
    assert.equal(saved.tenants[0].jwt, jwt(seed(1)[0])); assert.equal(saved.tenants[0].jwtExpiresAt, 1800000000);
    assert.equal(fs.statSync(path.join(dir, 'tenants.json')).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['tenants.json'], 'no other custody file');
    assert.deepEqual(await prime({ ...config, seed: seed(250) }, dir), result);
    assert.equal(calls.length, 3, 'a completed roster re-runs with no traffic');
  });
});

test('a lost response is recovered: an existing tenant answered with a data JWT is saved and usable', async () => {
  await admin(call => ({ body: { results: call.body.tenants.map((spec, n) => n === 1
    ? { id: spec.id, outcome: 'existing', bootstrap: { ownerSubject: 'o', subject: 's', jwt: jwt(spec), jwtExpiresAt: 1800000000 } } : created(spec)) } }),
  async (config, dir) => {
    assert.deepEqual(await provision({ ...config, seed: seed(3) }, dir), { state: 'synthetic-tenants-usable', tenants: 3 });
    const row = roster(dir).tenants[1];
    assert.deepEqual(Object.keys(row).sort(), ['host', 'hosts', 'id', 'jwt', 'jwtExpiresAt', 'ownerSubject', 'subject']);
    assert.equal(row.jwt, jwt(seed(3)[1]));
  });
});

test('a tenant answered existing with no credential is reported, never re-issued; peers are saved', async () => {
  await admin(call => ({ body: { results: call.body.tenants.map((spec, n) => n === 1 ? { id: spec.id, outcome: 'existing', bootstrap: { ownerSubject: 'o', subject: 's' } } : created(spec)) } }),
    async (config, dir) => {
      await assert.rejects(provision({ ...config, seed: seed(3) }, dir), error => {
        assert.deepEqual(diagnostic(error), { error: 'PRIMER_CREDENTIAL_NOT_RETURNED', tenants: 1 }); return true;
      });
      assert.deepEqual(roster(dir).tenants.map(row => row.id), [id(0), id(2)]);
    });
});

test('refused tenants stop the run with their codes; created peers are saved; diagnostics carry no credential or host', async () => {
  await admin(call => ({ body: { results: call.body.tenants.map((spec, n) => n === 0 ? { id: spec.id, outcome: 'refused', code: 'TENANT_PROVISION_CONFLICT' } : created(spec)) } }),
    async (config, dir) => {
      await assert.rejects(provision({ ...config, seed: seed(2) }, dir), error => {
        const shown = diagnostic(error);
        assert.deepEqual(shown, { error: 'PRIMER_PROVISION_REFUSED', tenants: 1, codes: { TENANT_PROVISION_CONFLICT: 1 } });
        assert.doesNotMatch(JSON.stringify(shown), /example\.test|syntheticd|10000000/); return true;
      });
      assert.deepEqual(roster(dir).tenants.map(row => row.id), [id(1)]);
    });
});

test('a whole-batch refusal stops before writing a roster', async () => {
  await admin(() => ({ status: 422, body: { code: 'TENANT_PROVISION_BOOTSTRAP_INVALID' } }), async (config, dir) => {
    await assert.rejects(provision({ ...config, seed: seed(2) }, dir), { code: 'PRIMER_PROVISION_FAILED' });
    assert.equal(fs.existsSync(path.join(dir, 'tenants.json')), false);
  });
});
