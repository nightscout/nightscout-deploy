'use strict';
// Bounded Vault response/partial-run behavior with an explicit HTTP double.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const bootstrap = require('../vault-agent-bootstrap');
function fixture () {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guard-fixture-'));
  const write = (name, value) => { const file = path.join(output, name); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); };
  const options = { output, vault: new URL('https://vault:8200'), sourceCommit: 'a'.repeat(40), deployCommit: 'b'.repeat(40), replicas: 1,
    ttl: '10s', maxTtl: '30s', keepEnvTokens: false, project: 'synthetic-guard', validateApi () {} };
  write('bootstrap/complete.json', { version: 2, sourceCommit: options.sourceCommit, deployCommit: options.deployCommit, registryMode: true });
  write('bootstrap/layout.json', { prefix: 'synthetic', mount: 'synthetic_transit' }); write('bootstrap/vault-init.json', { root_token: 'synthetic-fixture-material' });
  write('api/config.json', { version: 1, registry: { namespace: 'synthetic_registry' }, vault: { address: 'https://vault:8200', mount: 'synthetic_transit', tokenFile: '/run/ns-config/vault-token' } });
  write('api/env.json', { MULTITENANT_PREVIEW_CONFIG: '/run/ns-config/config.json' });
  write('api/operation.json', { participantId: 'api', participants: [{ id: 'api', roles: ['api'] }] });
  return { output, options, close: () => fs.rmSync(output, { recursive: true, force: true }) };
}
for (const mode of ['oversize', 'invalid-json', 'wrong-auth', 'lost-response']) test('bounded request guard ' + mode + ' preserves an explicit refused partial run', async () => {
  const f = fixture(), original = global.fetch; let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    if (mode === 'oversize') return new Response('x'.repeat(262145), { status: 200 });
    if (mode === 'invalid-json') return new Response('not-json', { status: 200 });
    if (mode === 'wrong-auth') return new Response(JSON.stringify({ data: { 'approle/': { type: 'userpass' } } }), { status: 200 });
    if (options.method === 'PUT') throw new Error('synthetic committed effect with lost response');
    return new URL(url).pathname === '/v1/sys/auth' ? new Response('{}', { status: 200 }) : new Response(null, { status: 204 });
  };
  try {
    const before = fs.readFileSync(path.join(f.output, 'api/config.json'));
    const codes = { oversize: 'VAULT_AGENT_RESPONSE_BOUND', 'invalid-json': 'VAULT_AGENT_RESPONSE_INVALID', 'wrong-auth': 'VAULT_AGENT_AUTH_METHOD_REFUSED' };
    await assert.rejects(bootstrap.run('provision', f.options), mode === 'lost-response' ? /lost response/ : { code: codes[mode] });
    assert.ok(fs.existsSync(path.join(f.output, 'vault-agent/started.json'))); assert.equal(fs.existsSync(path.join(f.output, 'vault-agent/complete.json')), false);
    assert.deepEqual(fs.readFileSync(path.join(f.output, 'api/config.json')), before);
    const refusedAt = calls; await assert.rejects(bootstrap.run('provision', f.options), { code: 'VAULT_AGENT_PARTIAL_STATE' }); assert.equal(calls, refusedAt);
  } finally { global.fetch = original; f.close(); }
});
