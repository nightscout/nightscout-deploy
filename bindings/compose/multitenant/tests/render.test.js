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
  // The deployment signing secret (decision deployment-signing-secret) is its own seeded file, not Vault material.
  const signing=credentials.signing(seeded);
  assert.match(signing,/^[a-f0-9]{64}$/);
  assert.equal(values.signing,undefined);assert(!fs.existsSync(path.join(seeded,'vault','signing-secret')));
  assert.equal(fs.statSync(path.join(seeded,'signing-secret')).mode&0o777,0o600);
  const all=[...Object.values(values.postgres),...Object.values(values.vault),signing];
  assert.equal(new Set(all).size,all.length);
  for(const value of all)assert.match(value,/^[a-f0-9]{64}$/);
  assert.equal(fs.statSync(path.join(seeded,'vault','api')).mode&0o777,0o600);
  assert.throws(()=>credentials.seed(seeded),/EEXIST/);
  fs.writeFileSync(path.join(seeded,'vault','api'),"x' OR '1\n");
  assert.throws(()=>credentials.read(seeded),{code:'SEEDED_CREDENTIAL_INVALID'});
});
test('extends an existing seed once and mounts the settings login only in tenant-admin',t=>{
  const {seeded,output,env}=fixture(t),previous=credentials.read(seeded);
  fs.unlinkSync(path.join(seeded,'postgres','owner_settings'));
  credentials.addOwnerSettings(seeded);
  const upgraded=credentials.read(seeded);
  assert.notEqual(upgraded.postgres.owner_settings,previous.postgres.owner_settings);
  assert.deepEqual({...upgraded.postgres,owner_settings:previous.postgres.owner_settings},previous.postgres);
  assert.deepEqual(upgraded.vault,previous.vault);
  credentials.addOwnerSettings(seeded);assert.deepEqual(credentials.read(seeded),upgraded);
  render.render(render.input(env));
  const ownerConfig=require('../../../lib/server/serve/owner-preview-config').load({NS_SECRETS_DIR:path.join(output,'tenant-admin'),NS_VAULT_ADDR:'https://vault.example.test:8200'});
  assert.equal(new URL(ownerConfig.ownerSettings.connectionString).username,plan.layout().roles.owner_settings);
  assert.equal(ownerConfig.ownerSettings.namespaces.authority,plan.layout().namespaces.owner_configuration);
  for(const role of Object.keys(render.connections).filter(name=>name!=='tenant-admin')){
    assert.equal(fs.existsSync(path.join(output,role,'ns_owner_settings_pg')),false);
  }
});
test('mounts only the declared database credentials and tokens for each role',t=>{
  const {seeded,output,env}=fixture(t),values=credentials.read(seeded),layout=plan.layout(),signing=credentials.signing(seeded);
  assert.equal(render.render(render.input(env)).state,'credentials-rendered');
  for(const [role,logins] of Object.entries(render.connections)){
    const roleDir=path.join(output,role);
    const extra={api:['vault-token','signing-secret'],'tenant-admin':['vault-token','signing-secret'],admin:['vault-token','signing-secret']};
    assert.deepEqual(fs.readdirSync(roleDir).sort(),[...Object.keys(logins).map(name=>name.toLowerCase()),...(extra[role]||[])].sort());
    for(const [name,login] of Object.entries(logins)){
      const file=path.join(roleDir,name.toLowerCase()),url=new URL(fs.readFileSync(file,'utf8').trim());
      assert.equal(url.username,layout.roles[login]);assert.equal(url.password,values.postgres[login]);assert.equal(fs.statSync(file).mode&0o777,0o600);
    }
  }
  assert.equal(read(output,'api/vault-token').trim(),values.vault.api);
  assert.equal(read(output,'tenant-admin/vault-token').trim(),values.vault['owner-credentials']);
  assert.equal(read(output,'admin/vault-token').trim(),values.vault.provisioner);
  for(const role of ['api','tenant-admin','admin'])assert.equal(read(output,role+'/signing-secret').trim(),signing);
  for(const role of ['realtime','evaluator'])assert(!fs.existsSync(path.join(output,role,'signing-secret')));
  render.render(render.input({...env,NS_API_VAULT_TOKEN_FILE:'/run/ns-vault/token'}));
  assert(!fs.existsSync(path.join(output,'api/vault-token')));
  // Kubernetes (Agent): the signing secret is the one Secret ns-signing-secret, so no role document carries a copy.
  for(const role of ['api','tenant-admin','admin'])assert(!fs.existsSync(path.join(output,role,'signing-secret')),role);
  assert.throws(()=>render.input({...env,VAULT_ADDR:'http://vault:8200'}),/RENDER_VAULT_HTTPS_REQUIRED/);
});
