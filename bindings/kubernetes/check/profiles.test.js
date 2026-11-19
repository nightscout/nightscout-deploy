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
  assert.deepEqual(postgres.resources, { requests: profile.postgres });
  assert.equal(pod.nodeName, undefined);
  const tuned = render({ resources: { postgres: { requests: { cpu: '42m' } } } });
  assert.equal(tuned.status, 0, tuned.error);
  const actual = tuned.value.postgres.statefulset.spec.template.spec.containers.find(actor => actor.name === 'postgres');
  assert.deepEqual(actual.resources, { requests: { ...profile.postgres, cpu: '42m' } });
});

test('separated roles start without a tenant Job gate and have independent probes', () => {
  const result = render({});
  assert.equal(result.status, 0, result.error);
  for (const [role, component] of Object.entries(result.value.components)) {
    const pod = (component.deployment || component.statefulset).spec.template.spec;
    const actor = pod.containers.find(c => c.name === role);
    assert.deepEqual(actor.startupProbe.httpGet, { path: '/healthz/ready', port: 'int-role' });
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
    assert.deepEqual(client.args, ['--tenant-count', String(expectedCount)]);
    client.args = [];
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
  assert.equal(vault.bootstrapService.spec.clusterIP, 'None');
  assert.equal(vault.bootstrapService.spec.publishNotReadyAddresses, true);
  assert.deepEqual(vault.bootstrapService.spec.selector, vault.service.spec.selector);
  assert.equal(vault.service.spec.publishNotReadyAddresses, undefined);
  const bootstrap = provision.job.spec.template.spec.initContainers.find(c => c.name === 'bootstrap');
  const env = Object.fromEntries(bootstrap.env.map(e => [e.name, e.value]));
  assert.equal(new URL(env.NS_BOOTSTRAP_VAULT_ADDR).hostname, vault.bootstrapService.metadata.name);
  assert.equal(new URL(env.VAULT_ADDR).hostname, vault.service.metadata.name);
});
