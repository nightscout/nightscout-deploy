'use strict';
// Offline render check for the opt-in lab metrics component (lab-metrics.libsonnet): off renders
// exactly what a binding without it renders; on adds one Prometheus Deployment with namespace-only
// discovery RBAC, the postgres_exporter sidecar, NS_METRICS=true on every application role, and
// lets Prometheus reach each role's private listener. Each evaluator ordinal is a scrape target
// because the `<role>-internal` Service selects every Pod of the role.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), inputs = JSON.parse(fs.readFileSync(path.join(root, 'environments/synthetic/inputs.json')));
function render (overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-k8s-labmetrics-'));
  try {
    fs.mkdirSync(path.join(dir, 'environments/test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'jsonnetfile.json'), '{"version":1,"dependencies":[],"legacyImports":true}');
    fs.copyFileSync(path.join(root, 'environments/synthetic/spec.json'), path.join(dir, 'environments/test/spec.json'));
    fs.writeFileSync(path.join(dir, 'environments/test/main.jsonnet'), `local ns=import ${JSON.stringify(path.join(root, 'lib/ns/nightscout.libsonnet'))};ns.new(std.mergePatch(${JSON.stringify(inputs)},${JSON.stringify(overrides)}))`);
    const r = spawnSync('tk', ['eval', 'environments/test'], { cwd: dir, encoding: 'utf8' });
    return { status: r.status, error: r.stderr, value: r.status === 0 ? JSON.parse(r.stdout) : null };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const objects = v => Array.isArray(v) ? v.flatMap(objects) : v && typeof v === 'object' ? (v.apiVersion && v.kind ? [v] : Object.values(v).flatMap(objects)) : [];
const find = (v, kind, name) => objects(v).find(o => o.kind === kind && o.metadata.name === name);
const roles = ['api', 'evaluator', 'realtime', 'tenant-admin'];
const roleContainer = (v, role) => {
  const w = find(v, 'Deployment', role) || find(v, 'StatefulSet', role);
  return w.spec.template.spec.containers.find(x => x.name === role);
};

test('off by default: the render is identical to labMetrics.enabled=false and adds nothing', () => {
  const base = render({}), off = render({ labMetrics: { enabled: false } });
  assert.equal(base.status, 0, base.error);
  assert.deepEqual(off.value, base.value);
  assert.equal(objects(base.value).filter(o => o.metadata.labels?.['app.kubernetes.io/component'] === 'metrics').length, 0);
  for (const role of roles) assert.ok(!roleContainer(base.value, role).env.some(e => e.name === 'NS_METRICS'), role);
  assert.deepEqual(find(base.value, 'StatefulSet', 'postgres').spec.template.spec.containers.map(c => c.name), ['postgres']);
});

test('on: Prometheus, exporter sidecar, NS_METRICS on every role, namespace-only RBAC and reachability', () => {
  const r = render({ labMetrics: { enabled: true }, slices: { evaluator: 2 } });
  assert.equal(r.status, 0, r.error);
  const v = r.value;
  for (const role of roles) assert.deepEqual(roleContainer(v, role).env.filter(e => e.name === 'NS_METRICS'), [{ name: 'NS_METRICS', value: 'true' }], role);
  const prom = find(v, 'Deployment', 'prometheus');
  assert.ok(prom, 'PROMETHEUS_MISSING');
  assert.equal(prom.spec.replicas, 1);
  assert.equal(prom.spec.template.spec.serviceAccountName, 'prometheus');
  assert.ok(prom.spec.template.spec.containers[0].args.includes('--web.enable-admin-api'));
  assert.match(prom.spec.template.spec.containers[0].image, /@sha256:[0-9a-f]{64}$/);
  assert.ok(prom.spec.template.spec.containers[0].resources.requests, 'requests accounted');
  // Namespace-only: a Role and RoleBinding, never a cluster-scoped grant.
  assert.equal(objects(v).filter(o => /^Cluster/.test(o.kind) && o.metadata.name.includes('prometheus')).length, 0);
  assert.equal(find(v, 'RoleBinding', 'prometheus-discovery').roleRef.kind, 'Role');
  const config = find(v, 'ConfigMap', 'prometheus-config').data['prometheus.yml'];
  assert.match(config, /role: endpointslice/);
  assert.match(config, /\(api\|evaluator\|realtime\|tenant-admin\)-internal/);
  assert.match(config, new RegExp('names: \\[' + inputs.namespace + '\\]'));
  // Every role's internal Service selects every Pod of the role (so each ordinal is a target).
  for (const role of roles) assert.deepEqual(find(v, 'Service', role + '-internal').spec.selector['app.kubernetes.io/component'], role);
  assert.equal(find(v, 'StatefulSet', 'evaluator').spec.replicas, 2);
  for (const role of roles) {
    const from = find(v, 'NetworkPolicy', role + '-internal').spec.ingress[0].from.map(f => f.podSelector.matchLabels['app.kubernetes.io/component']);
    assert.ok(from.includes('metrics'), role + ' reachable by metrics');
  }
  const pg = find(v, 'StatefulSet', 'postgres').spec.template.spec;
  assert.deepEqual(pg.containers.map(c => c.name), ['postgres', 'postgres-exporter']);
  assert.ok(pg.containers[1].args.includes('--collector.stat_statements'));
  assert.match(pg.containers[0].lifecycle.postStart.exec.command[2], /-d postgres -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements"/);
  assert.ok(find(v, 'NetworkPolicy', 'postgres-metrics'));
});
