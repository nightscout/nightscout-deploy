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
test('existing claims and placement remain explicit without new provider resources',()=>{
  const r=render({storage:{mode:'existing-claim',claims:{postgres:'synthetic-existing-pg',vault:'synthetic-existing-vault',provisionState:'synthetic-existing-state'}},placement:{nodeName:'synthetic-existing-node'},placementByWorkload:{cohort:{nodeSelector:{'synthetic.example/purpose':'commissioning'}}}});
  assert.equal(r.status,0,r.error);const x=r.value;
  for(const name of ['postgres','vault']){assert.ok(!x[name].statefulset.spec.volumeClaimTemplates);assert.equal(x[name].statefulset.spec.template.spec.volumes.find(v=>v.name==='data').persistentVolumeClaim.claimName,name==='postgres'?'synthetic-existing-pg':'synthetic-existing-vault');}
  assert.ok(!x.provision.state);assert.equal(x.provision.job.spec.template.spec.volumes.find(v=>v.name==='state').persistentVolumeClaim.claimName,'synthetic-existing-state');
  assert.equal(x.cohort.statefulset.spec.template.spec.nodeName,'synthetic-existing-node');assert.equal(x.cohort.statefulset.spec.template.spec.nodeSelector['synthetic.example/purpose'],'commissioning');
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
    const client = manifests.primer.job.spec.template.spec.initContainers.find(container => container.name === 'primer');
    assert.deepEqual(client.args, ['--tenant-count', String(expectedCount)]);
    client.args = [];
    const verification = manifests.verification.job.spec.template.spec;
    assert.deepEqual(verification.initContainers.map(container => container.name), ['install-config']);
    assert.ok(verification.containers[0].command.includes('verify'));
    assert.ok(!manifests.primer.job.spec.template.spec.containers[0].command.includes('verify'));
    return manifests;
  }
  assert.deepEqual(normalize(small.value, 10), normalize(large.value, 10000));
});
