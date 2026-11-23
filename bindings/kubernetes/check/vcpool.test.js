'use strict';
// Offline render check for the opt-in vcpool role (vcpool.libsonnet). Off renders exactly what a
// binding without it renders. On adds one single-replica StatefulSet, its private Service and
// policy, the suspended connector-entry Job, the bootstrap credential mount, the callers it needs
// on postgres, vault, the api's public port and admin, and its pools in the connection budget.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), inputs = JSON.parse(fs.readFileSync(path.join(root, 'environments/synthetic/inputs.json')));
function render (overrides, suffix = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-k8s-vcpool-'));
  try {
    fs.mkdirSync(path.join(dir, 'environments/test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'jsonnetfile.json'), '{"version":1,"dependencies":[],"legacyImports":true}');
    fs.copyFileSync(path.join(root, 'environments/synthetic/spec.json'), path.join(dir, 'environments/test/spec.json'));
    fs.writeFileSync(path.join(dir, 'environments/test/main.jsonnet'), `local ns=import ${JSON.stringify(path.join(root, 'lib/ns/nightscout.libsonnet'))};ns.new(std.mergePatch(${JSON.stringify(inputs)},${JSON.stringify(overrides)}))${suffix}`);
    const r = spawnSync('tk', ['eval', 'environments/test'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });
    return { status: r.status, error: r.stderr, value: r.status === 0 ? JSON.parse(r.stdout) : null };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const objects = v => Array.isArray(v) ? v.flatMap(objects) : v && typeof v === 'object' ? (v.apiVersion && v.kind ? [v] : Object.values(v).flatMap(objects)) : [];
const find = (v, kind, name) => objects(v).find(o => o.kind === kind && o.metadata.name === name);
const from = (v, name) => find(v, 'NetworkPolicy', name).spec.ingress[0].from.map(f => f.podSelector?.matchLabels?.['app.kubernetes.io/component'] ?? f.podSelector?.matchLabels?.['nightscout.org/operator-task']);
const ON = { vcpool: { enabled: true, allowHosts: ['nightscout-upstream'], allowInsecureHttp: true } };

test('off by default: identical to vcpool.enabled=false, nothing named vcpool or connector-entry', () => {
  const base = render({}), off = render({ vcpool: { enabled: false } });
  assert.equal(base.status, 0, base.error);
  assert.deepEqual(off.value, base.value);
  const text = JSON.stringify(base.value);
  assert.ok(!/vcpool|connector-entry/.test(text), 'nothing vcpool-shaped rendered when off');
  assert.equal(render({}, '.inventory').value.connectionBudget.pods.vcpool, undefined);
});

test('on: one StatefulSet replica, its listener, the connector-entry Job and every caller it needs', () => {
  const r = render(ON);
  assert.equal(r.status, 0, r.error);
  const v = r.value, sts = find(v, 'StatefulSet', 'vcpool');
  assert.ok(sts, 'VCPOOL_STATEFULSET_MISSING');
  assert.equal(sts.spec.replicas, 1);
  assert.equal(sts.spec.serviceName, 'vcpool-internal');
  const c = sts.spec.template.spec.containers[0];
  assert.deepEqual(c.command, ['node', 'deploy/multitenant/entrypoint.js', 'vcpool']);
  const env = Object.fromEntries(c.env.map(e => [e.name, e.value]));
  assert.equal(env.NS_VCPOOL_API_URL, 'http://api:1337');
  assert.equal(env.NS_VCPOOL_ALLOW_HOSTS, 'nightscout-upstream');
  assert.equal(env.NS_VCPOOL_ALLOW_INSECURE_HTTP, 'true');
  assert.equal(env.NS_SERVE_INTERNAL_PORT, '19005');
  assert.equal(env.MULTITENANT_VCPOOL_EGRESS_PROXY, undefined);
  assert.equal(env.NS_METRICS, undefined);
  assert.deepEqual(c.ports, [{ name: 'int-role', containerPort: 19005 }]);
  assert.equal(sts.spec.template.spec.volumes.find(x => x.name === 'secret-vcpool').secret.secretName, 'ns-config-vcpool');
  assert.ok(c.resources.requests, 'requests accounted');
  assert.equal(find(v, 'Service', 'vcpool-internal').spec.ports[0].port, 19005);
  assert.deepEqual(from(v, 'vcpool-internal'), ['operator']);
  for (const [policy, caller] of [['postgres-from-app', 'vcpool'], ['vault-from-app', 'vcpool'], ['api-public', 'vcpool'],
    ['api-public', 'operator'], ['admin-from-operator', 'operator']]) {
    assert.ok(from(v, policy).includes(caller), policy + ' admits ' + caller);
  }
  assert.deepEqual(from(v, 'admin-from-operator'), ['operator'], 'the admin plane admits operator Pods only');
  const job = find(v, 'Job', 'connector-entry');
  assert.equal(job.spec.suspend, true);
  assert.equal(job.spec.template.metadata.labels['app.kubernetes.io/component'], 'operator');
  for (const policy of ['postgres-from-app', 'vault-from-app']) assert.ok(!from(v, policy).includes('operator'), 'connector-entry holds no database or Vault credential');
  assert.deepEqual(job.spec.template.spec.volumes.filter(x => x.secret).map(x => x.secret.secretName).sort(), ['ns-connector-entry']);
  assert.equal(job.spec.template.spec.volumes.find(x => x.name === 'client-state').persistentVolumeClaim.claimName, 'primer-results');
  const provision = find(v, 'Job', 'provision').spec.template.spec;
  assert.ok(provision.initContainers.find(x => x.name === 'bootstrap').volumeMounts.some(m => m.mountPath === '/run/ns-credentials/vcpool'));
  assert.equal(provision.volumes.find(x => x.name === 'credentials-vcpool').secret.secretName, 'ns-credentials-vcpool');
  const budget = render(ON, '.inventory').value.connectionBudget, off = render({}, '.inventory').value.connectionBudget;
  assert.equal(budget.pods.vcpool, 1);
  assert.equal(budget.perPod.vcpool, 10);
  assert.equal(budget.budget - off.budget, 10 + 3, 'fixed pools plus the transient readiness clients');
});

test('on: lab metrics or vcpool.metrics serve /metrics on the private listener; an egress proxy is passed through', () => {
  const lab = render({ ...ON, labMetrics: { enabled: true } }).value, own = render({ vcpool: { ...ON.vcpool, metrics: true, egressProxy: 'http://egress:3128' } }).value;
  for (const v of [lab, own]) {
    const env = find(v, 'StatefulSet', 'vcpool').spec.template.spec.containers[0].env;
    assert.deepEqual(env.filter(e => e.name === 'NS_METRICS'), [{ name: 'NS_METRICS', value: 'true' }]);
    assert.ok(from(v, 'vcpool-internal').includes('metrics'));
  }
  const env = find(own, 'StatefulSet', 'vcpool').spec.template.spec.containers[0].env;
  assert.deepEqual(env.filter(e => e.name === 'MULTITENANT_VCPOOL_EGRESS_PROXY'), [{ name: 'MULTITENANT_VCPOOL_EGRESS_PROXY', value: 'http://egress:3128' }]);
});

test('on: refuses an empty source allow-list', () => {
  const r = render({ vcpool: { enabled: true } });
  assert.notEqual(r.status, 0);
  assert.match(r.error, /vcpool.allowHosts must list at least one/);
});

test('on: every binding invariant holds', () => {
  const check = require('./invariants.js');
  const all = objects(render(ON).value), inventory = render(ON, '.inventory').value;
  assert.deepEqual(check.checks(all, inventory).filter(row => row.failures.length).map(row => row.name + ': ' + row.failures.join('; ')), []);
});
