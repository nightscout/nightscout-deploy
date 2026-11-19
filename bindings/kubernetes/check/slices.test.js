'use strict';
// Offline render check (decision statefulset-ordinal-scaling): for realtime K = 1, 2, 3 the
// rendered StatefulSet runs K Pods whose NS_SLICE_ORDINAL is the pod index and whose
// NS_SLICE_COUNT is K; their slices, computed with core's own slice function, are disjoint and
// cover every tenant; at K>1 the socket-edge routes each tenant to its owning Pod.
// NS_TEST_CORE names a core worktree (for lib/pool-membership/slice.js).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), inputs = JSON.parse(fs.readFileSync(path.join(root, 'environments/synthetic/inputs.json')));
const core = process.env.NS_TEST_CORE;
function render (overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-k8s-slices-'));
  try {
    fs.mkdirSync(path.join(dir, 'environments/test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'jsonnetfile.json'), '{"version":1,"dependencies":[],"legacyImports":true}');
    fs.copyFileSync(path.join(root, 'environments/synthetic/spec.json'), path.join(dir, 'environments/test/spec.json'));
    fs.writeFileSync(path.join(dir, 'environments/test/main.jsonnet'), `local ns=import ${JSON.stringify(path.join(root, 'lib/ns/nightscout.libsonnet'))};ns.new(std.mergePatch(${JSON.stringify(inputs)},${JSON.stringify(overrides)}))`);
    const r = spawnSync('tk', ['eval', 'environments/test'], { cwd: dir, encoding: 'utf8' });
    return { status: r.status, error: r.stderr, value: r.status === 0 ? JSON.parse(r.stdout) : null };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const env = (container, name) => container.env.find(row => row.name === name);
const tenants = Array.from({ length: 2000 }, (_, i) => '00000000-0000-4000-8000-' + i.toString(16).padStart(12, '0'));

test('realtime K=1,2,3: one Pod per ordinal, disjoint slices covering every tenant, routing to the owner', { skip: !core && 'NS_TEST_CORE unset' }, () => {
  const { bucket } = require(path.join(core, 'lib/pool-membership/slice'));
  let previous;
  for (const k of [1, 2, 3]) {
    const r = render({ slices: { realtime: k } });
    assert.equal(r.status, 0, r.error);
    const set = r.value.components.realtime.statefulset;
    assert.equal(set.kind, 'StatefulSet');
    assert.equal(set.spec.replicas, k, 'replicas and K come from one value');
    assert.equal(set.spec.updateStrategy.type, 'RollingUpdate');
    const container = set.spec.template.spec.containers.find(x => x.name === 'realtime');
    assert.equal(env(container, 'NS_SLICE_COUNT').value, String(k));
    assert.equal(env(container, 'NS_SLICE_ORDINAL').valueFrom.fieldRef.fieldPath, "metadata.labels['apps.kubernetes.io/pod-index']");
    // The Pods a StatefulSet of `replicas` creates have pod-index 0..replicas-1.
    const pods = Array.from({ length: set.spec.replicas }, (_, ordinal) => ({ ordinal, count: Number(env(container, 'NS_SLICE_COUNT').value) }));
    const owners = tenants.map(tenant => pods.filter(pod => bucket(tenant, pod.count) === pod.ordinal).map(pod => pod.ordinal));
    assert(owners.every(list => list.length === 1), 'K=' + k + ': every tenant has exactly one owning Pod');
    assert.deepEqual([...new Set(owners.flat())].sort(), pods.map(pod => pod.ordinal), 'K=' + k + ': every Pod owns a slice');
    // An extra Pod (bare `kubectl scale` beyond K) owns nothing.
    assert.equal(tenants.filter(tenant => bucket(tenant, k) === k).length, 0);
    const evaluator = r.value.components.evaluator.statefulset;
    assert.equal(evaluator.spec.replicas, 1, 'evaluator stays at K=1');
    if (k === 1) {
      assert.equal(r.value.socketEdge, undefined);
      assert(!env(evaluator.spec.template.spec.containers[0], 'NS_REALTIME_SLICE_PEERS'));
    } else {
      const edge = r.value.socketEdge.deployment.spec.template.spec.containers[0];
      const map = JSON.parse(env(edge, 'NS_REALTIME_STATIC_ROUTE_MAP').value);
      assert.equal(map.count, k); assert.equal(map.upstreams.length, k);
      for (const tenant of tenants.slice(0, 200)) assert.match(map.upstreams[bucket(tenant, k)], new RegExp('^http://realtime-' + bucket(tenant, k) + '\\.realtime-peers\\.'));
      assert.match(r.value.edge.config.data['nginx.conf'], /upstream realtime \{ server socket-edge:1343; \}/);
      const peers = JSON.parse(env(evaluator.spec.template.spec.containers[0], 'NS_REALTIME_SLICE_PEERS').value);
      assert.deepEqual(peers.map(p => p.url), Array.from({ length: k }, (_, i) => 'http://realtime-' + i + '.realtime-peers.' + inputs.namespace + '.svc:19003/'));
    }
    if (previous) {
      // K change: the Pod template changes only in NS_SLICE_COUNT (an ordinary rolling update).
      const strip = t => JSON.stringify(t, (key, value) => key === 'env' ? value.filter(row => row.name !== 'NS_SLICE_COUNT') : value);
      assert.equal(strip(previous.spec.template), strip(set.spec.template));
    }
    previous = set;
  }
});

test('evaluator K>1 refuses to render', () => {
  const r = render({ slices: { evaluator: 2 } });
  assert.notEqual(r.status, 0); assert.match(r.error, /evaluator K>1 is not supported/);
});
