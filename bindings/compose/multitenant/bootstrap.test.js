'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const plan=require('./config'),bootstrap=require('./bootstrap');
function generated(){
  const layout=plan.layout(),urls=Object.fromEntries(Object.keys(layout.roles).map(kind=>[kind,'postgres://'+layout.roles[kind]+':synthetic-only@postgres:5432/nightscout_compose_test']));
  const keys=()=>[plan.A,plan.B].map(tenant=>({tenant,kid:'key1',publicKey:Buffer.from(crypto.generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x,'base64url').toString('base64')}));
  return {layout,docs:plan.documents({layout,urls,tokens:['synthetic-a','synthetic-b'],publicKeys:keys(),managementKeys:keys(),vaultAddress:'https://vault:8200'})};
}
function files(docs){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ns-compose-config-'));
  for(const role of plan.serviceRoles){
    const own=path.join(directory,role);fs.mkdirSync(own,{mode:0o700});
    for(const [name,value]of Object.entries({'config.json':docs.configs[role],'operation.json':docs.operations[role],'admission.json':docs.admission,'evaluator-metadata.json':docs.configs.evaluator}))fs.writeFileSync(path.join(own,name),JSON.stringify(value));
  }
  return directory;
}
test('all generated service configs pass actual product parsers and exact namespace manifests',()=>{
  const {docs}=generated(),directory=files(docs);try{plan.validateFiles(directory,docs);}finally{fs.rmSync(directory,{recursive:true});}
});
test('control: absent notification namespace refuses actual API cohort match, restoration passes',()=>{
  const {docs}=generated();docs.operations.api.participants.find(row=>row.id==='api').namespaces=docs.operations.api.participants.find(row=>row.id==='api').namespaces.filter(name=>!name.endsWith('_outbox'));
  let directory=files(docs);try{assert.throws(()=>plan.validateFiles(directory,docs),/namespace mismatch/);}finally{fs.rmSync(directory,{recursive:true});}
  const restored=generated();directory=files(restored.docs);try{plan.validateFiles(directory,restored.docs);}finally{fs.rmSync(directory,{recursive:true});}
});
test('runtime bundles retain isolated credential capabilities',()=>{
  const {docs}=generated();
  assert(!Object.hasOwn(docs.environments.api,'NS_OUTBOX_PG'));
  assert(!Object.hasOwn(docs.environments.api,'NS_SUPPRESSION_PG'));
  assert(!Object.hasOwn(docs.environments.realtime,'NS_API_PG'));
  assert(!Object.keys(docs.environments.evaluator).some(key=>key.startsWith('NS_VAULT_')));
  assert.equal(new Set(plan.serviceRoles.map(role=>docs.environments[role].NS_LIFETIME_PG)).size,4);
  assert(!JSON.stringify(docs.ui).includes(plan.A));assert(!JSON.stringify(docs.ui).includes('postgres'));
});
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
test('generated role documents are compact; custody files stay indented',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ns-compose-compact-'));
  try{
    const value={tenants:[{id:'a',aliases:['one.example.test']}]};
    bootstrap.writePrivate(path.join(directory,'role.json'),value,{},{compact:true});
    bootstrap.writePrivate(path.join(directory,'custody.json'),value);
    assert.equal(fs.readFileSync(path.join(directory,'role.json'),'utf8'),JSON.stringify(value)+'\n');
    assert.equal(fs.readFileSync(path.join(directory,'custody.json'),'utf8'),JSON.stringify(value,null,2)+'\n');
  }finally{fs.rmSync(directory,{recursive:true});}
});
test('config cap option is off by default and bounded when set',()=>{
  const env={NS_COMPOSE_BOOTSTRAP:'1',NS_BOOTSTRAP_OUTPUT:'/tmp/state',NS_SOURCE_COMMIT:'a'.repeat(40),NS_BOOTSTRAP_POSTGRES_URL:'postgres://postgres:synthetic-only@postgres:5432/nightscout_compose_test',VAULT_ADDR:'https://vault:8200'};
  assert.equal(bootstrap.input(env).configMaxBytes,undefined);
  assert.equal(bootstrap.input({...env,NS_BOOTSTRAP_CONFIG_MAX_BYTES:''}).configMaxBytes,undefined);
  assert.equal(bootstrap.input({...env,NS_BOOTSTRAP_CONFIG_MAX_BYTES:'4194304'}).configMaxBytes,4194304);
  assert.throws(()=>bootstrap.input({...env,NS_BOOTSTRAP_CONFIG_MAX_BYTES:'4MiB'}),/BOOTSTRAP_CONFIG_MAX_BYTES_INVALID/);
  assert.throws(()=>bootstrap.input({...env,NS_BOOTSTRAP_CONFIG_MAX_BYTES:'65535'}),/BOOTSTRAP_CONFIG_MAX_BYTES_INVALID/);
  assert.throws(()=>bootstrap.input({...env,NS_BOOTSTRAP_CONFIG_MAX_BYTES:'67108865'}),/BOOTSTRAP_CONFIG_MAX_BYTES_INVALID/);
  assert.equal(bootstrap.input({...env,NS_BOOTSTRAP_CONFIG_MAX_BYTES:'67108864'}).configMaxBytes,67108864);
});
test('bootstrap validation runs the ui parser: a ui config over the tenant ceiling refuses at bootstrap',()=>{
  const {docs}=generated(),directory=files(docs);
  try{
    plan.validateFiles(directory,docs);
    const over={...docs,ui:{version:1,tenants:Array.from({length:10001},(_,i)=>({aliases:['t'+i+'.example.test'],theme:'default'}))}};
    assert.throws(()=>plan.validateFiles(directory,over),/UI_PUBLIC_CONFIG_INVALID/);
  }finally{fs.rmSync(directory,{recursive:true});}
});
test('realtime maxSockets is tenants x sockets-per-tenant, at least the former 100',()=>{
  assert.equal(plan.maxSockets(2,{}),100);
  assert.equal(plan.maxSockets(3000,{}),6000);
  assert.equal(plan.maxSockets(3000,{NS_DEMO_SOCKETS_PER_TENANT:'8'}),24000);
  for(const bad of ['0','101','2.5','x'])assert.throws(()=>plan.socketsPerTenant({NS_DEMO_SOCKETS_PER_TENANT:bad}),/NS_DEMO_SOCKETS_PER_TENANT/);
  assert.throws(()=>plan.tenantCount({NS_DEMO_TENANTS:'10001'}),/NS_DEMO_TENANTS must be 1\.\.10000/);
  assert.equal(plan.tenantCount({NS_DEMO_TENANTS:'10000'}),10000);
});
