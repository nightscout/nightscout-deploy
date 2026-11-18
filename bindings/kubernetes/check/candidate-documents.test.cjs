'use strict';

// Run with the app layout as the working directory (the app image, or a core
// checkout with this deployment's multitenant binding at deploy/multitenant).
// Construct source documents and exercise the shipping private HTTP protocol
// against a synthetic admin service.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { expectedRecord, fixture, hold, refusalCode, verify } = require('../ops/candidate-documents.cjs');
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

const HEX = /^[0-9a-f]{64}$/;

// A synthetic admin service on loopback; `state.refuse` makes it answer
// anything but a verified receipt.
async function admin(selection, state) {
  const { api } = require(path.join(app, 'lib/server/serve/platform-verification-admin'));
  const receive = api({ service: { async verify() {
    state.calls++;
    if (state.refuse) return { version: 1, status: 'refused', namespace: selection.namespace, roles: [] };
    return { version: 1, status: 'verified', namespace: selection.namespace,
      roles: selection.roles.map((role, index) => ({ role, generation: String(index + 1).repeat(64) })) };
  } }, fallback: (_req, res) => { res.writeHead(404); res.end(); } });
  const server = http.createServer(receive);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('hold publishes a public provenance record without re-deriving source documents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kube-candidate-'));
  const id = fixture('synthetic-candidate', 'control-tiny');
  try {
    const d = documents(root);
    const native = d.get('evaluator/operation.json').nativeSelection;
    const expected = hold(root, contract, id, 'cohort');
    assert.deepEqual(d.get('primer/expected-verification.json'), expected);
    assert.deepEqual(expected.fixture, id);
    assert.equal(expected.coreCommit, contract.coreCommit);
    assert.equal(expected.deployCommit, contract.deployCommit);
    assert.deepEqual(expected.nativeSource, native.source);
    assert.equal(expected.nativeGeneration, native.generation);
    assert.match(expected.nativeSelectionSha256, HEX);
    // Identity and catalogue are the image digest's; a different contract or
    // generation is recorded, never refused.
    const restore = d.change('evaluator/operation.json', value => { value.nativeSelection.generation = 'other-generation'; });
    try {
      const other = expectedRecord(root, { coreCommit: '0'.repeat(40) }, id);
      assert.equal(other.coreCommit, '0'.repeat(40));
      assert.equal(other.nativeGeneration, 'other-generation');
    } finally { restore(); }
    assert.deepEqual(expectedRecord(root, {}, id).fixture, id);
    // The record is written once per provisioning.
    assert.throws(() => hold(root, contract, id, 'cohort'), { code: 'EEXIST' });
  } finally { fs.rmSync(root, { force: true, recursive: true }); }
});

test('verify publishes the admin platform verification receipt and refuses without one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kube-verify-'));
  const id = fixture('synthetic-candidate', 'control-verify');
  const state = { calls: 0, refuse: false };
  let server;
  try {
    const d = documents(root);
    hold(root, contract, id, 'cohort');
    const primer = d.get('primer/config.json');
    server = await admin(primer.platformVerification, state);
    const dir = path.join(root, 'primer');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...primer, adminOrigin: 'http://127.0.0.1:' + server.address().port }));
    // Break-it: serving waits on this proof, so a refused verification must
    // leave no proof behind.
    state.refuse = true;
    await assert.rejects(verify(app, dir, id, contract), error => /^PLATFORM_VERIFICATION_/.test(error.code));
    assert.equal(fs.existsSync(path.join(dir, 'verified.json')), false);
    state.refuse = false;
    const record = await verify(app, dir, id, contract);
    assert.deepEqual(d.get('primer/verified.json'), record);
    assert.equal(record.status, 'verified');
    assert.equal(record.credentialBoundary, 'admin-private-api');
    assert.deepEqual(record.fixture, id);
    assert.equal(record.coreCommit, contract.coreCommit);
    assert.deepEqual(record.roles.map(row => row.role), ['api', 'evaluator', 'realtime']);
    assert.ok(record.roles.every(row => HEX.test(row.generation) && Object.keys(row).length === 2));
    assert.match(record.selectionSha256, HEX);
    assert.equal(state.calls, 2);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { force: true, recursive: true });
  }
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
    const operations = Object.fromEntries(network.ROLES.map(role => [role, d.get(role + '/operation.json')]));
    hold(root, contract, fixture('synthetic', 'network'), 'separate-k1');
    for (const role of network.ROLES) {
      assert.deepEqual(d.get(role + '/config.json'), originals[role]);
      assert.deepEqual(d.get(role + '/operation.json'), operations[role]);
      const env = d.get(role + '/env.json');
      assert.equal(Object.keys(env).some(name => /_INTERNAL_SOCKET$/.test(name)), false);
      const loader = require(path.join(app,'lib/server/internal-api/listener-config'));
      const internal = loader.resolve([role], env);
      for (const peer of network.ROLES.filter(peer => peer !== role))
        assert.equal(internal.peer(peer,{maxBytes:1024,timeoutMs:100}).url, network.address(peer));
      const operation = path.join(root,role,'operation.json');
      const actual = require(path.join(app,'lib/server/serve/operation-cohort-config')).load({...env,MULTITENANT_OPERATION_CONFIG:operation},internal);
      assert.equal(actual.participantId, role);
    }
    // The admin screens exactly the environments the serving roles load.
    for (const role of ['api', 'evaluator', 'realtime']) {
      const env = d.get(role + '/env.json'), target = d.get('admin/verification/' + role + '.env.json');
      assert.deepEqual(Object.keys(target).sort(), Object.keys(env).sort());
      assert.equal(target.NS_SERVE_INTERNAL_PORT, String(network.PORTS[role]));
    }
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});


test('eight-tenant bootstrap operator without a participant manifest preserves authority through network projection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kube-bootstrap-'));
  const originalTenants = process.env.NS_DEMO_TENANTS;
  const native = binding('native-lifecycle');
  const install = native.install;
  try {
    process.env.NS_DEMO_TENANTS = '8';
    const config = binding('config'), layout = config.layout();
    const urls = Object.fromEntries(Object.entries(layout.roles).map(([name, role]) =>
      [name, 'postgres://' + role + ':synthetic@postgres:5432/nightscout_compose_test']));
    // Keep the actual bootstrap's file writers, parsers and operator constructor.
    // Only external SQL installation and Vault requests are inert in this fixture.
    native.install = async () => {};
    await binding('registry-bootstrap').finish({
      options: { output: root, uid: process.getuid(), gid: process.getgid(), vault: new URL('https://vault:8200'),
        sourceCommit: contract.coreCommit, deployCommit: contract.deployCommit },
      request: async () => ({ auth: { client_token: 'synthetic' } }),
      rootToken: 'synthetic', layout, roleURLs: urls,
      writePrivate: binding('bootstrap').writePrivate,
      nativeSource: { system_id: '123', timeline: 1, database: 'nightscout_compose_test', slot: layout.prefix + '_pgstream' },
    });
    binding('bootstrap').writePrivate(path.join(root, 'bootstrap/vault-init.json'), { root_token: 'synthetic' });
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (_, init) => init.method === 'GET'
        ? new Response(JSON.stringify({ data: { policy: 'synthetic' } })) : new Response(null, { status: 204 });
      const vault = require('../ops/vault-kubernetes-auth.js');
      await vault.provision(vault.input({ NS_VAULT_K8S_AUTH: '1', NS_BOOTSTRAP_OUTPUT: root,
        NS_VAULT_K8S_NAMESPACE: 'synthetic', NS_VAULT_K8S_SERVICE_ACCOUNT: 'cohort' }));
    } finally { globalThis.fetch = originalFetch; }
    const operatorFile = path.join(root, 'ops/config.json');
    const original = fs.readFileSync(operatorFile);
    const operator = JSON.parse(original);
    assert.equal(operator.tenants.length, 8);
    assert.equal(Object.hasOwn(operator.control, 'participants'), false);
    const network = require('../ops/network-documents.cjs');
    const expected = hold(root, contract, fixture('synthetic', 'bootstrap-eight'), 'separate-k1');
    assert.deepEqual(fs.readFileSync(operatorFile), original, 'an operator with no addresses has nothing to project');
    assert.match(expected.nativeSelectionSha256, HEX);
    const operation = fs.readFileSync(path.join(root, 'evaluator/operation.json'));
    const participants = JSON.parse(operation).participants.map(({ id, roles, namespaces, maxMessageBytes, timeoutMs }) =>
      ({ id, roles, namespaces, endpoint: { socketPath: '/run/ns-ipc/' + id + '.sock', maxBytes: maxMessageBytes, timeoutMs } }));
    const manifested = { ...operator, control: { ...operator.control, participants } };
    fs.writeFileSync(operatorFile, JSON.stringify(manifested));
    network.project(root);
    const projected = JSON.parse(fs.readFileSync(operatorFile));
    assert.deepEqual(projected, { ...manifested, control: { ...manifested.control, participants: participants.map(participant => ({
      ...participant, endpoint: { url: network.address(participant.id), trust: 'network',
        maxBytes: participant.endpoint.maxBytes, timeoutMs: participant.endpoint.timeoutMs },
    })) } });
    // A participant this binding does not run is left for the source parser to judge.
    const foreign = { ...participants[0], id: 'foreign' };
    fs.writeFileSync(operatorFile, JSON.stringify({ ...operator, control: { ...operator.control, participants: [foreign] } }));
    network.project(root);
    assert.deepEqual(JSON.parse(fs.readFileSync(operatorFile)).control.participants, [foreign]);
  } finally {
    native.install = install;
    if (originalTenants === undefined) delete process.env.NS_DEMO_TENANTS;
    else process.env.NS_DEMO_TENANTS = originalTenants;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('candidate refusals report a typed code and never expose error details', () => {
  const detail = 'synthetic-private-document-detail';
  assert.equal(refusalCode({ code: 'K8S_NETWORK_DOCUMENT_CHANGED', message: detail }), 'K8S_NETWORK_DOCUMENT_CHANGED');
  assert.equal(refusalCode({ code: 'PLATFORM_VERIFICATION_REFUSED_503', message: detail }), 'PLATFORM_VERIFICATION_REFUSED_503');
  assert.equal(refusalCode({ code: 'ENOENT', message: detail }), 'ENOENT');
  for (const error of [new Error(detail), { code: detail }, { code: 'K8S ' + detail }, null])
    assert.equal(refusalCode(error), 'K8S_CANDIDATE_DOCUMENT_REFUSED');
});
