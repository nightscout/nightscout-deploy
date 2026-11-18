'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const { checks, manifests } = require('./invariants');
const root = path.resolve(__dirname, '..');
function render() {
  const read = extra => JSON.parse(execFileSync('tk', ['eval', 'environments/separate-k1', ...extra], { cwd: root, encoding: 'utf8', maxBuffer: 16 << 20 }));
  return { all: manifests(read([])), inventory: read(['-e', 'inventory']) };
}
test('separate K1 render detects broken boundaries and restores the same baseline', () => {
  const baseline = render();
  const errors = (all = baseline.all) => checks(all, baseline.inventory).flatMap(x => x.failures.map(f => x.name + ': ' + f));
  assert.deepEqual(errors(), []);
  assert.equal(Object.keys(baseline.inventory.workloads).length, 12);
  const cases = [
    ['second evaluator', x => x.find(w => w.kind === 'Deployment' && w.metadata.name === 'evaluator').spec.replicas = 2, /one Recreate Deployment/],
    ['private edge access', x => x.find(w => w.kind === 'NetworkPolicy' && w.metadata.name === 'api-internal').spec.ingress[0].from.push({podSelector:{matchLabels:{'app.kubernetes.io/component':'edge'}}}), /unauthorized source/],
    ['lost lifecycle path', x => x.find(w => w.kind === 'NetworkPolicy' && w.metadata.name === 'realtime-internal').spec.ingress = [], /lacks a directed lifecycle/],
    ['public internal port', x => x.find(w => w.kind === 'Service' && w.metadata.name === 'api').spec.ports[0].targetPort = 'int-role', /private role port is published/],
    ['socket mount returns', x => x.find(w => w.kind === 'Deployment' && w.metadata.name === 'api').spec.template.spec.volumes.push({name:'ns-ipc',emptyDir:{}}), /must not mount ns-ipc/],
    ['credential crosses roles', x => x.find(w => w.kind === 'Deployment' && w.metadata.name === 'evaluator').spec.template.spec.volumes.push({name:'wrong-role',secret:{secretName:'ns-config-api'}}), /another role credential/],
    ['default deny removed', x => x.splice(x.findIndex(w => w.kind === 'NetworkPolicy' && w.metadata.name === 'default-deny-ingress'),1), /default deny ingress/],
    ['wrong producer routing', x => x.find(w => w.kind === 'Service' && w.metadata.name === 'evaluator').spec.selector['app.kubernetes.io/component'] = 'api', /intake Service/],
  ];
  for (const [name, mutate, symptom] of cases) {
    const broken = structuredClone(baseline.all); mutate(broken);
    assert.ok(errors(broken).some(x => symptom.test(x)), name + ': ' + errors(broken).join('; '));
    assert.deepEqual(errors(), [], name + ' restored');
  }
  const projection = baseline.all.find(x => x.kind === 'ConfigMap' && x.metadata.name === 'provision-scripts');
  assert.equal(JSON.parse(projection.data['source-contract.json']).applicationTopology, 'separate-k1');
  assert.equal(projection.data['network-documents.cjs'], fs.readFileSync(path.join(root,'ops/network-documents.cjs'),'utf8'));
});
