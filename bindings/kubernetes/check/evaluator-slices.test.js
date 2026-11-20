'use strict';
// Offline render check for evaluator K (slices.evaluator, decision statefulset-ordinal-scaling).
// Each evaluator Pod reads its ordinal from its hostname (evaluator-<i>) and K from
// NS_EVALUATOR_SLICES (core lib/pgstream/assigned-worker.js hostAssignment); receiver i is the
// StatefulSet DNS name evaluator-<i>.evaluator under the headless `evaluator` Service. The roster
// core derives must equal the one the image's seed render and bootstrap use (Compose
// evaluator-workers.js under NS_EVALUATOR_WORKERS=K), and the slices must cover every tenant once.
// NS_TEST_CORE names a core tree with hostAssignment (a `git archive` of the image's core commit).
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
const servicesOf = value => manifests(value).filter(m => m.kind === 'Service');

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
  assert.match(JSON.stringify(base.value.postgres), /max_wal_senders=4"/);
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

test('evaluator K=2,3: hostname ordinal and one K; core, seed render and bootstrap agree on the DNS roster', { skip: !core && 'NS_TEST_CORE unset' }, () => {
  const { hostAssignment } = require(path.join(core, 'lib/pgstream/assigned-worker'));
  const settings = require(path.join(core, 'lib/server/serve/deployment-settings'));
  const slice = require(path.join(core, 'lib/pool-membership/slice'));
  // The image ships the Compose binding at deploy/multitenant beside core's lib.
  const image = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-k8s-image-'));
  try {
    fs.mkdirSync(path.join(image, 'deploy/multitenant'), { recursive: true });
    fs.symlinkSync(path.join(core, 'lib'), path.join(image, 'lib'));
    for (const file of ['pgstream.js', 'evaluator-workers.js']) fs.copyFileSync(path.join(composeDir, file), path.join(image, 'deploy/multitenant', file));
    const stream = require(path.join(image, 'deploy/multitenant/pgstream.js'));
    const workers = require(path.join(image, 'deploy/multitenant/evaluator-workers.js'));
    for (const k of [2, 3]) {
      const r = render({ slices: { evaluator: k } });
      assert.equal(r.status, 0, r.error);
      const set = r.value.components.evaluator.statefulset, container = evaluatorOf(r.value);
      assert.equal(set.spec.replicas, k, 'replicas and K come from one value');
      assert.equal(env(container, 'NS_EVALUATOR_SLICES').value, String(k), 'K is one rendered environment value');
      assert.deepEqual(container.command, ['node', 'deploy/multitenant/entrypoint.js', 'evaluator'], 'no shell shim');
      for (const name of ['NS_PGSTREAM_EVALUATOR_SLICE', 'NS_PGSTREAM_RECEIVER_URL', 'NS_EVALUATOR_POD_INDEX', 'NS_SLICE_ORDINAL']) assert(!env(container, name), name);
      assert.equal(servicesOf(r.value).filter(v => v.spec.selector?.['app.kubernetes.io/component'] === 'evaluator' && v.spec.ports?.some(p => p.port === 19913)).length, 1, 'one headless intake Service');
      const roster = workers.roster(workers.selection({ NS_EVALUATOR_WORKERS: String(k) })).map(row => row.url);
      const receiver = settings.evaluator({}).pgstream.receiver;
      const profiles = [];
      for (let ordinal = 0; ordinal < k; ordinal++) {
        // StatefulSet Pod evaluator-<i> has hostname evaluator-<i> and DNS evaluator-<i>.<serviceName>.
        const value = hostAssignment({ NS_EVALUATOR_SLICES: env(container, 'NS_EVALUATOR_SLICES').value }, receiver, set.metadata.name + '-' + ordinal);
        assert.deepEqual([...value.receivers], roster, 'core and the image roster agree');
        assert.equal(new URL(value.receiver).hostname, set.metadata.name + '-' + ordinal + '.' + set.spec.serviceName);
        profiles.push(value);
      }
      const idle = hostAssignment({ NS_EVALUATOR_SLICES: String(k) }, receiver, 'evaluator-' + k);
      assert.equal(tenants.filter(slice.predicate(idle.count, idle.ordinal)).length, 0, 'ordinal K owns nothing and is not refused');
      const owners = tenants.map(tenant => profiles.filter(p => slice.predicate(p.count, p.ordinal)(tenant)).map(p => p.ordinal));
      assert(owners.every(list => list.length === 1), 'K=' + k + ': every tenant has exactly one owning Pod');
      // pgstream.yaml as the image renders it under NS_EVALUATOR_WORKERS=k (render.js -> descriptor -> wire).
      const descriptor = stream.descriptor({ prefix: 'nsdemo' }, workers.selection({ NS_EVALUATOR_WORKERS: String(k) }));
      const wire = stream.wire({ ...descriptor, pgstream: { ...descriptor.pgstream, slot: 'slot' } }, 'postgres://pgstream@postgres:5432/db', { routes: [{ schema: 's', table: 't' }] });
      assert.deepEqual(wire.target.webhooks.notifier.transaction_batch.slice_receivers, roster.map(url => url + 'pgstream'));
      // pgstream may reach every evaluator Pod on the intake port.
      const intake = r.value.networkPolicies.evaluatorIntake.spec;
      assert.equal(intake.podSelector.matchLabels['app.kubernetes.io/component'], 'evaluator');
      assert.deepEqual(intake.ingress[0].from.map(f => f.podSelector.matchLabels['app.kubernetes.io/component']), ['pgstream']);
      assert.deepEqual(intake.ingress[0].ports, [{ protocol: 'TCP', port: 19913 }]);
      // Subscriptions for every receiver, and WAL senders as Compose prepare.js sets them.
      const bootstrap = manifests(r.value).find(m => m.kind === 'Job' && (m.spec.template.spec.initContainers || []).some(x => x.name === 'bootstrap'));
      assert.equal(env(bootstrap.spec.template.spec.initContainers.find(x => x.name === 'bootstrap'), 'NS_EVALUATOR_WORKERS').value, String(k));
      assert.match(JSON.stringify(r.value.postgres), new RegExp('max_wal_senders=' + Math.max(4, k + 2) + '"'));
      const failed = checks(manifests(r.value), r.inventory, composeDir, {}).filter(x => x.failures.length);
      assert.deepEqual(failed, []);
    }
  } finally { fs.rmSync(image, { recursive: true, force: true }); }
});
