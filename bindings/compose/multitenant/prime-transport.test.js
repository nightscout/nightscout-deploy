'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), net = require('node:net'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const primerPath = process.env.PRIMER_MODULE || path.join(__dirname, 'prime.js');
const { request, waitForTenant, diagnostic, connectionFailure } = require(primerPath);
async function upstream(answer, run) {
  let calls = 0;
  const server = http.createServer((req, res) => answer(req, res, ++calls));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run('http://127.0.0.1:' + server.address().port, () => calls); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
test('actual cold-read reset reports its typed cause and stops after one request', async () => {
  await upstream((req, res) => res.destroy(), async (origin, calls) => {
    await assert.rejects(waitForTenant(origin, { 'api-secret': 'synthetic-private-sentinel' }), error => {
      assert.deepEqual(diagnostic(error), { error: 'PRIMER_CONNECTION_FAILED', requestClass: 'roles-ready', connectionCause: 'ECONNRESET' });
      assert.doesNotMatch(JSON.stringify(diagnostic(error)), /127\.0\.0\.1|synthetic-private|authorization/); return true;
    });
    assert.equal(calls(), 1);
  });
});
test('request timeout preserves the cause without retrying the mutation', async () => {
  await upstream(() => {}, async (origin, calls) => {
    await assert.rejects(request(origin, '/api/v1/entries', { method: 'POST', body: { synthetic: true }, timeoutMs: 25 }), error => {
      assert.deepEqual(diagnostic(error), { error: 'PRIMER_CONNECTION_FAILED', requestClass: 'entries-create', connectionCause: 'PRIMER_TIMEOUT' }); return true;
    });
    assert.equal(calls(), 1);
  });
});
test('unknown native cause never copies its message, syscall, address or code into diagnostics', () => {
  const error = connectionFailure({ code: 'PRIVATE_SENTINEL', message: 'private-sentinel', syscall: 'connect', address: 'private-sentinel' }, 'roles-ready');
  assert.deepEqual(diagnostic(error), { error: 'PRIMER_CONNECTION_FAILED', requestClass: 'roles-ready', connectionCause: 'UNCLASSIFIED' });
  assert.doesNotMatch(JSON.stringify(error), /SENTINEL|private-sentinel|syscall|address/);
});
test('actual provision CLI emits safe ECONNREFUSED diagnosis from a refused listener', async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-primer-transport-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1, adminOrigin: 'http://127.0.0.1:' + port, apiOrigin: 'http://127.0.0.1:' + port, ownerConsumer: 'synthetic', seed: [{ id: 'synthetic' }] }));
  try {
    const child = spawn(process.execPath, [primerPath, 'provision'], { env: { ...process.env, NS_PRIMER_STATE: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    assert.equal(status, 1); assert.equal(stdout, '');
    assert.deepEqual(JSON.parse(stderr), { error: 'PRIMER_CONNECTION_FAILED', requestClass: 'tenants-provision', connectionCause: 'ECONNREFUSED' });
    assert.equal(fs.existsSync(path.join(dir, 'prime.lock')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('a restored listener serves the role list with no error classification', async () => {
  await upstream((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); }, async (origin, calls) => {
    assert.deepEqual(await waitForTenant(origin, {}), []); assert.equal(calls(), 1);
  });
});
test('actual child reports the first useful GET once without a tenant identity or route', async () => {
  await upstream((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); }, async (origin, calls) => {
    const script = 'const p=require(process.argv[1]);(async()=>{await p.waitForTenant(process.argv[2],{});await p.waitForTenant(process.argv[2],{});})().catch(()=>process.exitCode=1);';
    const child = spawn(process.execPath, ['-e', script, primerPath, origin], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
    const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    assert.equal(status, 0); assert.equal(calls(), 2);
    const events = stderr.trim().split('\n').map(line => JSON.parse(line)); assert.equal(events.length, 1);
    assert.deepEqual(Object.keys(events[0]).sort(), ['atMs', 'event', 'phase', 'requestClass', 'status']);
    assert.equal(events[0].event, 'first-useful-response'); assert.equal(events[0].phase, 'primer'); assert.equal(events[0].requestClass, 'roles-ready'); assert.equal(events[0].status, 200); assert(Number.isSafeInteger(events[0].atMs));
  });
});
