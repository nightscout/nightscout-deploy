'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const workers = require('./evaluator-workers');
const plan = require('./config');
const binding = require('./pgstream');

function generated(count) {
  const before = process.env.NS_EVALUATOR_WORKERS;
  if (count === undefined) delete process.env.NS_EVALUATOR_WORKERS;
  else process.env.NS_EVALUATOR_WORKERS = String(count);
  try {
    const layout = plan.layout();
    const urls = Object.fromEntries(Object.keys(layout.roles).map(kind =>
      [kind, 'postgres://' + layout.roles[kind] + ':' + crypto.randomBytes(20).toString('hex') + '@postgres/nightscout_compose_test']));
    return { layout, docs: plan.documents({ layout, urls, tokens: [], publicKeys: [], managementKeys: [], vaultAddress: 'https://vault:8200' }) };
  } finally {
    if (before === undefined) delete process.env.NS_EVALUATOR_WORKERS;
    else process.env.NS_EVALUATOR_WORKERS = before;
  }
}

function documentSet(docs) {
  return { contract: 1, processes: Object.keys(docs.configs).map(name => ({
    name, roles: [name.replace(/-\d+$/, '')], environment: docs.environments[name],
    files: {
      '/run/ns-config/config.json': docs.configs[name],
      '/run/ns-config/operation.json': docs.operations[name],
      ...(name === 'api' ? { '/run/ns-config/evaluator-metadata.json': docs.configs.evaluator } : {})
    }
  })).concat({
    name: 'admin', roles: ['admin'], environment: docs.admin.environment,
    files: { '/run/ns-config/config.json': docs.admin.config }
  }) };
}

function checkCore(documents) {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../../bin/nightscout.js'), 'plan', 'check', '-'],
    { input: JSON.stringify(documents), encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  return { status: result.status, report: JSON.parse(result.stdout) };
}

function validateFiles(docs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-native-plan-'));
  try {
    for (const [role, config] of Object.entries(docs.configs)) {
      const target = path.join(directory, role);
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'config.json'), JSON.stringify(config));
      fs.writeFileSync(path.join(target, 'operation.json'), JSON.stringify(docs.operations[role]));
      if (role === 'api') fs.writeFileSync(path.join(target, 'evaluator-metadata.json'), JSON.stringify(docs.configs.evaluator));
    }
    plan.validateFiles(directory, docs);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('opt-in evaluator processes require an explicit bounded count and allow idle registry slices', () => {
  assert.equal(workers.selection({}), null);
  for (const raw of ['0', '9', '17', '2x', '', 2]) assert.throws(() => workers.selection({NS_EVALUATOR_WORKERS:raw}));
  assert.deepEqual(workers.services(workers.selection({NS_EVALUATOR_WORKERS:'3'})), ['evaluator','evaluator-2','evaluator-3']);
  assert.doesNotThrow(() => workers.assertSeed({ workers: 2 }, []));
  assert.doesNotThrow(() => workers.assertSeed({ workers: 2 }, [plan.A]));
  workers.assertSeed({ workers: 2 }, [plan.A, plan.B]);
});

test('standalone, K1 and K2 compose documents pass the exact core plan and deployment checks', () => {
  for (const count of [undefined, 1, 2]) {
    const { layout, docs } = generated(count);
    assert.equal(Object.hasOwn(layout.namespaces, 'pool'), false);
    assert.equal(Object.hasOwn(layout.roles, 'pool_member'), false);
    assert.equal(Object.hasOwn(docs.admin.config, 'pools'), false);
    assert.equal(Object.hasOwn(docs.admin.environment, 'NS_POOL_OPERATOR_PG'), false);
    const selected = docs.evaluatorWorkers;
    const roster = workers.roster(selected);
    const descriptor = binding.descriptor(layout, selected);
    const receivers = roster.map(worker => worker.url);
    assert.deepEqual(receivers, workers.services(selected).map(service => 'http://' + service + ':19913/'));
    assert.equal(docs.configs.realtime.completedOutput.consumer, docs.configs.evaluator.consumer);
    for (const [ordinal, {service, url, socket}] of roster.entries()) {
      const env = docs.environments[service], cfg = docs.configs[service], op = docs.operations[service];
      assert.equal(cfg.pgstream.receiver.url, url);
      assert.equal(cfg.pgstream.generation, docs.configs.evaluator.pgstream.generation);
      assert.equal(cfg.pgstream.slot, descriptor.pgstream.slot);
      assert.equal(cfg.consumer, descriptor.consumer);
      const raw = env.NS_PGSTREAM_EVALUATOR_SLICE;
      if (!selected) {
        assert.equal(raw, undefined);
        assert.equal(op.version, 1);
        assert.equal(descriptor.processAssignment, undefined);
        continue;
      }
      assert.deepEqual(JSON.parse(raw), {count: roster.length, ordinal, receivers});
      assert.deepEqual(descriptor.processAssignment.receivers, receivers);
      assert.equal(op.version, 1);
      assert.equal(env.NS_SERVE_INTERNAL_SOCKET, socket);
      assert.equal(env.NS_EVALUATOR_INTERNAL_SOCKET, undefined);
      assert(!Object.keys(env).some(name => name.startsWith('MULTITENANT_POOL_')));
    }
    validateFiles(docs);
    const result = checkCore(documentSet(docs));
    assert.equal(result.status, 0, JSON.stringify(result.report));
    assert.equal(result.report.ok, true);
  }
});

test('wrong ordinal and divergent generation fail before deployment and the restored plan passes', () => {
  const baseline = generated(2).docs;
  const badOrdinal = structuredClone(baseline);
  const env = badOrdinal.environments.evaluator;
  const configured = JSON.parse(env.NS_PGSTREAM_EVALUATOR_SLICE);
  env.NS_PGSTREAM_EVALUATOR_SLICE = JSON.stringify({...configured, ordinal: 1 - configured.ordinal});
  const result = checkCore(documentSet(badOrdinal));
  assert.equal(result.status, 1, JSON.stringify(result.report));
  const reports = result.report.processes.filter(process => !process.ok);
  assert.deepEqual(reports.map(process => process.name), ['evaluator']);
  assert.deepEqual(reports[0].findings.map(finding => finding.code), ['PLAN_CONFIGURATION_REFUSED']);
  assert.throws(() => validateFiles(badOrdinal), /invalid explicit evaluator preview configuration/);
  const badGeneration = structuredClone(baseline);
  badGeneration.configs['evaluator-2'].pgstream.generation = 'b'.repeat(32);
  assert.throws(() => validateFiles(badGeneration), /native source or assignment mismatch/);
  validateFiles(baseline);
  assert.equal(checkCore(documentSet(baseline)).status, 0);
});
