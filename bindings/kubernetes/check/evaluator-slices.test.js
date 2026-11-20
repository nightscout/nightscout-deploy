'use strict';
// Offline render check for evaluator K (slices.evaluator, decision statefulset-ordinal-scaling).
// K=1 renders the single receiver exactly as before. K>1 mirrors the Compose roster
// (bindings/compose/multitenant/evaluator-workers.js, NS_EVALUATOR_WORKERS): each Pod's command
// shim, run here in sh with the Pod's index, yields the NS_PGSTREAM_RECEIVER_URL and
// NS_PGSTREAM_EVALUATOR_SLICE Compose renders for that ordinal; core's own parser accepts them;
// the slices are disjoint and cover every tenant under core's slice function; and the pgstream
// slice_receivers the image renders for the same K name exactly the intake Services rendered here.
// NS_TEST_CORE names a core tree (a `git archive` of the image's core commit).
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

// Run the rendered command in sh with the Pod's index; a stand-in `node` on PATH reports what the
// entrypoint would receive instead of starting it.
function shim (command, index) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-k8s-shim-'));
  try {
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nprintf \'%s\\n%s\\n%s\\n\' "$NS_PGSTREAM_RECEIVER_URL" "$NS_PGSTREAM_EVALUATOR_SLICE" "$*"\n', { mode: 0o755 });
    const r = spawnSync(command[0], command.slice(1), { encoding: 'utf8', env: { PATH: bin + ':/usr/bin:/bin', NS_EVALUATOR_POD_INDEX: String(index) } });
    const [url, slice, args] = r.stdout.split('\n');
    return { status: r.status, url, slice, args, stderr: r.stderr };
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
}

test('evaluator K=1: one receiver, entrypoint run directly, explicit 1 equals the default', () => {
  const base = render({}), one = render({ slices: { evaluator: 1 } });
  assert.equal(base.status, 0, base.error); assert.equal(one.status, 0, one.error);
  assert.equal(JSON.stringify(one.value), JSON.stringify(base.value));
  const set = base.value.components.evaluator.statefulset, container = evaluatorOf(base.value);
  assert.equal(set.spec.replicas, 1);
  assert.deepEqual(container.command, ['node', 'deploy/multitenant/entrypoint.js', 'evaluator']);
  assert(!env(container, 'NS_EVALUATOR_POD_INDEX'));
  assert.equal(base.value.components.evaluator.sliceIntakes, undefined);
  assert.equal(JSON.stringify(base.value.components.evaluator.intake.spec.selector).includes('pod-name'), false);
  assert.equal(JSON.stringify(base.value).includes('NS_EVALUATOR_WORKERS'), false);
  assert.match(JSON.stringify(base.value.postgres), /max_wal_senders=4"/);
  const failed = checks(manifests(base.value), base.inventory, composeDir, {}).filter(r => r.failures.length);
  assert.deepEqual(failed, []);
});

test('evaluator K outside 1..8 refuses to render', () => {
  for (const k of [0, 9, 1.5]) {
    const r = render({ slices: { evaluator: k } });
    assert.notEqual(r.status, 0); assert.match(r.error, /slices.evaluator must be an integer 1..8/);
  }
});

test('evaluator K=2,3: Pods carry the Compose slice profile, disjoint and covering, and pgstream addresses each Pod', { skip: !core && 'NS_TEST_CORE unset' }, () => {
  const { processProfile } = require(path.join(core, 'lib/pgstream/assigned-worker'));
  const settings = require(path.join(core, 'lib/server/serve/deployment-settings'));
  const slice = require(path.join(core, 'lib/pool-membership/slice'));
  const workers = require(path.join(composeDir, 'evaluator-workers'));
  // The image ships the Compose binding at deploy/multitenant beside core's lib.
  const image = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-k8s-image-'));
  try {
    fs.mkdirSync(path.join(image, 'deploy/multitenant'), { recursive: true });
    fs.symlinkSync(path.join(core, 'lib'), path.join(image, 'lib'));
    for (const file of ['pgstream.js', 'evaluator-workers.js']) fs.copyFileSync(path.join(composeDir, file), path.join(image, 'deploy/multitenant', file));
    const stream = require(path.join(image, 'deploy/multitenant/pgstream.js'));
    for (const k of [2, 3]) {
      const r = render({ slices: { evaluator: k } });
      assert.equal(r.status, 0, r.error);
      const set = r.value.components.evaluator.statefulset, container = evaluatorOf(r.value);
      assert.equal(set.spec.replicas, k, 'replicas and K come from one value');
      assert.equal(env(container, 'NS_EVALUATOR_POD_INDEX').valueFrom.fieldRef.fieldPath, "metadata.labels['apps.kubernetes.io/pod-index']");
      assert(!env(container, 'NS_PGSTREAM_EVALUATOR_SLICE') && !env(container, 'NS_PGSTREAM_RECEIVER_URL'), 'set only by the shim');
      const roster = workers.roster(workers.selection({ NS_EVALUATOR_WORKERS: String(k) }));
      const services = servicesOf(r.value);
      const profiles = [];
      for (let ordinal = 0; ordinal < k; ordinal++) {
        const out = shim(container.command, ordinal);
        assert.equal(out.status, 0, out.stderr);
        assert.equal(out.args, 'deploy/multitenant/entrypoint.js evaluator');
        // Byte-equal to what Compose renders for the same service.
        assert.equal(out.url, roster[ordinal].url);
        assert.equal(out.slice, JSON.stringify({ count: k, ordinal, receivers: roster.map(row => row.url) }));
        // Core's own parser, with the receiver the process builds from the same environment.
        const receiver = settings.evaluator({ NS_PGSTREAM_RECEIVER_URL: out.url }).pgstream.receiver;
        const profile = processProfile(out.slice, receiver);
        assert.equal(profile.ordinal, ordinal); assert.equal(profile.count, k);
        profiles.push(profile);
        // The receiver host is an intake Service that selects exactly this Pod.
        const host = new URL(out.url), svc = services.find(v => v.metadata.name === host.hostname);
        assert(svc, 'intake Service ' + host.hostname);
        assert.equal(svc.spec.selector['statefulset.kubernetes.io/pod-name'], 'evaluator-' + ordinal);
        assert.equal(svc.spec.publishNotReadyAddresses, true);
        assert(svc.spec.ports.some(p => p.port === Number(host.port) && p.targetPort === 'stream-intake'));
      }
      for (const index of [k, -1, 'x']) assert.equal(shim(container.command, index).status, 64, 'index ' + index + ' refused');
      const owners = tenants.map(tenant => profiles.filter(p => slice.predicate(p.count, p.ordinal)(tenant)).map(p => p.ordinal));
      assert(owners.every(list => list.length === 1), 'K=' + k + ': every tenant has exactly one owning Pod');
      assert.deepEqual([...new Set(owners.flat())].sort(), profiles.map(p => p.ordinal), 'K=' + k + ': every Pod owns a slice');
      // pgstream.yaml as the image renders it under NS_EVALUATOR_WORKERS=k (render.js -> descriptor -> wire).
      const assignment = { count: k, ordinal: 0, receivers: roster.map(row => row.url) };
      const wire = stream.wire({ pgstream: { transactionRows: 10000, slot: 'slot', receiver: settings.evaluator({ NS_PGSTREAM_RECEIVER_URL: roster[0].url }).pgstream.receiver }, processAssignment: assignment },
        'postgres://pgstream@postgres:5432/db', { routes: [{ schema: 's', table: 't' }] });
      const receivers = wire.target.webhooks.notifier.transaction_batch.slice_receivers;
      assert.deepEqual(receivers, profiles[0].receivers.map(url => url + 'pgstream'));
      for (const url of receivers) assert(services.some(v => v.metadata.name === new URL(url).hostname), url + ' has a Service');
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
