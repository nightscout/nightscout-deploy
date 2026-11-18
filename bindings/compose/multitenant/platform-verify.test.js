'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawn } = require('node:child_process');
const verifierPath = process.env.PLATFORM_VERIFY_MODULE || path.join(__dirname, 'platform-verify.js');
const { verify, selection } = require(verifierPath);
const selected = () => ({ namespace: 'synthetic_platform_verification', roles: ['api', 'evaluator', 'realtime'] });
const good = () => ({ version: 1, status: 'verified', namespace: 'synthetic_platform_verification', roles: ['api', 'evaluator', 'realtime'].map(role => ({ role, generation: 'a'.repeat(64) })) });
async function upstream(reply, run) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push({ method: req.method, route: req.url, headers: req.headers, body: JSON.parse(raw) });
    const value = reply(calls.length); res.writeHead(value.status || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run({ adminOrigin: 'http://127.0.0.1:' + server.address().port, platformVerification: selected() }, calls); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
test('private verification job sends only an empty operation and retains bound generation receipt', async () => {
  await upstream(() => ({ body: good() }), async (config, calls) => {
    const receipt = await verify(config);
    assert.equal(receipt.status, 'verified'); assert.equal(receipt.credentialBoundary, 'admin-private-api');
    assert.match(receipt.selectionSha256, /^[a-f0-9]{64}$/); assert.equal(receipt.roles.length, 3);
    assert.equal(calls.length, 1); assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].route, '/v1/platform-verification'); assert.deepEqual(calls[0].body, {});
    assert(!calls[0].headers.authorization); assert(!calls[0].headers['api-secret']);
  });
});
test('failed verification stops without retry; foreign, missing and duplicate generations refuse', async () => {
  await upstream(() => ({ status: 503, body: { error: 'PRIVATE_SENTINEL' } }), async (config, calls) => {
    await assert.rejects(verify(config), { code: 'PLATFORM_VERIFICATION_REFUSED_503' }); assert.equal(calls.length, 1);
  });
  for (const change of [v => { v.roles.pop(); }, v => { v.roles[0].generation = 'old'; }, v => { v.roles[0].role = 'foreign'; }, v => { v.roles[0] = v.roles[1]; }, v => { v.status = 'pending'; }, v => { v.roles[0] = null; }, v => { v.namespace = 'foreign'; }]) {
    const bad = good(); change(bad);
    await upstream(() => ({ body: bad }), async config => { await assert.rejects(verify(config), { code: 'PLATFORM_VERIFICATION_RECEIPT_INVALID' }); });
  }
  await upstream(() => ({ body: good() }), async config => { assert.equal((await verify(config)).status, 'verified'); });
});
test('actual client child has no database credentials and writes only a successful receipt', async () => {
  await upstream(() => ({ body: good() }), async config => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-platform-job-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
    try {
      const child = spawn(process.execPath, [verifierPath], { env: { PATH: process.env.PATH, NS_PRIMER_STATE: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = ''; child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { err += c; });
      const status = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
      assert.equal(status, 0, err); assert.equal(err, '');
      assert.deepEqual(JSON.parse(out), JSON.parse(fs.readFileSync(path.join(dir, 'platform-verification.json'))));
      assert.equal(fs.statSync(path.join(dir, 'platform-verification.json')).mode & 0o777, 0o600);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
test('verification refuses credentials in endpoint configuration before making a request', () => {
  for (const adminOrigin of ['http://user:private@example.test/', 'https://example.test/', 'http://example.test/private', 'http://example.test/?private=1']) assert.throws(() => selection({ adminOrigin }), { code: 'PLATFORM_VERIFICATION_ORIGIN_INVALID' });
});

test('selection is the namespace and every serving role, with no lease, before issuing an operation', () => {
  const base = { adminOrigin: 'http://example.test/', platformVerification: selected() };
  assert.deepEqual(selection(base).roles, ['api', 'evaluator', 'realtime']);
  // The retired lease fields are refused like any other unknown field.
  for (const value of [undefined, { ...selected(), refreshMs: 60000 }, { ...selected(), maxAgeMs: 300000 }, { ...selected(), roles: ['api', 'realtime'] }]) {
    assert.throws(() => selection({ ...base, platformVerification: value }), { code: 'PLATFORM_VERIFICATION_SELECTION_INVALID' });
  }
});
