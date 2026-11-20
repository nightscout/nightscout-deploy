'use strict';
// Offline render check: roleEnv appends extra environment rows to the named role's container only,
// after the binding's own rows, and refuses an unknown role.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), inputs = JSON.parse(fs.readFileSync(path.join(root, 'environments/synthetic/inputs.json')));
function render (overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-k8s-roleenv-'));
  try {
    fs.mkdirSync(path.join(dir, 'environments/test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'jsonnetfile.json'), '{"version":1,"dependencies":[],"legacyImports":true}');
    fs.copyFileSync(path.join(root, 'environments/synthetic/spec.json'), path.join(dir, 'environments/test/spec.json'));
    fs.writeFileSync(path.join(dir, 'environments/test/main.jsonnet'), `local ns=import ${JSON.stringify(path.join(root, 'lib/ns/nightscout.libsonnet'))};ns.new(std.mergePatch(${JSON.stringify(inputs)},${JSON.stringify(overrides)}))`);
    const r = spawnSync('tk', ['eval', 'environments/test'], { cwd: dir, encoding: 'utf8' });
    return { status: r.status, error: r.stderr, value: r.status === 0 ? JSON.parse(r.stdout) : null };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const container = (value, role) => {
  const c = value.components[role];
  return (c.statefulset || c.deployment).spec.template.spec.containers.find(x => x.name === role);
};
test('roleEnv adds rows to the named role only, after the binding rows', () => {
  const base = render({});
  assert.equal(base.status, 0, base.error);
  const rows = [{ name: 'NS_M7_DIAGNOSTICS', value: '1' }, { name: 'NS_PGSTREAM_RECEIVER_TRACE', value: '1' }];
  const r = render({ roleEnv: { evaluator: rows } });
  assert.equal(r.status, 0, r.error);
  const before = container(base.value, 'evaluator').env, after = container(r.value, 'evaluator').env;
  assert.deepEqual(after.slice(0, before.length), before, 'binding rows unchanged and first');
  assert.deepEqual(after.slice(before.length), rows);
  for (const role of ['api', 'realtime', 'tenant-admin']) assert.deepEqual(container(r.value, role).env, container(base.value, role).env, role + ' unchanged');
});
test('roleEnv refuses an unknown role', () => {
  const r = render({ roleEnv: { pgstream: [{ name: 'X', value: '1' }] } });
  assert.notEqual(r.status, 0);
  assert.match(r.error, /roleEnv names an unknown role/);
});
