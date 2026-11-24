'use strict';
// PostgreSQL sizing tiers (lib/ns/postgres-sizing.json) and PostgreSQL on its own node (postgresNode).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), inputs = JSON.parse(fs.readFileSync(path.join(root, 'environments/synthetic/inputs.json')));
const tiers = require('../lib/ns/postgres-sizing.json').tiers;
function render (overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-k8s-pgsizing-'));
  try {
    fs.mkdirSync(path.join(dir, 'environments/test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'jsonnetfile.json'), '{"version":1,"dependencies":[],"legacyImports":true}');
    fs.copyFileSync(path.join(root, 'environments/synthetic/spec.json'), path.join(dir, 'environments/test/spec.json'));
    fs.writeFileSync(path.join(dir, 'environments/test/main.jsonnet'), `local ns=import ${JSON.stringify(path.join(root, 'lib/ns/nightscout.libsonnet'))};local r=ns.new(std.mergePatch(${JSON.stringify(inputs)},${JSON.stringify(overrides)}));r+{inventoryOut: r.inventory}`);
    const r = spawnSync('tk', ['eval', 'environments/test'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });
    return { status: r.status, error: r.stderr, value: r.status === 0 ? JSON.parse(r.stdout) : null };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const pgPod = m => m.postgres.statefulset.spec.template.spec;
const pgContainer = m => pgPod(m).containers.find(c => c.name === 'postgres');
const settingsOf = m => { const a = pgContainer(m).args, out = {}; for (let i = 0; i < a.length; i++) if (a[i] === '-c') { const [k, ...v] = a[i + 1].split('='); out[k] = v.join('='); } return out; };
const podSpecs = (value, out = []) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (['Deployment', 'StatefulSet', 'Job'].includes(value.kind) && value.metadata && value.spec?.template) out.push([value.metadata.name, value.spec.template.spec]);
    else for (const child of Object.values(value)) podSpecs(child, out);
  }
  return out;
};
const node = { nodeSelector: { 'doks.digitalocean.com/node-pool': 'synthetic-pg' }, taint: { key: 'nightscout.org/dedicated', value: 'postgres' } };
const shared = { nodeSelector: { 'doks.digitalocean.com/node-pool': 'synthetic-run' }, tolerations: [{ key: 'capacity', operator: 'Equal', value: 'plancap', effect: 'NoSchedule' }] };

test('no tier and no node: the render is unchanged (postgres keeps the image defaults and the shared placement)', () => {
  const base = render({});
  assert.equal(base.status, 0, base.error);
  assert.deepEqual(Object.keys(settingsOf(base.value)).sort(), ['max_connections', 'reserved_connections', 'shared_preload_libraries', 'track_io_timing']);
  assert.equal(base.value.inventoryOut.postgresSizing, undefined);
  assert.equal(base.value.inventoryOut.postgresNode, undefined);
});

test('no tier and no authored storage.postgres: the claim keeps the default size, never null', () => {
  const r = render({ storage: { mode: 'dynamic' }, profile: 'standard' });
  assert.equal(r.status, 0, r.error);
  assert.equal(r.value.postgres.statefulset.spec.volumeClaimTemplates[0].spec.resources.requests.storage, '1Gi');
  const authored = render({ storage: { mode: 'dynamic', postgres: '3Gi' }, profile: 'standard' });
  assert.equal(authored.status, 0, authored.error);
  assert.equal(authored.value.postgres.statefulset.spec.volumeClaimTemplates[0].spec.resources.requests.storage, '3Gi');
});

for (const name of Object.keys(tiers)) {
  test(`tier ${name}: settings, requests and claim reach postgres; explicit settings win`, () => {
    const t = tiers[name];
    const r = render({ postgresSizing: name, storage: { mode: 'dynamic' }, profile: 'standard', postgresSettings: { random_page_cost: '1.5' } });
    assert.equal(r.status, 0, r.error);
    const s = settingsOf(r.value);
    for (const [k, v] of Object.entries(t.settings)) assert.equal(s[k], k === 'random_page_cost' ? '1.5' : v, k);
    assert.equal(s.track_io_timing, 'on');
    const req = pgContainer(r.value).resources.requests;
    assert.equal(req.cpu, t.requests.cpu);
    assert.equal(req.memory, String(Number(t.requests.memory.slice(0, -2)) * 1024) + 'Mi');
    assert.equal(r.value.postgres.statefulset.spec.volumeClaimTemplates[0].spec.resources.requests.storage, t.claim);
    assert.equal(r.value.inventoryOut.postgresSizing.nodeSize, t.nodeSize);
    const authored = render({ postgresSizing: name, storage: { mode: 'dynamic', postgres: '7Gi' }, profile: 'standard', resources: { postgres: { requests: { cpu: '3' } } } });
    assert.equal(authored.status, 0, authored.error);
    assert.equal(authored.value.postgres.statefulset.spec.volumeClaimTemplates[0].spec.resources.requests.storage, '7Gi');
    assert.equal(pgContainer(authored.value).resources.requests.cpu, '3');
  });
}

test('a tier never sets a binding-owned server setting, and an unknown tier is refused', () => {
  for (const t of Object.values(tiers)) for (const k of ['max_connections', 'reserved_connections', 'shared_preload_libraries', 'track_io_timing']) assert.ok(!(k in t.settings), k);
  const r = render({ postgresSizing: '20k' });
  assert.notEqual(r.status, 0);
  assert.match(r.error, /postgresSizing must be null or one of/);
  const owned = render({ postgresSettings: { track_io_timing: 'off' } });
  assert.notEqual(owned.status, 0);
  assert.match(owned.error, /must not set/);
});

test('postgresNode: postgres alone gets the node selector and the NoSchedule toleration; every other workload keeps the shared placement', () => {
  const r = render({ placement: shared, postgresNode: node });
  assert.equal(r.status, 0, r.error);
  const pod = pgPod(r.value);
  assert.deepEqual(pod.nodeSelector, node.nodeSelector);
  assert.deepEqual(pod.tolerations, [...shared.tolerations, { key: node.taint.key, operator: 'Equal', value: node.taint.value, effect: 'NoSchedule' }]);
  const others = podSpecs(r.value).filter(([name]) => name !== 'postgres');
  assert.ok(others.length > 5);
  for (const [name, spec] of others) {
    assert.deepEqual(spec.nodeSelector, shared.nodeSelector, name);
    assert.ok(!(spec.tolerations || []).some(t => t.key === node.taint.key || (t.operator === 'Exists' && !t.key)), name + ' tolerates the postgres taint');
  }
  assert.deepEqual(r.value.inventoryOut.postgresNode, node);
});

test('postgresNode refuses any other workload that would tolerate the dedicated taint (red controls)', () => {
  const tol = { key: node.taint.key, operator: 'Equal', value: node.taint.value, effect: 'NoSchedule' };
  const viaWorkload = render({ placement: shared, postgresNode: node, placementByWorkload: { api: { tolerations: [tol] } } });
  assert.notEqual(viaWorkload.status, 0);
  assert.match(viaWorkload.error, /only postgres may tolerate the postgres node taint .*api/);
  const viaShared = render({ placement: { ...shared, tolerations: [...shared.tolerations, { operator: 'Exists' }] }, postgresNode: node });
  assert.notEqual(viaShared.status, 0);
  assert.match(viaShared.error, /placement.tolerations must not tolerate/);
  const both = render({ postgresNode: node, placementByWorkload: { postgres: { nodeSelector: { a: 'b' } } } });
  assert.notEqual(both.status, 0);
  assert.match(both.error, /choose one/);
  const pinned = render({ placement: { nodeName: 'synthetic-node' }, postgresNode: node });
  assert.notEqual(pinned.status, 0);
  assert.match(pinned.error, /placement.nodeName/);
  const noExecute = render({ postgresNode: { ...node, taint: { ...node.taint, effect: 'NoExecute' } } });
  assert.notEqual(noExecute.status, 0);
  assert.match(noExecute.error, /effect is always NoSchedule/);
});

// A parallel VACUUM (or other parallel maintenance) allocates a dynamic shared memory segment of up to
// maintenance_work_mem in /dev/shm, beside the 1 GiB the binding plans for parallel query and hash joins.
// Measured (lane L, 2026-11-23): at the 10k tier, VACUUM (PARALLEL 4) failed on the 1 GiB volume with
// "could not resize shared memory segment ... to 1073779488 bytes: No space left on device".
const pgMiB = v => { const m = /^(\d+)\s*(kB|MB|GB|TB)?$/.exec(v); assert.ok(m, 'unparsed ' + v); return Number(m[1]) * { kB: 1 / 1024, MB: 1, GB: 1024, TB: 1024 * 1024 }[m[2] || 'kB']; };
const shmMiB = m => { const v = pgPod(m).volumes.find(x => x.name === 'dshm'); assert.match(v.emptyDir.sizeLimit, /^\d+Mi$/); return Number(v.emptyDir.sizeLimit.slice(0, -2)); };
for (const name of Object.keys(tiers)) {
  test(`tier ${name}: /dev/shm holds a full maintenance segment above the 1 GiB for parallel query, and the request holds the volume`, () => {
    const r = render({ postgresSizing: name, storage: { mode: 'dynamic' }, profile: 'standard' });
    assert.equal(r.status, 0, r.error);
    const mwm = pgMiB(settingsOf(r.value).maintenance_work_mem);
    assert.ok(mwm >= 512, 'every tier sets maintenance_work_mem');
    assert.ok(shmMiB(r.value) >= 1024 + mwm, `${name}: /dev/shm ${shmMiB(r.value)}Mi is not above maintenance_work_mem ${mwm}MiB + 1024MiB`);
    const req = pgContainer(r.value).resources.requests.memory;
    assert.ok(Number(req.slice(0, -2)) >= shmMiB(r.value), 'the memory request holds the memory-backed volume');
  });
}

test('/dev/shm follows an explicit maintenance_work_mem in any PostgreSQL unit; without one it stays 1 GiB', () => {
  for (const [value, expected] of [['4GB', 1024 + 4096], ['262144', 1024 + 256], ['300MB', 1024 + 300], ['524288kB', 1024 + 512]]) {
    const r = render({ postgresSettings: { maintenance_work_mem: value } });
    assert.equal(r.status, 0, r.error);
    assert.equal(shmMiB(r.value), expected, value);
  }
  const base = render({});
  assert.equal(base.status, 0, base.error);
  assert.equal(shmMiB(base.value), 1024);
  const bad = render({ postgresSettings: { maintenance_work_mem: 'lots' } });
  assert.notEqual(bad.status, 0);
  assert.match(bad.error, /maintenance_work_mem/);
});
