'use strict';
// Fixtures are synthetic recorded API list responses; no cluster call.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { createRequire } = require('node:module');
const fit = require('./fit-check');

const nodes = { items: [{ metadata: { name: 'worker-a' }, spec: {},
  status: { allocatable: { cpu: '4', memory: '8Gi' }, conditions: [{ type: 'Ready', status: 'True' }, { type: 'MemoryPressure', status: 'False' }] } }] };
const pod = (name, cpu, memory, extra = {}) => ({ metadata: { name }, spec: { nodeName: 'worker-a', containers: [{ resources: { requests: { cpu, memory } } }], ...extra.spec }, status: { phase: extra.phase || 'Running' } });
// Peers request 1 CPU and 3 GiB; reserve is 0.6 CPU and 1.6 GiB (20% of 8 GiB).
const pods = { items: [pod('peer-1', '500m', '1Gi'), pod('peer-2', '500m', '2Gi'), pod('done', '4', '8Gi', { phase: 'Succeeded' }),
  { metadata: { name: 'elsewhere' }, spec: { nodeName: 'worker-b', containers: [{ resources: { requests: { cpu: '4', memory: '8Gi' } } }] }, status: { phase: 'Running' } }] };
// Free after reserve: 8 - 3 - 1.6 = 3.4 GiB. 3 GiB fits; 4 GiB fits only without the reserve.
const fitting = { cpu: '1', memory: '3Gi' }, overReserve = { cpu: '1', memory: '4Gi' };

function withoutReserve () {
  const file = require.resolve('./fit-check'), source = fs.readFileSync(file, 'utf8');
  const needle = 'if (committed[d] + want[d] + protectedReserve[d] > allocatable[d])';
  assert.equal(source.split(needle).length, 2, 'RESERVE_CONTROL_SEAM_REQUIRED');
  const value = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + source.replace(/^#!.*\n/, '').replace(needle, 'if (committed[d] + want[d] > allocatable[d])') + '\n})', { filename: file })(createRequire(file), value, value.exports);
  return value.exports;
}
async function criterion (implementation) {
  const namespaces = [];
  const create = async () => { namespaces.push('ns-synthetic'); return 'ns-synthetic'; };
  let refused = null;
  try { await implementation.admit({ request: overReserve, nodes, pods, node: 'worker-a' }, create); } catch (error) { refused = error.code; }
  assert.deepEqual(namespaces, [], 'OVER_RESERVE_REQUEST_MUST_BE_REFUSED_BEFORE_NAMESPACE');
  assert.equal(refused, 'K8S_FIT_REFUSED');
  assert.equal((await implementation.admit({ request: fitting, nodes, pods, node: 'worker-a' }, create)).created, 'ns-synthetic');
  assert.deepEqual(namespaces, ['ns-synthetic']);
}

test('counts only non-terminated Pods on the reserved worker and prints the effective numbers', () => {
  const result = fit.check({ request: fitting, nodes, pods, node: 'worker-a' });
  assert.equal(result.fits, true); assert.equal(result.peerPods, 2);
  assert.deepEqual(result.effective.memoryMiB, { allocatable: 8192, peerRequests: 3072, observedUsage: null, reserve: 1638.4, request: 3072, remainingAfterReserve: 409.6 });
  assert.equal(result.effective.cpu.reserve, 0.6);
});
test('refuses a request above free capacity after the reserve before a Namespace exists; removing the reserve is red', async () => {
  await criterion(fit);
  await assert.rejects(criterion(withoutReserve()), /OVER_RESERVE_REQUEST_MUST_BE_REFUSED_BEFORE_NAMESPACE/);
  console.log('CONTROL RED: OVER_RESERVE_REQUEST_MUST_BE_REFUSED_BEFORE_NAMESPACE (reserve term removed; Namespace created)');
  await criterion(fit);
  console.log('CONTROL RESTORED: K8S_FIT_REFUSED with no Namespace');
});
test('observed usage above requests and node pressure also refuse', () => {
  assert.deepEqual(fit.check({ request: fitting, nodes, pods, node: 'worker-a', usage: { cpu: '1', memory: '4Gi' } }).refusals, ['memory headroom']);
  const pressured = structuredClone(nodes); pressured.items[0].status.conditions[1].status = 'True';
  assert.deepEqual(fit.check({ request: fitting, nodes: pressured, pods, node: 'worker-a' }).refusals, ['node health/pressure/unschedulable']);
  assert.throws(() => fit.check({ request: fitting, nodes, pods, node: 'worker-z' }), { code: 'K8S_FIT_NODE_ABSENT' });
});
test('effective Pod request follows init and sidecar rules', () => {
  const value = fit.podRequest({ spec: { initContainers: [{ restartPolicy: 'Always', resources: { requests: { cpu: '100m', memory: '64Mi' } } },
    { resources: { requests: { cpu: '2', memory: '1Gi' } } }], containers: [{ resources: { requests: { cpu: '500m', memory: '256Mi' } } }], overhead: { cpu: '10m' } } });
  assert.equal(Math.round(value.cpu * 1000), 2110); assert.equal(value.memory, 1024 ** 3 + 64 * 1024 ** 2);
});
test('the command reads recorded files, prints JSON and exits 2 on refusal', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fit-check-'));
  try {
    for (const [name, value] of Object.entries({ nodes, pods, ok: fitting, over: overReserve })) fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(value));
    const run = request => require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, 'fit-check.js'), '--request', path.join(dir, request + '.json'),
      '--nodes', path.join(dir, 'nodes.json'), '--pods', path.join(dir, 'pods.json'), '--node', 'worker-a'], { encoding: 'utf8' });
    const ok = run('ok'), over = run('over');
    assert.equal(ok.status, 0); assert.equal(JSON.parse(ok.stdout).fits, true);
    assert.equal(over.status, 2); assert.equal(JSON.parse(over.stdout).fits, false); assert.match(over.stderr, /K8S_FIT_REFUSED: memory headroom/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
