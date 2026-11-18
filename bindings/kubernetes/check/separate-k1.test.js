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
    ['source contract reserialized', x => {const m=x.find(w=>w.kind==='ConfigMap'&&w.metadata.name==='provision-scripts');m.data['source-contract.json']=JSON.stringify(JSON.parse(m.data['source-contract.json']));}, /rendered source-contract.json differs/],
    ['topology mode omitted', x => {const c=x.find(w=>w.kind==='Job'&&w.metadata.name==='provision').spec.template.spec.containers.find(c=>c.name==='done');c.env=c.env.filter(e=>e.name!=='NS_APPLICATION_TOPOLOGY');}, /explicit provision topology/],
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
  assert.equal(projection.data['source-contract.json'], fs.readFileSync(path.join(root,'assets/source-contract.json'),'utf8'), 'source-contract bytes match the immutable binding receipt');
  const done = baseline.all.find(x => x.kind === 'Job' && x.metadata.name === 'provision').spec.template.spec.containers.find(x => x.name === 'done');
  assert.ok(done.env.some(x => x.name === 'NS_APPLICATION_TOPOLOGY' && x.value === 'separate-k1'));
  assert.equal(projection.data['network-documents.cjs'], fs.readFileSync(path.join(root,'ops/network-documents.cjs'),'utf8'));
});
