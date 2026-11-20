'use strict';
// Offline render check for evaluator K (slices.evaluator, decision statefulset-ordinal-scaling).
// Each evaluator Pod reads its ordinal from its hostname (evaluator-<i>) and K from
// NS_EVALUATOR_SLICES; evaluator i is the StatefulSet DNS name evaluator-<i>.evaluator under the
// headless `evaluator` Service, and the slices must cover every tenant once.
// NS_TEST_CORE names a core tree with lib/pool-membership/slice (a `git archive` of the image's core commit).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), inputs = JSON.parse(fs.readFileSync(path.join(root, 'environments/synthetic/inputs.json')));
const composeDir = path.resolve(root, '../compose/multitenant');
const core = process.env.NS_TEST_CORE;
const { checks, manifests } = require('./invariants');

function render (overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-k8s-evaluator-'));
  try {
    fs.mkdirSync(path.join(dir, 'environments/test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'jsonnetfile.json'), '{"version":1,"dependencies":[],"legacyImports":true}');
    fs.copyFileSync(path.join(root, 'environments/synthetic/spec.json'), path.join(dir, 'environments/test/spec.json'));
    fs.writeFileSync(path.join(dir, 'environments/test/main.jsonnet'), `local ns=import ${JSON.stringify(path.join(root, 'lib/ns/nightscout.libsonnet'))};ns.new(std.mergePatch(${JSON.stringify(inputs)},${JSON.stringify(overrides)}))`);
    const r = spawnSync('tk', ['eval', 'environments/test'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });
    if (r.status !== 0) return { status: r.status, error: r.stderr, value: null };
    const inventory = spawnSync('tk', ['eval', 'environments/test', '-e', 'inventory'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });
    return { status: inventory.status, error: inventory.stderr, value: JSON.parse(r.stdout), inventory: JSON.parse(inventory.stdout) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const env = (container, name) => (container.env || []).find(row => row.name === name);
const tenants = Array.from({ length: 2000 }, (_, i) => '00000000-0000-4000-8000-' + i.toString(16).padStart(12, '0'));
const evaluatorOf = value => value.components.evaluator.statefulset.spec.template.spec.containers.find(x => x.name === 'evaluator');

test('evaluator K=1: one Pod, entrypoint run directly, headless intake, explicit 1 equals the default', () => {
  const base = render({}), one = render({ slices: { evaluator: 1 } });
  assert.equal(base.status, 0, base.error); assert.equal(one.status, 0, one.error);
  assert.equal(JSON.stringify(one.value), JSON.stringify(base.value));
  const set = base.value.components.evaluator.statefulset, container = evaluatorOf(base.value);
  assert.equal(set.spec.replicas, 1); assert.equal(set.spec.serviceName, 'evaluator');
  assert.deepEqual(container.command, ['node', 'deploy/multitenant/entrypoint.js', 'evaluator']);
  assert.equal(env(container, 'NS_EVALUATOR_SLICES').value, '1');
  const intake = base.value.components.evaluator.intake;
  assert.equal(intake.metadata.name, 'evaluator'); assert.equal(intake.spec.clusterIP, 'None'); assert.equal(intake.spec.publishNotReadyAddresses, true);
  assert.equal(JSON.stringify(base.value).includes('NS_EVALUATOR_WORKERS'), false);
  const failed = checks(manifests(base.value), base.inventory, composeDir, {}).filter(r => r.failures.length);
  assert.deepEqual(failed, []);
});

test('evaluator K bound: the render assert and the input schema agree with the image roster bound', () => {
  const { MAX_WORKERS } = require(path.join(composeDir, 'evaluator-workers'));
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'inputs.schema.json'), 'utf8'));
  const find = (node, trail = []) => node && typeof node === 'object' ? (trail.slice(-2).join('/') === 'slices/properties' && node.evaluator ? node.evaluator : Object.entries(node).map(([k, v]) => find(v, [...trail, k])).find(Boolean)) : undefined;
  assert.deepEqual([find(schema).minimum, find(schema).maximum], [1, MAX_WORKERS], 'inputs.schema.json slices.evaluator');
  assert.equal(render({ slices: { evaluator: MAX_WORKERS } }).status, 0, 'K = MAX_WORKERS renders');
  for (const k of [0, MAX_WORKERS + 1, 1.5]) {
    const r = render({ slices: { evaluator: k } });
    assert.notEqual(r.status, 0); assert.match(r.error, new RegExp('slices.evaluator must be an integer 1..' + MAX_WORKERS));
  }
});

test('evaluator K=2,3: hostname ordinal and one K; the slices cover every tenant once', { skip: !core && 'NS_TEST_CORE unset' }, () => {
  const slice = require(path.join(core, 'lib/pool-membership/slice'));
  {
    for (const k of [2, 3]) {
      const r = render({ slices: { evaluator: k } });
      assert.equal(r.status, 0, r.error);
      const set = r.value.components.evaluator.statefulset, container = evaluatorOf(r.value);
      assert.equal(set.spec.replicas, k, 'replicas and K come from one value');
      assert.equal(env(container, 'NS_EVALUATOR_SLICES').value, String(k), 'K is one rendered environment value');
      assert.deepEqual(container.command, ['node', 'deploy/multitenant/entrypoint.js', 'evaluator'], 'no shell shim');
      for (const name of ['NS_PGSTREAM_EVALUATOR_SLICE', 'NS_PGSTREAM_RECEIVER_URL', 'NS_EVALUATOR_POD_INDEX', 'NS_SLICE_ORDINAL']) assert(!env(container, name), name);
      assert.equal(tenants.filter(slice.predicate(k, k)).length, 0, 'ordinal K owns nothing and is not refused');
      const owners = tenants.map(tenant => Array.from({ length: k }, (_, ordinal) => ordinal).filter(ordinal => slice.predicate(k, ordinal)(tenant)));
      assert(owners.every(list => list.length === 1), 'K=' + k + ': every tenant has exactly one owning Pod');
      assert.equal(r.value.networkPolicies.evaluatorIntake, undefined, 'no stream intake policy');
      const bootstrap = manifests(r.value).find(m => m.kind === 'Job' && (m.spec.template.spec.initContainers || []).some(x => x.name === 'bootstrap'));
      assert.equal(env(bootstrap.spec.template.spec.initContainers.find(x => x.name === 'bootstrap'), 'NS_EVALUATOR_WORKERS').value, String(k));
      const failed = checks(manifests(r.value), r.inventory, composeDir, {}).filter(x => x.failures.length);
      assert.deepEqual(failed, []);
    }
  }
});

test('two API processes route to two private writer-driven evaluator and realtime ordinals', () => {
  const selected = render({inputTransport: 'writer-driven', apiReplicas: 2, slices: {evaluator: 2, realtime: 2}});
  assert.equal(selected.status, 0, selected.error);
  const {value, inventory} = selected;
  const {components} = value;
  assert.equal(components.api.deployment.spec.replicas, 2);
  assert.equal(components.evaluator.statefulset.spec.replicas, 2);
  assert.equal(components.realtime.statefulset.spec.replicas, 2);
  assert.equal(components.evaluator.intake.spec.clusterIP, 'None');
  assert.equal(components.evaluator.intake.spec.ports[0].port, 19002);
  assert.equal(inventory.workloads.pgstream, undefined);
  assert.equal(inventory.documents.pgstream, undefined);
  assert.deepEqual(inventory.seed.environment, {NS_EVALUATOR_WORKERS: '2', NS_INPUT_TRANSPORT: 'writer-driven'});
  assert.doesNotMatch(JSON.stringify(value.postgres.statefulset.spec.template.spec.containers[0].args), /wal2json|wal_level=logical/);
  for (const role of ['api', 'tenant-admin', 'evaluator', 'realtime']) {
    const workload = components[role].deployment || components[role].statefulset;
    const container = workload.spec.template.spec.containers.find(x => x.name === role);
    assert.equal(env(container, 'NS_EVALUATOR_SLICE_URL').value, 'http://evaluator-{i}.evaluator:19002/');
    assert.equal(env(container, 'NS_REALTIME_SLICE_URL').value, 'http://realtime-{i}.realtime-peers:19003/');
  }
  const failures = () => checks(manifests(value), inventory, composeDir, {}).filter(x => x.failures.length);
  assert.deepEqual(failures(), []);
  env(components.api.deployment.spec.template.spec.containers[0], 'NS_REALTIME_SLICES').value = '1';
  assert.ok(failures().some(x => x.failures.some(f => f.includes('writer target counts'))));
});
