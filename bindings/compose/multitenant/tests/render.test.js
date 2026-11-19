'use strict';
// Role documents render before apply from seeded credentials (decision provisioning-secrets-in).
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const credentials=require('../credentials'),render=require('../render'),plan=require('../config');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ns-render-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const seeded=path.join(root,'credentials'),output=path.join(root,'state');credentials.seed(seeded);
  return {root,seeded,output,env:{NS_CREDENTIALS_DIR:seeded,NS_RENDER_OUTPUT:output}};
}
const read=(dir,file)=>fs.readFileSync(path.join(dir,file),'utf8');
test('seeded credentials are private hex values, one per role and token, and refuse reuse',t=>{
  const {seeded}=fixture(t),layout=plan.layout(),values=credentials.read(seeded);
  assert.deepEqual(Object.keys(values.postgres).sort(),Object.keys(layout.roles).sort());
  assert.deepEqual(Object.keys(values.vault).sort(),[...credentials.TOKENS].sort());
  const all=[...Object.values(values.postgres),...Object.values(values.vault)];
  assert.equal(new Set(all).size,all.length);
  for(const value of all)assert.match(value,/^[a-f0-9]{64}$/);
  assert.equal(fs.statSync(path.join(seeded,'vault','api')).mode&0o777,0o600);
  assert.throws(()=>credentials.seed(seeded),/EEXIST/);
  fs.writeFileSync(path.join(seeded,'vault','api'),"x' OR '1\n");
  assert.throws(()=>credentials.read(seeded),{code:'SEEDED_CREDENTIAL_INVALID'});
});
test('every role document is rendered from the seeded values and names them',t=>{
  const {seeded,output,env}=fixture(t),values=credentials.read(seeded),layout=plan.layout();
  const result=render.render(render.input(env));
  assert.equal(result.state,'documents-rendered');
  const api=JSON.parse(read(output,'api/env.json'));
  const url=new URL(api.NS_API_PG);assert.equal(url.username,layout.roles.api);assert.equal(url.password,values.postgres.api);
  assert.equal(read(output,'api/vault-token').trim(),values.vault.api);
  assert.equal(read(output,'tenant-admin/vault-token').trim(),values.vault['owner-credentials']);
  assert.equal(read(output,'admin/vault-token').trim(),values.vault.provisioner);
  assert.equal(read(output,'admin/management-vault-token').trim(),values.vault['management-issuer']);
  assert.equal(JSON.parse(read(output,'api/config.json')).vault.tokenFile,'/run/ns-config/vault-token');
  // Role documents are compact; operator files stay indented.
  assert.equal(read(output,'api/config.json'),JSON.stringify(JSON.parse(read(output,'api/config.json')))+'\n');
  assert.match(read(output,'ops/config.json'),/\n  "/);
  for(const role of plan.serviceRoles)assert(!('nativeSelection' in JSON.parse(read(output,role+'/operation.json'))));
  assert(!JSON.stringify(JSON.parse(read(output,'ops/config.json'))).includes('nativeSelection'));
  assert.equal(fs.statSync(path.join(output,'api/env.json')).mode&0o777,0o600);
  assert(!fs.existsSync(path.join(output,'bootstrap')),'rendering writes no provisioning custody');
});
test('rendering again converges in place; the Kubernetes sink and config bound are inputs',t=>{
  const {output,env}=fixture(t);
  render.render(render.input(env));const first=read(output,'evaluator/operation.json');
  render.render(render.input({...env,NS_API_VAULT_TOKEN_FILE:'/run/ns-vault/token'}));
  assert.equal(read(output,'evaluator/operation.json'),first);
  assert.equal(JSON.parse(read(output,'api/config.json')).vault.tokenFile,'/run/ns-vault/token');
  assert.equal(render.input(env).configMaxBytes,undefined);
  assert.equal(render.input({...env,NS_BOOTSTRAP_CONFIG_MAX_BYTES:'4194304'}).configMaxBytes,4194304);
  for(const raw of ['4MiB','65535','67108865'])assert.throws(()=>render.input({...env,NS_BOOTSTRAP_CONFIG_MAX_BYTES:raw}),/BOOTSTRAP_CONFIG_MAX_BYTES_INVALID/);
  assert.throws(()=>render.input({...env,VAULT_ADDR:'http://vault:8200'}),/RENDER_VAULT_HTTPS_REQUIRED/);
  assert.throws(()=>render.input({NS_RENDER_OUTPUT:'/state'}),/RENDER_PATHS_REQUIRED/);
});
