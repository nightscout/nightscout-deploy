'use strict';

// Run in the exact app image. Construct source documents and exercise the
// shipping private HTTP protocol against a synthetic admin ledger.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { bootstrapProof, checkVerification, fixture } = require('../ops/candidate-documents.cjs');
const contract = require('../assets/source-contract.json');
const app = process.cwd();
const binding = name => require(path.join(app, 'deploy/multitenant', name));

function documents(root) {
  const { writePrivate } = binding('bootstrap');
  const config = binding('config');
  const layout = config.layout();
  const urls = Object.fromEntries(Object.entries(layout.roles).map(([name, role]) =>
    [name, 'postgres://' + role + ':synthetic@postgres:5432/nightscout_compose_test']));
  const docs = config.documents({ layout, urls, tokens: [], publicKeys: [], managementKeys: [], vaultAddress: 'https://vault:8200', registryMode: true });
  const native = binding('native-lifecycle');
  native.attach(docs, native.select(layout, docs, { system_id: '123', timeline: 1, database: 'nightscout_compose_test', slot: layout.prefix + '_pgstream' }));
  const put = (name, value) => writePrivate(path.join(root, name), value);
  const get = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  for (const role of Object.keys(docs.configs)) {
    put(role + '/config.json', docs.configs[role]);
    put(role + '/env.json', docs.environments[role]);
    put(role + '/operation.json', docs.operations[role]);
  }
  binding('platform-startup').files({ output: root, docs, writePrivate, compact: {} });
  put('admin/config.json', docs.admin.config);
  put('admin/env.json', docs.admin.environment);
  put('pgstream/pgstream.yaml', binding('pgstream').wire(docs.configs.evaluator, urls.pgstream));
  put('primer/config.json', { adminOrigin: 'http://admin:1342', apiOrigin: 'http://api:1337', platformVerification: binding('platform-startup').selection(docs) });
  put('bootstrap/complete.json', { version: 2, registryMode: true, sourceCommit: contract.coreCommit, deployCommit: contract.deployCommit });
  put('vault-agent/complete.json', { version: 1, state: 'synthetic-test-marker' });
  return { get, change(name, mutate) {
    const file = path.join(root, name);
    const original = fs.readFileSync(file);
    const value = get(name);
    mutate(value);
    fs.writeFileSync(file, JSON.stringify(value));
    return () => fs.writeFileSync(file, original);
  } };
}

test('frozen image constructor and fixture verification refuse meaningful changes and restore', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kube-candidate-'));
  const id = fixture('synthetic-candidate', 'control-tiny');
  try {
    const d = documents(root);
    const boot = (pin = contract) => bootstrapProof(root, app, pin, id);
    const expected = boot();
    function refuse(action, code) {
      assert.throws(action, error => error.code === code);
      assert.deepEqual(boot(), expected);
    }
    refuse(() => boot({ ...contract, coreCommit: '0'.repeat(40) }), 'K8S_CANDIDATE_SOURCE_CHANGED');
    refuse(() => boot({ ...contract, producerBinarySha256: '0'.repeat(64) }), 'K8S_CANDIDATE_PRODUCER_CHANGED');
    refuse(() => boot({ ...contract, nativeCatalogueSha256: '0'.repeat(64) }), 'K8S_CANDIDATE_CATALOGUE_CHANGED');
    for (const [name, mutate, code] of [
      ['evaluator/operation.json', value => { value.nativeSelection.generation = 'foreign-generation'; }, 'K8S_CANDIDATE_GENERATION_CHANGED'],
      ['pgstream/pgstream.yaml', value => { value.target.webhooks.notifier.strict_mode = false; }, 'K8S_CANDIDATE_STREAM_CHANGED'],
      ['admin/verification/api.env.json', value => { value.NS_API_PG = value.NS_READINESS_PG; }, 'K8S_CANDIDATE_VERIFICATION_DOCUMENT_CHANGED'],
    ]) {
      const restore = d.change(name, mutate);
      try { assert.throws(boot, error => error.code === code); } finally { restore(); }
      assert.deepEqual(boot(), expected);
    }
    const missing = path.join(root, 'admin/verification/api.operation.json');
    fs.renameSync(missing, missing + '.held');
    try { assert.throws(boot, { code: 'K8S_CANDIDATE_ADMIN_PROOF_REQUIRED' }); }
    finally { fs.renameSync(missing + '.held', missing); }
    assert.deepEqual(boot(), expected);

    let red = false, observed = 0;
    const { api } = require(path.join(app, 'lib/server/serve/platform-verification-admin'));
    const receive = api({ service: { async verify() {
      observed++;
      return { version: 1, status: 'verified', namespace: expected.selection.namespace, refreshMs: expected.selection.refreshMs, validityMs: expected.selection.maxAgeMs,
        roles: expected.roles.map(row => ({ ...row, generation: red && row.role === 'evaluator' ? 'f'.repeat(64) : row.generation,
          expiresAt: new Date(Date.now() + 60000).toISOString() })) };
    } }, fallback: (_req, res) => { res.writeHead(404); res.end(); } });
    const server = http.createServer(receive);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { adminOrigin, ...primer } = d.get('primer/config.json');
      const loopback = { ...primer, adminOrigin: 'http://127.0.0.1:' + server.address().port };
      const verifier = binding('platform-verify');
      const proof = () => verifier.verify(loopback);
      const pinned = { ...expected, selectionSha256: createHash('sha256').update(JSON.stringify(verifier.selection(loopback))).digest('hex') };
      const measured = await proof();
      assert.equal(checkVerification(pinned, measured, id, contract).credentialBoundary, 'admin-private-api');
      assert.throws(() => checkVerification(pinned, undefined, id, contract), { code: 'K8S_CANDIDATE_ADMIN_PROOF_REQUIRED' });
      assert.throws(() => checkVerification(pinned, measured, fixture(id.namespace, 'wrong-run'), contract), { code: 'K8S_CANDIDATE_FIXTURE_CHANGED' });
      assert.equal(checkVerification(pinned, measured, id, contract, Date.now() + 120000).roles.length, 3, 'startup proof has no lease');
      assert.throws(() => checkVerification(pinned, measured, id, {...contract, platformVerification: undefined}, Date.now() + 120000), { code: 'K8S_CANDIDATE_VERIFICATION_GENERATION_CHANGED' });
      red = true;
      const foreign = await proof();
      assert.throws(() => checkVerification(pinned, foreign, id, contract), { code: 'K8S_CANDIDATE_VERIFICATION_GENERATION_CHANGED' });
      red = false;
      assert.equal(checkVerification(pinned, await proof(), id, contract).roles.length, 3);
      assert.equal(observed, 3);
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally { fs.rmSync(root, { force: true, recursive: true }); }
});

test('Vault provisions the same API document that the admin role verifies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-role-export-'));
  const originalFetch = globalThis.fetch;
  try {
    const d = documents(root);
    const { writePrivate } = binding('bootstrap');
    const { input, provision } = require('../ops/vault-kubernetes-auth.js');
    fs.unlinkSync(path.join(root, 'vault-agent/complete.json'));
    writePrivate(path.join(root, 'bootstrap/layout.json'), binding('config').layout());
    writePrivate(path.join(root, 'bootstrap/vault-init.json'), {root_token: 'synthetic'});
    const options = input({NS_VAULT_K8S_AUTH:'1', NS_BOOTSTRAP_OUTPUT:root,
      NS_VAULT_K8S_NAMESPACE:'synthetic', NS_VAULT_K8S_SERVICE_ACCOUNT:'cohort'});
    let requests = 0;
    globalThis.fetch = async (_, init) => {
      requests++;
      return init.method === 'GET' ? new Response(JSON.stringify({data:{policy:'synthetic'}})) : new Response(null, {status:204});
    };
    const before = d.get('api/config.json');
    const name = 'admin/verification/api.config.json';
    const restore = d.change(name, value => { value.platformVerification.namespace += '_changed'; });
    try { await assert.rejects(provision(options), {code:'VAULT_VERIFICATION_DOCUMENT_CHANGED'}); }
    finally { restore(); }
    assert.equal(requests, 0);
    assert.deepEqual(d.get('api/config.json'), before);
    await provision(options);
    const expected = {...before, vault:{...before.vault, tokenFile:'/run/ns-vault/token'}};
    assert.deepEqual(d.get('api/config.json'), expected);
    assert.deepEqual(d.get(name), expected);
    const proof = bootstrapProof(root, app, contract, fixture('synthetic','vault-handoff'));
    assert.deepEqual(proof.roles.map(row => row.role), ['api','evaluator','realtime']);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, {recursive:true, force:true});
  }
});

test('network projection preserves source authority and uses real role listener loaders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kube-network-'));
  const network = require('../ops/network-documents.cjs');
  try {
    const d = documents(root);
    const originals = Object.fromEntries(network.ROLES.map(role => [role, d.get(role + '/config.json')]));
    network.project(root);
    const check = () => bootstrapProof(root, app, {...contract,applicationTopology:'separate-k1'}, fixture('synthetic','network'));
    check();
    for (const role of network.ROLES) {
      assert.deepEqual(d.get(role + '/config.json'), originals[role]);
      const env = d.get(role + '/env.json');
      const loader = require(path.join(app,'lib/server/internal-api/listener-config'));
      const internal = loader.resolve([role], env);
      for (const peer of network.ROLES.filter(peer => peer !== role))
        assert.equal(internal.peer(peer,{maxBytes:1024,timeoutMs:100}).url, network.address(peer));
      const operation = path.join(root,role,'operation.json');
      const actual = require(path.join(app,'lib/server/serve/operation-cohort-config')).load({...env,MULTITENANT_OPERATION_CONFIG:operation},internal);
      assert.equal(actual.participantId, role);
      assert.equal(actual.participants.length, 4);
    }
    const restore = d.change('realtime/env.json', env => { env.NS_API_INTERNAL_SOCKET = '/run/ns-ipc/api.sock'; });
    try { assert.throws(check,{code:'K8S_NETWORK_DOCUMENT_CHANGED'}); } finally { restore(); }
    check();
    const restoreTarget = d.change('admin/verification/api.env.json', env => { env.NS_EVALUATOR_INTERNAL_URL = network.address('realtime'); });
    try { assert.throws(check,{code:'K8S_CANDIDATE_VERIFICATION_DOCUMENT_CHANGED'}); } finally { restoreTarget(); }
    check();
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
