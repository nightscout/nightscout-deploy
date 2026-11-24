'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const plan=require('./config'),bootstrap=require('./bootstrap');
test('bootstrap requires explicit intent, dedicated database and HTTPS Vault',()=>{
  const env={NS_COMPOSE_BOOTSTRAP:'1',NS_BOOTSTRAP_OUTPUT:'/tmp/state',NS_SOURCE_COMMIT:'a'.repeat(40),NS_BOOTSTRAP_POSTGRES_URL:'postgres://postgres:synthetic-only@postgres:5432/nightscout_compose_test',VAULT_ADDR:'https://vault:8200'};
  assert.equal(bootstrap.input(env).pg.hostname,'postgres');
  assert.equal(bootstrap.input(env).migrationStatementTimeoutMs, undefined);
  assert.equal(bootstrap.input({...env, NS_MIGRATION_STATEMENT_TIMEOUT_MS:'600000'}).migrationStatementTimeoutMs, 600000);
  for (const value of ['0', '600001', '-1000', '5.5', 'unlimited']) {
    assert.throws(() => bootstrap.input({...env, NS_MIGRATION_STATEMENT_TIMEOUT_MS:value}), /BOOTSTRAP_MIGRATION_TIMEOUT_INVALID/);
  }
  // A declared relation size derives the timeout: the measured build (13,110,624,256 bytes in
  // 59.613 s) gets three times its time, rounded up; the Kubernetes render gives the same 179000.
  const sized=(bytes,more={})=>bootstrap.input({...env,NS_MIGRATION_LARGEST_RELATION_BYTES:bytes,...more}).migrationStatementTimeoutMs;
  assert.equal(sized('13110624256'),179000);
  assert.equal(sized('1000'),60000);
  assert.equal(sized('1000000000',{NS_MIGRATION_BUILD_BYTES_PER_SECOND:'10000000'}),300000);
  assert.equal(sized('13110624256',{NS_MIGRATION_STATEMENT_TIMEOUT_MS:'200000'}),200000);
  assert.throws(()=>sized('13110624256',{NS_MIGRATION_STATEMENT_TIMEOUT_MS:'100000'}),/BOOTSTRAP_MIGRATION_TIMEOUT_BELOW_BUDGET/);
  assert.throws(()=>sized('60000000000'),/BOOTSTRAP_MIGRATION_BUDGET_ABOVE_RUNNER_LIMIT/);
  for (const value of ['-1','1.5','lots','']) assert.throws(()=>sized(value),/BOOTSTRAP_MIGRATION_BUDGET_INVALID/);
  assert.throws(()=>sized('1000',{NS_MIGRATION_BUILD_BYTES_PER_SECOND:'0'}),/BOOTSTRAP_MIGRATION_BUDGET_INVALID/);
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

test('restored bootstrap passes the operator timeout to the catalogue migrator',async t=>{
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'bootstrap-migration-'));
  t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const directory=path.join(output,'bootstrap');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory,'vault-init.json'),'{}');
  fs.writeFileSync(path.join(directory,'complete.json'),JSON.stringify({inputTransport:'writer-driven'}));
  t.mock.method(globalThis,'fetch',async url=>({
    ok:true, status:200, json:async()=>url.endsWith('/sys/init')?{initialized:true}:{sealed:false}
  }));
  t.mock.method(require('./credentials'),'read',()=>({}));
  const adminTimeouts=[];
  const admin=require('pg').Client.prototype;
  t.mock.method(admin,'connect',async function(){adminTimeouts.push(this.connectionParameters.statement_timeout);});
  t.mock.method(admin,'query',async()=>({rowCount:1}));
  t.mock.method(admin,'end',async()=>{});
  const migrationTimeouts=[];
  const reachedMigration=new Error('synthetic catalogue boundary');
  t.mock.method(require('../../lib/migrations/postgres'),'run',async (action,options)=>{
    assert.equal(action,'up');
    migrationTimeouts.push(options.statementTimeoutMs);
    throw reachedMigration;
  });
  for(const migrationStatementTimeoutMs of [undefined,300000]){
    await assert.rejects(bootstrap.bootstrap({output,pg:'synthetic',vault:new URL('https://example.invalid'),migrationStatementTimeoutMs}),reachedMigration);
  }
  assert.deepEqual(migrationTimeouts,[undefined,300000]);
  assert.deepEqual(adminTimeouts,[10000,10000]);
});
