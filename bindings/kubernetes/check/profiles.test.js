'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),inputs=JSON.parse(fs.readFileSync(path.join(root,'environments/synthetic/inputs.json')));
function evalPlan(c){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ns-k8s-plan-'));
  try{
    fs.mkdirSync(path.join(dir,'environments/test'),{recursive:true});
    fs.writeFileSync(path.join(dir,'jsonnetfile.json'),'{"version":1,"dependencies":[],"legacyImports":true}');
    fs.copyFileSync(path.join(root,'environments/synthetic/spec.json'),path.join(dir,'environments/test/spec.json'));
    fs.writeFileSync(path.join(dir,'environments/test/main.jsonnet'),`local p=(import ${JSON.stringify(path.join(root,'lib/ns/connection-budget.libsonnet'))}).plan(${JSON.stringify(c)});p.evaluator+{command:p.evaluatorCommand}`);
    const r=spawnSync('tk',['eval','environments/test'],{cwd:dir,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
function render(overrides){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ns-k8s-profile-'));
  try{
    fs.mkdirSync(path.join(dir,'environments/test'),{recursive:true});
    fs.writeFileSync(path.join(dir,'jsonnetfile.json'),'{"version":1,"dependencies":[],"legacyImports":true}');
    fs.copyFileSync(path.join(root,'environments/synthetic/spec.json'),path.join(dir,'environments/test/spec.json'));
    fs.writeFileSync(path.join(dir,'environments/test/main.jsonnet'),`local ns=import ${JSON.stringify(path.join(root,'lib/ns/nightscout.libsonnet'))};ns.new(std.mergePatch(${JSON.stringify(inputs)},${JSON.stringify(overrides)}))`);
    const r=spawnSync('tk',['eval','environments/test'],{cwd:dir,encoding:'utf8'});return {status:r.status,error:r.stderr,value:r.status===0?JSON.parse(r.stdout):null};
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('request defaults and authored overrides reach the rendered container', () => {
  const profile = require('../lib/ns/typical-requests.json');
  const unpinned = { placement: {}, placementByWorkload: {} };
  const defaults = render({ ...unpinned, resources: null });
  assert.equal(defaults.status, 0, defaults.error);
  const pod = defaults.value.postgres.statefulset.spec.template.spec;
  const postgres = pod.containers.find(actor => actor.name === 'postgres');
  // Memory is planned from max_connections and the memory-backed /dev/shm (default render: budget 176,
  // so 132Mi + 2 x 36 + 1024).
  const planned = { ...profile.postgres, memory: '1228Mi' };
  assert.deepEqual(postgres.resources, { requests: planned });
  assert.equal(pod.nodeName, undefined);
  const tuned = render({ resources: { postgres: { requests: { cpu: '42m' } } } });
  assert.equal(tuned.status, 0, tuned.error);
  const actual = tuned.value.postgres.statefulset.spec.template.spec.containers.find(actor => actor.name === 'postgres');
  assert.deepEqual(actual.resources, { requests: { ...planned, cpu: '42m' } });
  const authored = render({ resources: { postgres: { requests: { memory: '1Gi' } } } });
  assert.equal(authored.value.postgres.statefulset.spec.template.spec.containers.find(actor => actor.name === 'postgres').resources.requests.memory, '1Gi');
});

const pgArgs = manifests => manifests.postgres.statefulset.spec.template.spec.containers.find(c => c.name === 'postgres').args;
const roleContainer = (manifests, role) => {
  const w = manifests.components[role];
  return (w.statefulset || w.deployment).spec.template.spec.containers.find(c => c.name === role);
};
const envOf = (container, name) => container.env.filter(row => row.name === name).map(row => row.value);
const mib = q => q.endsWith('Gi') ? Number(q.slice(0, -2)) * 1024 : Number(q.slice(0, -2));

// Formula (connection-budget.libsonnet), written out independently here:
//   per pod: api 2*P_api + 10 + P_op; realtime P_rt + 5 + P_op; evaluator P_ev + P_read + 6 + P_op;
//   tenant-admin 40; admin 15; transient 3 per serving Pod; superuser 3; clinical reserve 40.
function expectedBudget ({ api = 1, k = 1, ke = k, pools = {} } = {}) {
  const p = { api: 4, realtime: 4, evaluator: 4, operation: 8, read: 2, ...pools };
  const pools_ = api * (2 * p.api + 10 + p.operation) + k * (p.realtime + 5 + p.operation) +
    ke * (p.evaluator + p.read + 6 + p.operation) + 40 + 15;
  return pools_ + 3 * (api + k + ke + 2) + 3 + 40;
}

test('PostgreSQL max_connections is the rendered connection budget, never below 140', () => {
  const table = [];
  for (const k of [1, 2, 4, 8]) {
    const r = render({ apiReplicas: 2, slices: { evaluator: k, realtime: k } });
    assert.equal(r.status, 0, r.error);
    const budget = expectedBudget({ api: 2, k });
    const max = Math.max(140, budget);
    assert.ok(pgArgs(r.value).includes('max_connections=' + max), 'K=' + k + ' ' + pgArgs(r.value).join(' '));
    assert.ok(pgArgs(r.value).includes('reserved_connections=40'));
    const pg = r.value.postgres.statefulset.spec.template.spec.containers.find(c => c.name === 'postgres');
    assert.equal(mib(pg.resources.requests.memory), 132 + 2 * (max - 140) + 1024);
    table.push([k, budget, max, pg.resources.requests.memory]);
  }
  assert.deepEqual(table.map(row => row[1]), [205, 248, 334, 506]);
});

// Evaluator K above 8 (realtime stays at its own bound of 8): 23 connections per evaluator Pod
// (pool 4 + read 2 + fixed 6 + operation 8 + transient 3) on top of 322 for two api Pods, eight
// realtime Pods, tenant-admin, admin and the two reserves.
test('evaluator K=9,16,20,32 with realtime K=8: max_connections is the budget, written out per K', () => {
  const table = [];
  for (const ke of [9, 16, 20, 32]) {
    const r = render({ tenantCount: 10000, apiReplicas: 2, slices: { evaluator: ke, realtime: 8 } });
    assert.equal(r.status, 0, r.error);
    const budget = expectedBudget({ api: 2, k: 8, ke });
    assert.equal(budget, 322 + 23 * ke, 'K=' + ke);
    assert.ok(pgArgs(r.value).includes('max_connections=' + budget), 'K=' + ke + ' ' + pgArgs(r.value).join(' '));
    assert.ok(pgArgs(r.value).includes('reserved_connections=40'));
    assert.equal(r.value.components.evaluator.statefulset.spec.replicas, ke);
    assert.equal(r.value.components.realtime.statefulset.spec.replicas, 8);
    const pg = r.value.postgres.statefulset.spec.template.spec.containers.find(c => c.name === 'postgres');
    const evaluator = roleContainer(r.value, 'evaluator');
    assert.equal(evaluator.resources.limits, undefined, 'requests only, no limit');
    assert.ok(heapOf(evaluator) >= mib(evaluator.resources.requests.memory), 'heap ceiling at or above the request');
    for (const label of ['a', 'b', 'c']) assert.equal(shortfall(r, roster(10000, label), ke), 0, `10000/${ke}/${label}`);
    table.push([ke, budget, residentOf(r), evaluator.resources.requests.memory, heapOf(evaluator), pg.resources.requests.memory]);
    // Red control: one connection below the budget refuses to render at this K.
    const under = render({ tenantCount: 10000, apiReplicas: 2, slices: { evaluator: ke, realtime: 8 }, postgresMaxConnections: budget - 1 });
    assert.notEqual(under.status, 0, 'K=' + ke);
    assert.match(under.error, new RegExp('below the connection budget ' + budget));
  }
  assert.deepEqual(table, [
    [9, 529, 1253, '5454Mi', 8181, '1934Mi'],
    [16, 690, 734, '3918Mi', 5877, '2256Mi'],
    [20, 782, 599, '3519Mi', 5279, '2440Mi'],
    [32, 1058, 391, '2903Mi', 4355, '2992Mi'],
  ]);
  const over = render({ tenantCount: 10000, apiReplicas: 2, slices: { evaluator: 33, realtime: 8 } });
  assert.notEqual(over.status, 0);
  assert.match(over.error, /slices.evaluator must be an integer 1..32/);
});

test('PostgreSQL has a memory-backed /dev/shm of 1 GiB and its memory request includes it', () => {
  const profile = require('../lib/ns/typical-requests.json');
  for (const overrides of [{}, { tenantCount: 10000, apiReplicas: 2, slices: { evaluator: 20, realtime: 8 } }]) {
    const r = render({ resources: null, ...overrides });
    assert.equal(r.status, 0, r.error);
    const pod = r.value.postgres.statefulset.spec.template.spec;
    const postgres = pod.containers.find(actor => actor.name === 'postgres');
    assert.deepEqual(postgres.volumeMounts.filter(m => m.mountPath === '/dev/shm'), [{ name: 'dshm', mountPath: '/dev/shm' }]);
    const volumes = pod.volumes.filter(v => v.name === 'dshm');
    assert.deepEqual(volumes, [{ name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '1024Mi' } }]);
    // A memory-backed volume is charged to the Pod, so the request holds the whole volume.
    const max = Number(pgArgs(r.value).find(a => a.startsWith('max_connections=')).split('=')[1]);
    assert.equal(mib(postgres.resources.requests.memory), mib(profile.postgres.memory) + 2 * (max - 140) + mib(volumes[0].emptyDir.sizeLimit));
    assert.equal(postgres.resources.limits, undefined, 'requests only, no limit');
  }
});

test('pool settings reach each role as NS_POOL_<ROLE>_MAX and move the budget', () => {
  const pools = { api: 6, realtime: 3, evaluator: 5, operation: 2, read: 1 };
  const r = render({ apiReplicas: 2, slices: { evaluator: 4, realtime: 4 }, pools });
  assert.equal(r.status, 0, r.error);
  assert.deepEqual(envOf(roleContainer(r.value, 'api'), 'NS_POOL_API_MAX'), ['6']);
  assert.deepEqual(envOf(roleContainer(r.value, 'realtime'), 'NS_POOL_REALTIME_MAX'), ['3']);
  assert.deepEqual(envOf(roleContainer(r.value, 'evaluator'), 'NS_POOL_EVALUATOR_MAX'), ['5']);
  assert.deepEqual(envOf(roleContainer(r.value, 'evaluator'), 'NS_POOL_READ_MAX'), ['1']);
  for (const role of ['api', 'realtime', 'evaluator', 'tenant-admin']) {
    assert.deepEqual(envOf(roleContainer(r.value, role), 'NS_POOL_OPERATION_MAX'), ['2'], role);
  }
  assert.ok(pgArgs(r.value).includes('max_connections=' + Math.max(140, expectedBudget({ api: 2, k: 4, pools }))));
});

test('an explicit max_connections below the budget refuses to render (red control)', () => {
  const k8 = expectedBudget({ api: 2, k: 8 });
  const over = render({ apiReplicas: 2, slices: { evaluator: 8, realtime: 8 }, postgresMaxConnections: k8 - 1 });
  assert.notEqual(over.status, 0);
  assert.match(over.error, /below the connection budget 506/);
  const exact = render({ apiReplicas: 2, slices: { evaluator: 8, realtime: 8 }, postgresMaxConnections: k8 });
  assert.equal(exact.status, 0, exact.error);
  const bigPools = render({ postgresMaxConnections: 240, pools: { operation: 100 } });
  assert.notEqual(bigPools.status, 0);
  assert.match(bigPools.error, /below the connection budget/);
  const roomy = render({ postgresMaxConnections: 400 });
  assert.equal(roomy.status, 0, roomy.error);
  assert.ok(pgArgs(roomy.value).includes('max_connections=400'));
});

test('PostgreSQL sizing requires an integer and leaves room for ordinary connections', () => {
  for (const max of [43, 10001, 140.5, '240', false]) {
    const r = render({ postgresMaxConnections: max });
    assert.notEqual(r.status, 0);
    assert.match(r.error, /postgresMaxConnections/);
  }
  for (const pools of [{ api: 0 }, { evaluator: 1 }, { other: 2 }, { read: 1.5 }]) {
    const r = render({ pools });
    assert.notEqual(r.status, 0, JSON.stringify(pools));
    assert.match(r.error, /pools/);
  }
});

// core lib/pool-membership/slice.js bucket(): sha256(id) first 8 bytes big-endian, modulo K.
const bucket = (id, k) => Number(crypto.createHash('sha256').update(id, 'utf8').digest().readBigUInt64BE(0) % BigInt(k));
// Deterministic synthetic roster of UUID-shaped ids (no user data).
const roster = (n, label) => Array.from({ length: n }, (_, i) => {
  const h = crypto.createHash('sha256').update(label + ':' + i).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), '4' + h.slice(13, 16), '8' + h.slice(17, 20), h.slice(20, 32)].join('-');
});
const busiest = (ids, k) => { const c = new Array(k).fill(0); for (const id of ids) c[bucket(id, k)]++; return Math.max(...c); };
const residentOf = r => Number(envOf(roleContainer(r.value, 'evaluator'), 'NS_EVALUATOR_RESIDENT_MAX')[0]);
// The binding must hold the busiest slice of a hash-owned roster; returns the shortfall.
const shortfall = (r, ids, k) => Math.max(0, busiest(ids, k) - residentOf(r));

test('evaluator memory request and resident limit bound the busiest slice, not the mean', () => {
  for (const [tenants, k] of [[10000, 8], [10000, 1], [1000, 2], [1001, 2], [100, 4], [100, 2], [10000, 4], [4000, 8]]) {
    const r = render({ tenantCount: tenants, slices: { evaluator: k, realtime: k } });
    assert.equal(r.status, 0, r.error);
    const mean = tenants / k;
    const bound = Math.min(tenants, Math.ceil(mean + 4.5 * Math.sqrt(mean * (1 - 1 / k))));
    const evaluator = roleContainer(r.value, 'evaluator');
    assert.deepEqual(envOf(evaluator, 'NS_EVALUATOR_RESIDENT_MAX'), [String(bound)]);
    assert.ok(bound >= Math.ceil(mean), 'never below the mean');
    if (k === 1) assert.equal(bound, tenants, 'K=1 owns every tenant');
    const request = Math.ceil(1745 + 2.96 * bound);
    assert.equal(evaluator.resources.requests.memory, request + 'Mi');
    assert.equal(evaluator.resources.limits, undefined, 'requests only, no limit');
    assert.deepEqual(evaluator.command, ['node', '--max-old-space-size=' + Math.ceil(1.5 * request), 'deploy/multitenant/entrypoint.js', 'evaluator']);
    // Occupancy: hash-owned rosters (any ids) fit the rendered limit.
    for (const label of ['a', 'b', 'c']) assert.equal(shortfall(r, roster(tenants, label), k), 0, `${tenants}/${k}/${label}`);
  }
  // 10k at K=8: 1,399 resident (mean 1,250; simulation worst of 300 rosters 1,374).
  assert.equal(residentOf(render({ tenantCount: 10000, slices: { evaluator: 8, realtime: 8 } })), 1399);
  // Red control: a limit of ceil(tenants / K) (z = 0) leaves a hash-owned roster over its limit.
  for (const [tenants, k] of [[10000, 8], [100, 4], [1000, 2]]) {
    const mean = render({ tenantCount: tenants, slices: { evaluator: k, realtime: k }, residentHeadroomZ: 0 });
    assert.equal(mean.status, 0, mean.error);
    assert.equal(residentOf(mean), Math.ceil(tenants / k));
    assert.ok(shortfall(mean, roster(tenants, 'a'), k) > 0, `ceil(n/K) must fail the occupancy check at ${tenants}/${k}`);
  }
  for (const residentHeadroomZ of [-1, 11, 'x']) assert.notEqual(render({ residentHeadroomZ }).status, 0);
  const refit = render({ tenantCount: 10000, slices: { evaluator: 8, realtime: 8 }, evaluatorMemory: { baseMiB: 210, perResidentMiB: 1.2 } });
  assert.equal(refit.status, 0, refit.error);
  assert.equal(roleContainer(refit.value, 'evaluator').resources.requests.memory, Math.ceil(210 + 1.2 * 1399) + 'Mi');
  assert.equal(heapOf(roleContainer(refit.value, 'evaluator')), Math.ceil(1.5 * Math.ceil(210 + 1.2 * 1399)), 'the heap ceiling follows a refit request');
  // An operator roleEnv value replaces the rendered resident limit, never duplicates it.
  const pinned = render({ tenantCount: 1000, roleEnv: { evaluator: [{ name: 'NS_EVALUATOR_RESIDENT_MAX', value: '256' }] } });
  assert.deepEqual(envOf(roleContainer(pinned.value, 'evaluator'), 'NS_EVALUATOR_RESIDENT_MAX'), ['256']);
  for (const evaluatorMemory of [{ baseMiB: 0 }, { perResidentMiB: -1 }, { heapHeadroom: 0.9 }, { heapHeadroom: 5 }]) {
    const bad = render({ evaluatorMemory });
    assert.notEqual(bad.status, 0);
    assert.match(bad.error, /evaluatorMemory/);
  }
});

const heapOf = container => {
  const flags = container.command.filter(arg => arg.startsWith('--max-old-space-size='));
  assert.equal(flags.length, 1, 'one heap flag');
  return Number(flags[0].split('=')[1]);
};

// Discovery 2026-11-21/22: on 1,000 v2-history tenants at K=1 the evaluator ended at V8's default
// heap ceiling (Mark-Compact 4,049.5 -> 4,022.6 MB, "JavaScript heap out of memory", exit 139) with no
// --max-old-space-size and a 2,045 Mi request. The planned ceiling must sit above the request.
const DEFAULT_V8_HEAP_MB = 4050;
test('evaluator V8 heap ceiling: 10k tenants at K=8 sits above the request and the default ceiling', () => {
  const r = render({ tenantCount: 10000, apiReplicas: 2, slices: { evaluator: 8, realtime: 8 } });
  assert.equal(r.status, 0, r.error);
  const evaluator = roleContainer(r.value, 'evaluator');
  assert.equal(residentOf(r), 1399);
  assert.equal(evaluator.resources.requests.memory, '5887Mi', 'ceil(1745 + 2.96 x 1399)');
  assert.equal(heapOf(evaluator), 8831, 'ceil(1.5 x 5887)');
  assert.deepEqual(evaluator.command, ['node', '--max-old-space-size=8831', 'deploy/multitenant/entrypoint.js', 'evaluator'], 'a node flag, entrypoint run directly');
  assert.ok(heapOf(evaluator) > mib(evaluator.resources.requests.memory) && heapOf(evaluator) > DEFAULT_V8_HEAP_MB);
  assert.equal(evaluator.resources.limits, undefined, 'requests only, no limit');
  assert.ok(!envOf(evaluator, 'NODE_OPTIONS').length, 'no NODE_OPTIONS');
  // Every measured v2 peak (window levers on) is at or below the request model.
  for (const [residents, rssMiB] of [[223, 1769.7], [252, 1843.6], [254, 1446.4], [271, 1527.3], [475, 3148.6], [525, 3219.8], [968, 4112.0], [1000, 4263.5], [1032, 4173.3]]) {
    assert.ok(Math.ceil(1745 + 2.96 * residents) >= rssMiB, residents + ' residents: ' + rssMiB + ' MiB');
  }
  // Red control: the previous model (195 + 1.85 x residents) plans below the measured 1,000-resident peak.
  assert.ok(195 + 1.85 * 1000 < 4263.5);
});

test('evaluator V8 heap ceiling: 10k tenants at K=20 (realtime K=8) renders its plan; K=33 is refused', () => {
  const r = render({ tenantCount: 10000, apiReplicas: 2, slices: { evaluator: 20, realtime: 8 } });
  assert.equal(r.status, 0, r.error);
  const evaluator = roleContainer(r.value, 'evaluator');
  assert.equal(r.value.components.evaluator.statefulset.spec.replicas, 20);
  assert.equal(residentOf(r), 599);
  assert.equal(evaluator.resources.requests.memory, '3519Mi', 'ceil(1745 + 2.96 x 599)');
  assert.deepEqual(evaluator.command, ['node', '--max-old-space-size=5279', 'deploy/multitenant/entrypoint.js', 'evaluator']);
  assert.equal(evaluator.resources.limits, undefined, 'requests only, no limit');
  // Red control for the raised bound: K=33 is refused; realtime keeps 1..8.
  const over = render({ tenantCount: 10000, slices: { evaluator: 33, realtime: 8 } });
  assert.notEqual(over.status, 0);
  assert.match(over.error, /slices.evaluator must be an integer 1..32/);
  const realtime = render({ tenantCount: 10000, slices: { evaluator: 20, realtime: 9 } });
  assert.notEqual(realtime.status, 0);
  assert.match(realtime.error, /slices.realtime must be an integer 1..8/);
  // The memory plan alone (connection-budget.libsonnet) agrees with the render.
  const plan = evalPlan({ tenantCount: 10000, apiReplicas: 2, slices: { evaluator: 20, realtime: 8 } });
  assert.equal(plan.residentMax, 599);
  assert.equal(plan.memoryRequestMiB, 3519, 'ceil(1745 + 2.96 x 599)');
  assert.equal(plan.heapMiB, 5279, 'ceil(1.5 x 3519)');
  assert.deepEqual(plan.command, ['node', '--max-old-space-size=5279', 'deploy/multitenant/entrypoint.js', 'evaluator']);
});

test('roleEnv cannot set NODE_OPTIONS or the other names the Compose role environment refuses', () => {
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'PATH', 'LD_PRELOAD', 'NS_ENV_FILE']) {
    const r = render({ roleEnv: { evaluator: [{ name, value: '--max-old-space-size=1' }] } });
    assert.notEqual(r.status, 0, name);
    assert.match(r.error, /roleEnv may not set NODE_OPTIONS/);
  }
});

test('separated roles start without a tenant Job gate and have independent probes', () => {
  const result = render({});
  assert.equal(result.status, 0, result.error);
  for (const [role, component] of Object.entries(result.value.components)) {
    const pod = (component.deployment || component.statefulset).spec.template.spec;
    const actor = pod.containers.find(c => c.name === role);
    const startupPath = role === 'tenant-admin' ? '/healthz/ready' : '/healthz/isolation';
    assert.deepEqual(actor.startupProbe.httpGet, { path: startupPath, port: 'int-role' }, role);
    assert.deepEqual(actor.readinessProbe.httpGet, { path: '/healthz/ready', port: 'int-role' });
    assert.deepEqual(actor.livenessProbe.httpGet, { path: '/healthz/live', port: 'int-role' });
    assert.ok(!pod.initContainers.some(c => c.name === 'wait-for-jobs'));
  }
  const budget = result.value.budget;
  assert.ok(Number(budget.resourceQuota.spec.hard.pods) >= 2 * (4 + 3));
  assert.deepEqual(budget.limitRange.spec.limits[0], {
    type:'Container', defaultRequest:{cpu:'25m', memory:'32Mi','ephemeral-storage':'16Mi'}
  });
});

test('existing claims and placement remain explicit without new provider resources',()=>{
  const r=render({storage:{mode:'existing-claim',claims:{postgres:'synthetic-existing-pg',vault:'synthetic-existing-vault',provisionState:'synthetic-existing-state'}},placement:{nodeName:'synthetic-existing-node'},placementByWorkload:{realtime:{nodeSelector:{'synthetic.example/purpose':'commissioning'}}}});
  assert.equal(r.status,0,r.error);const x=r.value;
  for(const name of ['postgres','vault']){assert.ok(!x[name].statefulset.spec.volumeClaimTemplates);assert.equal(x[name].statefulset.spec.template.spec.volumes.find(v=>v.name==='data').persistentVolumeClaim.claimName,name==='postgres'?'synthetic-existing-pg':'synthetic-existing-vault');}
  assert.ok(!x.provision.state);assert.equal(x.provision.job.spec.template.spec.volumes.find(v=>v.name==='state').persistentVolumeClaim.claimName,'synthetic-existing-state');
  assert.equal(x.components.realtime.statefulset.spec.template.spec.nodeName,'synthetic-existing-node');assert.equal(x.components.realtime.statefulset.spec.template.spec.nodeSelector['synthetic.example/purpose'],'commissioning');
  assert.deepEqual(x.primer.job.spec.template.spec.imagePullSecrets,[{name:'synthetic-registry-reference'}]);
});
test('legacy standard dynamic storage still renders its claims',()=>{
  const r=render({profile:'standard',storage:{mode:'dynamic'}});assert.equal(r.status,0,r.error);
  assert.equal(r.value.postgres.statefulset.spec.volumeClaimTemplates.length,1);assert.equal(r.value.vault.statefulset.spec.volumeClaimTemplates.length,1);assert.equal(r.value.provision.state.kind,'PersistentVolumeClaim');
});
test('existing capacity refuses dynamic storage, public edge and missing existing claims',()=>{
  for(const [patch,symptom] of [[{storage:{mode:'dynamic'}},/forbids dynamic storage/],[{edge:{serviceType:'LoadBalancer'}},/forbids dynamic storage/],[{storage:{mode:'existing-claim'}},/Field does not exist: postgres/]]){
    const r=render(patch);assert.notEqual(r.status,0);assert.match(r.error,symptom);
  }
  assert.equal(render({storage:{mode:'disposable'}}).status,0,'restored profile green');
});

test('only the lab client argument changes between ten and ten thousand tenants', () => {
  const small = render({ tenantCount: 10 }), large = render({ tenantCount: 10000 });
  for (const result of [small, large]) assert.equal(result.status, 0, result.error);
  function normalize(manifests, expectedCount) {
    const client = manifests.primer.job.spec.template.spec.containers.find(container => container.name === 'primer');
    const count = client.env.find(row => row.name === 'NS_DEMO_TENANTS');
    assert.equal(count.value, String(expectedCount));
    count.value = '';
    // The evaluator plan follows the tenant count (tested above); everything else is identical.
    const evaluator = roleContainer(manifests, 'evaluator');
    evaluator.env.find(row => row.name === 'NS_EVALUATOR_RESIDENT_MAX').value = '';
    evaluator.resources.requests.memory = '';
    evaluator.command = evaluator.command.filter(arg => !arg.startsWith('--max-old-space-size='));
    // The namespace quota sums the requests, so its memory total moves with the evaluator request.
    for (const object of Object.values(manifests.budget)) if (object?.spec?.hard?.['requests.memory']) object.spec.hard['requests.memory'] = '';
    assert.ok(!manifests.verification, 'no verification Job');
    return manifests;
  }
  assert.deepEqual(normalize(small.value, 10), normalize(large.value, 10000));
});

test('fixture requests admit optional per-role limits and claim-backed primer results', () => {
  const fixture = render({});
  assert.equal(fixture.status, 0, fixture.error);
  for (const workload of Object.values(fixture.value)) {
    for (const object of Object.values(workload)) {
      const spec = object?.spec?.template?.spec;
      if (!spec) continue;
      for (const actor of [...(spec.initContainers || []), ...spec.containers]) {
        assert.ok(actor.resources.requests.cpu && actor.resources.requests.memory, actor.name);
        assert.equal(actor.resources.limits, undefined, actor.name);
      }
    }
  }
  const primer = fixture.value.primer.job.spec.template.spec;
  const state = primer.volumes.find(v => v.name === 'client-state');
  // Disposable storage keeps the results on the Pod's disk unless a claim is named.
  assert.deepEqual(state.emptyDir, {});
  assert.ok(!fixture.value.primer.results);
  const claimed = render({ storage: { claims: { primerResults: 'synthetic-results' } } });
  assert.equal(claimed.value.primer.job.spec.template.spec.volumes.find(v => v.name === 'client-state').persistentVolumeClaim.claimName, 'synthetic-results');
  const dynamic = render({ profile: 'standard', storage: { mode: 'dynamic' } });
  assert.equal(dynamic.value.primer.job.spec.template.spec.volumes.find(v => v.name === 'client-state').persistentVolumeClaim.claimName, 'primer-results');
  assert.equal(dynamic.value.primer.results.kind, 'PersistentVolumeClaim');
  const bounded = render({ resources: { vault: { limits: { memory: '384Mi' } } } });
  assert.equal(bounded.status, 0, bounded.error);
  assert.deepEqual(bounded.value.vault.statefulset.spec.template.spec.containers[0].resources.limits, { memory: '384Mi' });
});

test('bootstrap resolves the sealed Vault separately from the serving address', () => {
  const fixture = render({});
  assert.equal(fixture.status, 0, fixture.error);
  const { vault, provision } = fixture.value;
  const probe = vault.statefulset.spec.template.spec.containers[0].readinessProbe.httpGet;
  assert.deepEqual(probe, { scheme: 'HTTPS', port: 'vault', path: '/v1/sys/health?uninitcode=200' });
  // Not headless: its name must resolve before and while the Vault Pod address is published.
  assert.equal(vault.bootstrapService.spec.clusterIP, undefined);
  assert.equal(vault.bootstrapService.spec.publishNotReadyAddresses, true);
  assert.deepEqual(vault.bootstrapService.spec.selector, vault.service.spec.selector);
  assert.equal(vault.service.spec.publishNotReadyAddresses, undefined);
  const bootstrap = provision.job.spec.template.spec.initContainers.find(c => c.name === 'bootstrap');
  const env = Object.fromEntries(bootstrap.env.map(e => [e.name, e.value]));
  assert.equal(new URL(env.NS_BOOTSTRAP_VAULT_ADDR).hostname, vault.bootstrapService.metadata.name);
  assert.equal(new URL(env.VAULT_ADDR).hostname, vault.service.metadata.name);
});

test('fixture copies restore into a fresh namespace through statically bound snapshot handles', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ns-k8s-fixture-'));
  try{
    const parts=['postgres','vault','provisionState','primerResults'];
    const names=Object.fromEntries(parts.map(p=>[p,'fixture-'+p.toLowerCase()]));
    const handles=Object.fromEntries(parts.map(p=>[p,'synthetic-handle-'+p]));
    const sizes=Object.fromEntries(parts.map(p=>[p,'1Gi']));
    const labels={'nightscout.org/run-id':'synthetic-run'};
    fs.writeFileSync(path.join(dir,'jsonnetfile.json'),'{"version":1,"dependencies":[],"legacyImports":true}');
    const file=path.join(dir,'f.jsonnet');
    fs.writeFileSync(file,`local f=import ${JSON.stringify(path.join(root,'lib/ns/fixture.libsonnet'))};
{imported:f.imported('ns-synth-b','dobs.csi.digitalocean.com','do-block-storage',${JSON.stringify(handles)},${JSON.stringify(names)},${JSON.stringify(labels)}),
 claims:f.claims('ns-synth-b','VolumeSnapshot',${JSON.stringify(names)},${JSON.stringify(names)},${JSON.stringify(sizes)},'do-block-storage',${JSON.stringify(labels)}),
 seed:f.volumes('ns-synth-a',${JSON.stringify(names)},${JSON.stringify(sizes)},'do-block-storage',${JSON.stringify(labels)})}`);
    const r=spawnSync('tk',['eval',file],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
    const v=JSON.parse(r.stdout);
    for(const p of parts){
      const [content,snapshot]=v.imported[p];
      assert.equal(content.kind,'VolumeSnapshotContent');assert.equal(content.metadata.namespace,undefined);
      assert.equal(content.spec.deletionPolicy,'Retain');assert.equal(content.spec.source.snapshotHandle,handles[p]);
      assert.deepEqual(content.spec.volumeSnapshotRef,{name:names[p],namespace:'ns-synth-b'});
      assert.equal(snapshot.spec.source.volumeSnapshotContentName,content.metadata.name);
      assert.deepEqual(content.metadata.labels,labels);assert.deepEqual(snapshot.metadata.labels,labels);
      const claim=v.claims[p];
      assert.deepEqual(claim.spec.dataSource,{kind:'VolumeSnapshot',name:names[p],apiGroup:'snapshot.storage.k8s.io'});
      assert.equal(claim.metadata.namespace,'ns-synth-b');
      assert.equal(v.seed[p].spec.dataSource,undefined);assert.equal(v.seed[p].metadata.name,names[p]);
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('provision waits for late stores within the configured Job deadline', async () => {
  const { EventEmitter } = require('node:events');
  const { runInNewContext } = require('node:vm');
  const deadlineSeconds = 600;
  const rendered = render({ provisionDeadlineSeconds: deadlineSeconds });
  assert.equal(rendered.status, 0, rendered.error);
  const job = rendered.value.provision.job.spec;
  assert.equal(job.activeDeadlineSeconds, deadlineSeconds);
  assert.equal(job.backoffLimit, 0);
  const wait = job.template.spec.initContainers.find(container => container.name === 'wait-stores');
  const [executable, flag, script] = wait.command;
  assert.deepEqual([executable, flag], ['node', '-e']);

  // Refuse connections immediately until the indicated store becomes available.
  const readyAt = { postgres: 100000, 'vault-bootstrap': 300000 };
  let elapsed = 0;
  const connected = new Set();
  function connect({host}) {
    assert.ok(Object.hasOwn(readyAt, host));
    const socket = new EventEmitter();
    socket.setTimeout = () => {};
    socket.end = () => {};
    queueMicrotask(() => {
      if (elapsed >= readyAt[host]) {
        connected.add(host);
        socket.emit('connect');
      } else {
        socket.emit('error', new Error('connection refused'));
      }
    });
    return socket;
  }

  await runInNewContext(script, {
    require(name) { assert.equal(name, 'node:net'); return { connect }; },
    setTimeout(resolve, delay) {
      assert.ok(delay > 0);
      elapsed += delay;
      assert.ok(elapsed < deadlineSeconds * 1000);
      queueMicrotask(resolve);
    },
    process: { exit(code) { assert.fail('wait exited ' + code + ' after ' + elapsed + ' ms'); } }
  });
  assert.deepEqual([...connected], ['postgres', 'vault-bootstrap']);
});

test('the binding schema accepts the primer settings used by a long provisioning Job', () => {
  const deadline = 8400;
  const concurrency = 32;
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'inputs.schema.json'), 'utf8'));
  const declaredDeadline = schema.properties.provisionDeadlineSeconds;
  assert.equal(declaredDeadline.type, 'integer');
  assert.ok(deadline >= declaredDeadline.minimum && deadline <= declaredDeadline.maximum,
    'the schema must accept the provisioning deadline');
  const maxJobSeconds = Number(((1n << 63n) - 1n) / 1000000000n);
  assert.equal(declaredDeadline.maximum, maxJobSeconds);
  assert.deepEqual(
    [schema.properties.primerConcurrency?.minimum, schema.properties.primerConcurrency?.maximum],
    [1, 32], 'schema matches the primer CLI range'
  );
  const r = render({ provisionDeadlineSeconds: deadline, primerConcurrency: concurrency });
  assert.equal(r.status, 0, r.error);
  assert.equal(r.value.provision.job.spec.activeDeadlineSeconds, deadline);
  const primer = r.value.primer.job.spec;
  assert.equal(primer.activeDeadlineSeconds, deadline);
  const environment = primer.template.spec.containers[0].env;
  assert.equal(environment.find(variable => variable.name === 'NS_PRIMER_CONCURRENCY').value, String(concurrency));
});

test('the migration timeout belongs only to the bootstrap init container', () => {
  const field = 'migrationStatementTimeoutMs';
  const name = 'NS_MIGRATION_STATEMENT_TIMEOUT_MS';
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'inputs.schema.json')));
  assert.deepEqual([schema.properties[field]?.minimum, schema.properties[field]?.maximum], [1, 600000]);
  const result = render({[field]: 300000});
  assert.equal(result.status, 0, result.error);
  const init = result.value.provision.job.spec.template.spec.initContainers;
  assert.equal(init.find(c => c.name === 'bootstrap').env.find(e => e.name === name)?.value, '300000');
  assert.equal(JSON.stringify(result.value).split(name).length - 1, 1);
  for (const invalid of [0, 600001, 1.5]) assert.notEqual(render({[field]: invalid}).status, 0);
});

test('a declared relation size sets the migration timeout and the provision deadline holds it', () => {
  const name = 'NS_MIGRATION_STATEMENT_TIMEOUT_MS';
  const job = r => { assert.equal(r.status, 0, r.error); return r.value.provision.job.spec; };
  const timeout = spec => spec.template.spec.initContainers.find(c => c.name === 'bootstrap').env.find(e => e.name === name)?.value;
  // Nothing declared: no timeout is passed and the deadline is the default.
  const plain = job(render({}));
  assert.deepEqual([timeout(plain), plain.activeDeadlineSeconds], [undefined, 900]);
  // The measured case: 13,110,624,256 bytes took 59.613 s; the budget is three times that, rounded up.
  const measured = job(render({ migration: { largestRelationBytes: 13110624256 } }));
  assert.deepEqual([timeout(measured), measured.activeDeadlineSeconds], ['179000', 900]);
  assert.ok(Number(timeout(measured)) >= 3 * 59613 && Number(timeout(measured)) < 3 * 59613 + 2000);
  // A small relation keeps the 60 s floor; the rate and the factor are inputs.
  assert.equal(timeout(job(render({ migration: { largestRelationBytes: 1000 } }))), '60000');
  assert.equal(timeout(job(render({ migration: { largestRelationBytes: 1e9, buildBytesPerSecond: 1e7, safetyFactor: 2 } }))), '200000');
  // The deadline follows the budget when it is not authored: timeout x statements + other steps.
  const long = job(render({ migration: { largestRelationBytes: 4e10, longStatements: 2 } }));
  assert.deepEqual([timeout(long), long.activeDeadlineSeconds], ['546000', 546 * 2 + 300]);
  // Refusals: a deadline or an authored timeout below the budget, and a budget core's runner refuses.
  const short = render({ migration: { largestRelationBytes: 4e10 }, provisionDeadlineSeconds: 845 });
  assert.notEqual(short.status, 0);
  assert.match(short.error, /provisionDeadlineSeconds 845 is below the 846 s/);
  assert.equal(job(render({ migration: { largestRelationBytes: 4e10 }, provisionDeadlineSeconds: 846 })).activeDeadlineSeconds, 846);
  const low = render({ migration: { largestRelationBytes: 13110624256 }, migrationStatementTimeoutMs: 100000 });
  assert.match(low.error, /is below the 179000 ms derived/);
  const huge = render({ migration: { largestRelationBytes: 6e10 } });
  assert.match(huge.error, /above the 600000 ms the core migration runner accepts/);
  const tight = render({ migrationStatementTimeoutMs: 600000, provisionDeadlineSeconds: 899 });
  assert.match(tight.error, /provisionDeadlineSeconds 899 is below the 900 s/);
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'inputs.schema.json')));
  assert.deepEqual(Object.keys(schema.properties.migration.properties).sort(),
    ['buildBytesPerSecond', 'largestRelationBytes', 'longStatements', 'otherStepsSeconds', 'safetyFactor']);
});
