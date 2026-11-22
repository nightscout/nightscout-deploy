'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),inputs=JSON.parse(fs.readFileSync(path.join(root,'environments/synthetic/inputs.json')));
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
  // Memory is planned from max_connections (default render: budget 176, so 132Mi + 2 x 36).
  const planned = { ...profile.postgres, memory: '204Mi' };
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
    assert.equal(mib(pg.resources.requests.memory), 132 + 2 * (max - 140));
    table.push([k, budget, max, pg.resources.requests.memory]);
  }
  assert.deepEqual(table.map(row => row[1]), [205, 248, 334, 506]);
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

test('evaluator memory request and resident limit follow the tenants each slice owns', () => {
  for (const [tenants, k] of [[10000, 8], [10000, 1], [1000, 2], [1001, 2], [100, 4]]) {
    const r = render({ tenantCount: tenants, slices: { evaluator: k, realtime: k } });
    assert.equal(r.status, 0, r.error);
    const owned = Math.ceil(tenants / k);
    const evaluator = roleContainer(r.value, 'evaluator');
    assert.deepEqual(envOf(evaluator, 'NS_EVALUATOR_RESIDENT_MAX'), [String(owned)]);
    assert.equal(evaluator.resources.requests.memory, Math.ceil(195 + 1.85 * owned) + 'Mi');
    assert.equal(evaluator.resources.limits, undefined, 'requests only, no limit');
  }
  const refit = render({ tenantCount: 10000, slices: { evaluator: 8, realtime: 8 }, evaluatorMemory: { baseMiB: 210, perResidentMiB: 1.2 } });
  assert.equal(refit.status, 0, refit.error);
  assert.equal(roleContainer(refit.value, 'evaluator').resources.requests.memory, Math.ceil(210 + 1.2 * 1250) + 'Mi');
  // An operator roleEnv value replaces the rendered resident limit, never duplicates it.
  const pinned = render({ tenantCount: 1000, roleEnv: { evaluator: [{ name: 'NS_EVALUATOR_RESIDENT_MAX', value: '256' }] } });
  assert.deepEqual(envOf(roleContainer(pinned.value, 'evaluator'), 'NS_EVALUATOR_RESIDENT_MAX'), ['256']);
  for (const evaluatorMemory of [{ baseMiB: 0 }, { perResidentMiB: -1 }]) {
    const bad = render({ evaluatorMemory });
    assert.notEqual(bad.status, 0);
    assert.match(bad.error, /evaluatorMemory/);
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
