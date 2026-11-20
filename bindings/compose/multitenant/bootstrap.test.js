'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const plan=require('./config'),bootstrap=require('./bootstrap');
test('bootstrap requires explicit intent, dedicated database and HTTPS Vault',()=>{
  const env={NS_COMPOSE_BOOTSTRAP:'1',NS_BOOTSTRAP_OUTPUT:'/tmp/state',NS_SOURCE_COMMIT:'a'.repeat(40),NS_BOOTSTRAP_POSTGRES_URL:'postgres://postgres:synthetic-only@postgres:5432/nightscout_compose_test',VAULT_ADDR:'https://vault:8200'};
  assert.equal(bootstrap.input(env).pg.hostname,'postgres');
  assert.throws(()=>bootstrap.input({...env,NS_COMPOSE_BOOTSTRAP:'0'}),/EXPLICIT_COMPOSE/);
  assert.throws(()=>bootstrap.input({...env,NS_BOOTSTRAP_POSTGRES_URL:'postgres://postgres:synthetic-only@postgres:5432/real_database'}),/DEDICATED/);
  assert.throws(()=>bootstrap.input({...env,VAULT_ADDR:'http://vault:8200'}),/HTTPS/);
});
test('private output refuses overwrite and never inherits readable permissions',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ns-compose-output-')),file=path.join(directory,'secret.json');
  try{bootstrap.writePrivate(file,{synthetic:'secret'});assert.equal(fs.statSync(file).mode&0o777,0o600);assert.throws(()=>bootstrap.writePrivate(file,{changed:true}),/EEXIST/);}finally{fs.rmSync(directory,{recursive:true});}
});
test('failure report keeps the stable code and adds redacted detail and location',()=>{
  const uncoded=new TypeError('preview configuration is too large');
  const r=bootstrap.report(uncoded);
  assert.equal(r.error,'COMPOSE_BOOTSTRAP_FAILED');assert.equal(r.detail,'TypeError: preview configuration is too large');
  assert(Array.isArray(r.at)&&r.at.length>0&&/bootstrap\.test\.js:\d+:\d+/.test(r.at[0]));
  const coded=Object.assign(new Error('BOOTSTRAP_VAULT_REFUSED'),{code:'BOOTSTRAP_VAULT_REFUSED'});
  assert.equal(bootstrap.report(coded).error,'BOOTSTRAP_VAULT_REFUSED');
  const hex='ab'.repeat(32);
  const vaultToken=['hv'+'s','synthetic-vault-0123456789'].join('.'),jwt=['ey'+'JhbGciOiJFZERTQSJ9','ey'+'J0aWQiOiJ4In0','c2ln'].join('.');const leaky=new Error(`connect postgres://nsdemo_api:${hex}@postgres:5432/nightscout_compose_test failed; PASSWORD '${hex}'; password=hunter2 vault said ${vaultToken} ${jwt}`);
  const text=JSON.stringify(bootstrap.report(leaky));
  for(const secret of [hex,'hunter2',vaultToken,jwt.split('.')[0],'nsdemo_api:'])assert(!text.includes(secret),'leaked '+secret);
  assert(text.includes('postgres://<redacted>@postgres:5432/nightscout_compose_test'));
  assert.equal(bootstrap.redact('duplicate key value violates unique constraint'),'duplicate key value violates unique constraint');
});
test('synthetic tenant count is validated',()=>{
  assert.equal(plan.tenantCount({NS_DEMO_TENANTS:'10001'}),10001);
  for(const raw of ['0','-1','1.5','9007199254740993'])assert.throws(()=>plan.tenantCount({NS_DEMO_TENANTS:raw}),/NS_DEMO_TENANTS must be a positive integer/);
});
test('a restore must be writer-driven and is K-free',()=>{
  // Writer-driven: one seed serves K=1 and K=2 (K-free).
  for(const seeded of [undefined,2,4])
    assert.doesNotThrow(()=>bootstrap.restoreCheck({inputTransport:'writer-driven',evaluatorWorkers:seeded}));
  // pgstream and unmarked (legacy, pgstream) fixtures are refused.
  for(const complete of [{inputTransport:'pgstream'},{evaluatorWorkers:2},{}])
    assert.throws(()=>bootstrap.restoreCheck(complete),/BOOTSTRAP_INPUT_TRANSPORT_CHANGED_RECREATE_DEMO/);
});
