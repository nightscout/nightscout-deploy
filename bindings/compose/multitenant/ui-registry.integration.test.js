'use strict';
// Native UI-only resolver discriminator. Own PostgreSQL; no existing services,
// Vault, clinical identity or real tenant data. Core path is test instrumentation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { randomUUID, randomBytes } = require('node:crypto');
const uiRegistry = require('./ui-registry');
const core = process.env.NS_UI_TEST_CORE;
const enabled = process.env.NS_UI_REGISTRY_NATIVE_TEST === '1' && !!core;
const IMAGE = 'postgres@sha256:5db6dac2ef5dcff512f4f00a009c3c332b9f2f28f24277175bf3e4a3d02ef83a';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check) { const deadline=Date.now()+10000;while(Date.now()<deadline){const value=await check();if(value)return value;await sleep(25);}throw new Error('UI_NATIVE_WAIT_EXPIRED'); }
test('UI_REGISTRY_NATIVE: new exact aliases render while running; private/unknown selectors, privilege tamper and old roster fail closed', { skip: !enabled, timeout: 60000 }, async () => {
  const { Client } = require(path.join(core, 'node_modules/pg'));
  const request = require(path.join(core, 'node_modules/supertest'));
  const registry = require(path.join(core, 'lib/tenant-registry/postgres'));
  const container='ns-ui-registry-'+process.pid+'-'+Date.now(),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'ns-ui-registry-'));
  const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  let admin,reader,connection,child,output='';
  const A=randomUUID(),B=randomUUID(),password=randomBytes(20).toString('hex');
  const config={version:2,registry:{connectionEnv:'UI_NATIVE_PG',namespace:'ui_registry',maxTenants:2,refreshMs:250},theme:'modern'};
  try {
    docker(['run','--detach','--name',container,'-p','127.0.0.1::5432','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=ui_registry_test',IMAGE]);
    const port=docker(['port',container,'5432/tcp']).split(':').at(-1),url=new URL('postgres://127.0.0.1:'+port+'/ui_registry_test');url.username='postgres';url.password=randomBytes(20).toString('hex');
    await wait(async()=>{const probe=new Client({connectionString:url.toString()});try{await probe.connect();await probe.end();return true;}catch{await probe.end().catch(()=>{});return false;}});
    admin=new Client({connectionString:url.toString()});await admin.connect();
    await admin.query('CREATE SCHEMA ui_registry;CREATE ROLE ui_registry_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;CREATE ROLE ui_registry_login LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION PASSWORD '+"'"+password+"'");
    await require(path.join(core,'lib/migrations/postgres')).run('up',{direct:true,connectionString:url.toString(),namespace:'ui_registry',catalogue:registry.catalogue});
    for(const row of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='ui_registry'")).rows)await admin.query('ALTER TABLE ui_registry."'+row.tablename+'" OWNER TO ui_registry_owner');
    for(const row of (await admin.query("SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='ui_registry'")).rows)await admin.query('ALTER FUNCTION '+row.fn+' OWNER TO ui_registry_owner');
    await admin.query('ALTER SCHEMA ui_registry OWNER TO ui_registry_owner');
    for(const sql of registry.grants({namespace:'ui_registry',resolvers:['ui_registry_login']}))await admin.query(sql);
    await admin.query('CREATE SCHEMA clinical;CREATE TABLE clinical.synthetic_private(tenant_id uuid PRIMARY KEY,payload text);ALTER TABLE clinical.synthetic_private ENABLE ROW LEVEL SECURITY;ALTER TABLE clinical.synthetic_private FORCE ROW LEVEL SECURITY');
    url.username='ui_registry_login';url.password=password;const source={UI_NATIVE_PG:url.toString()};
    connection=new Client({connectionString:source.UI_NATIVE_PG});await connection.connect();
    await assert.rejects(connection.query('SELECT * FROM clinical.synthetic_private'),error=>error.code==='42501');
    await assert.rejects(connection.query('SELECT * FROM ui_registry.tenant_registry'),error=>error.code==='42501');
    await assert.rejects(connection.query("SELECT * FROM ui_registry.tenant_registry_tenants(NULL,1)"),error=>error.code==='42501');
    await admin.query('INSERT INTO ui_registry.tenant_registry(tenant_id,state,signing_version) VALUES ($1,\'active\',1)',[A]);
    await admin.query('INSERT INTO ui_registry.tenant_registry_hosts(host,tenant_id,kind) VALUES (\'a.example.test\',$1,\'alias\'),(\'a.private.svc\',$1,\'internal\')',[A]);
    reader=await uiRegistry.open({config,source,root:core});
    // Isolated deployment overlay resolves actual core code/templates/bundle.
    for(const name of ['lib','node_modules','views','static','translations'])fs.symlinkSync(path.join(core,name),path.join(scratch,name),'dir');
    const deployed=path.join(scratch,'deploy/multitenant');fs.mkdirSync(deployed,{recursive:true});
    for(const name of ['ui.js','ui-registry.js'])fs.copyFileSync(path.join(__dirname,name),path.join(deployed,name));
    const app=require(path.join(deployed,'ui.js')).createApp({config,root:core,presentation:reader});
    await request(app).get('/healthz').set('Host','unknown.example.test').expect(200);
    await request(app).get('/').set('Host','a.example.test').expect(200).expect('Cache-Control','no-store');
    await request(app).get('/').set('Host','b.example.test').expect(421);
    const started=Date.now();await admin.query('INSERT INTO ui_registry.tenant_registry(tenant_id,state,signing_version) VALUES ($1,\'active\',1)',[B]);
    await admin.query('INSERT INTO ui_registry.tenant_registry_hosts(host,tenant_id,kind) VALUES (\'b.example.test\',$1,\'alias\')',[B]);
    await reader.poll();const page=await request(app).get('/').set('Host','b.example.test').expect(200);assert.match(page.text,/modern/,'UI_NEW_ALIAS_WITHOUT_RESTART');
    console.log('UI_NATIVE_NEW_ALIAS_MS',Date.now()-started);
    await request(app).get('/').set('Host','a.private.svc').expect(421);
    await request(app).get('/').set('Host','a.example.test').set('X-Forwarded-Host','b.example.test').expect(421);
    await request(app).get('/').set('Host','b.example.test').set('X-Resolved-Tenant',A).expect(421);
    const asset=await request(app).get('/bundle/js/bundle.app.js').set('Host','b.example.test').expect(200);assert.equal(asset.headers['access-control-allow-origin'],undefined);
    await request(app).post('/').set('Host','b.example.test').expect(405);
    await admin.query('UPDATE ui_registry.tenant_registry SET state=\'removed\' WHERE tenant_id=$1',[A]);await reader.poll();await request(app).get('/').set('Host','a.example.test').expect(421);await request(app).get('/').set('Host','b.example.test').expect(200);
    await admin.query('GRANT USAGE ON SCHEMA clinical TO ui_registry_login;GRANT SELECT(payload) ON clinical.synthetic_private TO ui_registry_login');
    await assert.rejects(uiRegistry.open({config,source,root:core}),error=>error.code==='UI_REGISTRY_AUTHORITY_UNSAFE');await admin.query('REVOKE SELECT(payload) ON clinical.synthetic_private FROM ui_registry_login');
    await admin.query('ALTER FUNCTION ui_registry.tenant_registry_lookup(text,text) OWNER TO postgres');
    await assert.rejects(uiRegistry.open({config,source,root:core}),error=>error.code==='TENANT_REGISTRY_UNAVAILABLE');await admin.query('ALTER FUNCTION ui_registry.tenant_registry_lookup(text,text) OWNER TO ui_registry_owner');
    await reader.close();reader=null;
    const file=path.join(scratch,'public-config.json');fs.writeFileSync(file,JSON.stringify(config));
    const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const uiPort=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
    child=spawn(process.execPath,[path.join(deployed,'ui.js')],{env:{...process.env,...source,UI_PUBLIC_CONFIG:file,UI_PORT:String(uiPort),UI_HOSTNAME:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});
    const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
    await wait(async()=>{try{return (await fetch('http://127.0.0.1:'+uiPort+'/healthz')).ok;}catch{return false;}});
    assert.ok(Number((await admin.query("SELECT count(*) FROM pg_stat_activity WHERE application_name='nightscout-ui-registry'")).rows[0].count)>0);
    child.kill('SIGTERM');assert.deepEqual(await exited,{code:0,signal:null});child=null;
    assert.equal(Number((await admin.query("SELECT count(*) FROM pg_stat_activity WHERE application_name='nightscout-ui-registry'")).rows[0].count),0,'UI_OWNED_CONNECTION_CLOSED');
    assert.equal(output.includes(password),false,'UI_NO_CREDENTIAL_OUTPUT');
  } finally {
    if(child)child.kill('SIGKILL');await reader?.close().catch(()=>{});await connection?.end().catch(()=>{});await admin?.end().catch(()=>{});
    fs.rmSync(scratch,{recursive:true,force:true});try{docker(['rm','--force','--volumes',container]);}catch{/* owned only */}
  }
});
