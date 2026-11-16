'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const file=path.join(__dirname,'pgstream.js'),load=require('node:module').createRequire(file);
function fixture(realtime=false,change=text=>text){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pgstream-init-control-')),binary=path.join(root,'pgstream');fs.writeFileSync(binary,'synthetic pinned bytes; never executed');
 const binarySha256=crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),commands=[],sql=[];
 const module={exports:{}};vm.runInThisContext('(function(require,module,exports){'+change(fs.readFileSync(file,'utf8'))+'\n})',{filename:file})(name=>name==='node:child_process'?{execFileSync:(...args)=>commands.push(args)}:load(name),module,module.exports);
 const layout={roles:{pgstream:'synthetic_stream',evaluator:'synthetic_eval',...(realtime?{realtime:'synthetic_rt'}:{})},namespaces:{clock:'synthetic_clock',eval_checkpoint:'synthetic_work',...(realtime?{rt_checkpoint:'synthetic_delivery'}:{})}};
 const routes=['clock','settings','policy','activity','lifecycle'].map(kind=>({schema:'synthetic_'+kind,table:'source_'+kind,kind}));
 const config={consumer:'evaluator-synthetic',pgstream:{slot:'synthetic_slot',receiver:{url:'http://synthetic-intake:19913/',trust:'network',bindHost:'0.0.0.0',maxBytes:16777216,timeoutMs:5000}}};
 return {binding:module.exports,commands,sql,options:{admin:{query:async(text,values)=>{sql.push({text,values});return{rows:[]};}},adminURL:'postgres://synthetic@localhost/synthetic_test',layout,config,binary,binarySha256,routes,workColumns:['work_version','delivery_revision'],realtimeColumns:['output_received'],realtimeConsumers:['realtime-synthetic']},close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('maintained deployment is the default and retired selection refuses',()=>{const f=fixture();try{assert.equal(f.binding.enabled({}),true);assert.equal(f.binding.enabled({NS_PGSTREAM:'1'}),true);assert.throws(()=>f.binding.enabled({NS_PGSTREAM:'0'}),/LEGACY_MODE_RETIRED/);}finally{f.close();}});
test('same canonical initializer supports evaluator-only native fixtures and exact five-route wire',async()=>{const f=fixture();try{await f.binding.init(f.options);assert.equal(f.commands.length,1);assert.equal(f.commands[0][0],f.options.binary);assert(!f.sql.some(row=>row.text.includes('pgstream_realtime_')));const inserts=f.sql.filter(row=>row.text.startsWith('INSERT INTO pgstream.webhook_subscriptions'));assert.equal(inserts.length,6);assert(inserts.every(row=>row.values[0]==='http://synthetic-intake:19913/pgstream'),'EXTERNAL_INTAKE_TARGET_REQUIRED');assert(!inserts.some(row=>row.values[2]==='tenant_consumer_checkpoint'));const wire=f.binding.wire(f.options.config,'postgres://synthetic@localhost/synthetic_test',{subscriptionsPort:19915,routes:f.options.routes});assert.equal(wire.target.webhooks.subscriptions.server.address,'127.0.0.1:19915');assert.equal(wire.source.postgres.replication.plugin.add_tables.split(',').length,5);}finally{f.close();}});
test('wrong binary pin refuses before any CLI or SQL effects and restored pin enables typed realtime setup',async()=>{const f=fixture(true);try{await assert.rejects(f.binding.init({...f.options,binarySha256:'0'.repeat(64)}),/BINARY_PIN_REFUSED/);assert.equal(f.commands.length,0);assert.equal(f.sql.length,0);await f.binding.init(f.options);assert(f.sql.some(row=>row.text.includes('FOR UPDATE TO "synthetic_rt"')&&row.text.includes("consumer IN ('realtime-synthetic')")));assert(!f.sql.some(row=>/FOR ALL/.test(row.text)));}finally{f.close();}});

test('control: old loopback subscription target fails the external intake oracle, restored target passes',async()=>{
 async function criterion(change){const f=fixture(false,change);try{await f.binding.init(f.options);const inserts=f.sql.filter(row=>row.text.startsWith('INSERT INTO pgstream.webhook_subscriptions'));assert(inserts.every(row=>row.values[0]==='http://synthetic-intake:19913/pgstream'),'EXTERNAL_INTAKE_TARGET_REQUIRED');}finally{f.close();}}
 await assert.rejects(criterion(text=>{const needle="new URL('pgstream',receiver.url).href";assert.equal(text.split(needle).length,2);return text.replace(needle,"'http://127.0.0.1:19913/pgstream'");}),/EXTERNAL_INTAKE_TARGET_REQUIRED/);
 await criterion(text=>text);
});

test('invalid receiver contract refuses before the privileged initializer or SQL',async()=>{const f=fixture();try{f.options.config.pgstream.receiver.url='http://synthetic-intake:19913/not-the-root';await assert.rejects(f.binding.init(f.options));assert.equal(f.commands.length,0);assert.equal(f.sql.length,0);}finally{f.close();}});

test('synthetic heartbeat creation and serving grants stay retired; reinstatement control is red',async()=>{
 async function criterion(change=text=>text){const f=fixture(false,change);try{
  await f.binding.init(f.options);
  assert.equal(f.sql.some(row=>row.text.includes('nightscout_heartbeat')),false,'SYNTHETIC_HEARTBEAT_SQL_RETIRED');
  assert.equal(f.sql.some(row=>/\bDROP\b/.test(row.text)),false,'NO_IMPLICIT_LEGACY_TABLE_REMOVAL');
  const inputs=f.sql.filter(row=>row.text.startsWith('INSERT INTO pgstream.webhook_subscriptions'));
  assert.equal(inputs.length,6,'FIVE_INPUT_ROUTES_PLUS_DDL');
  assert.deepEqual(f.binding.configuration({prefix:'synthetic',roles:{pgstream:'synthetic_stream'}}).bounds,{stepMs:5000,recoveryMs:30000,pendingMs:30000});
 }finally{f.close();}}
 await criterion();
 await assert.rejects(criterion(text=>{const needle=" await admin.query('GRANT SELECT ON pgstream.webhook_subscriptions TO '+evaluator);";assert(text.includes(needle));return text.replace(needle,needle+"\n await admin.query('GRANT SELECT ON synthetic_clock.nightscout_heartbeat TO '+evaluator);");}),/SYNTHETIC_HEARTBEAT_SQL_RETIRED/);
 await criterion();
});

test('native default realtime role reads bound raw tail, with isolation control and immutable checkpoints',{
 skip:!process.env.NS_PGSTREAM_INIT_PG_SOCKET
},async()=>{
 // Run from the reviewed core overlay, using an explicitly owned synthetic DB.
 const {Client}=require('../../node_modules/pg'),scope=require('../../lib/storage/tenant-scope');
 const f=fixture(true),db=new Client({host:process.env.NS_PGSTREAM_INIT_PG_SOCKET,user:'postgres',database:'postgres'});
 const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
 const previous=scope.getTenancyMode();let connection,createdSchema=false,createdRole=false;
 try{
  await db.connect();await f.binding.init(f.options);
  await db.query('CREATE SCHEMA synthetic_work');createdSchema=true;
  await db.query('CREATE ROLE synthetic_rt LOGIN NOSUPERUSER NOBYPASSRLS');createdRole=true;
  const catalogue=require('../../lib/migrations/catalogue');
  const migrations=catalogue.validateCatalogue(require('../../migrations/candidates/postgres-evaluator-work-v2.json'));
  await db.query('SET search_path=synthetic_work,pg_catalog');
  for(const migration of migrations)for(const sql of catalogue.renderMigration(migration,'synthetic_work'))await db.query(sql);
  await db.query('RESET search_path');
  const table='synthetic_work.tenant_consumer_checkpoint',tail=require('../../lib/storage/storage-event-journal').empty();
  for(const tenant of [A,B])for(const consumer of ['evaluator-synthetic','evaluator-synthetic-completed'])await db.query(
   'INSERT INTO '+table+'(tenant_id,consumer,contract_digest,checkpoint,projection,work_enabled) VALUES($1,$2,$3,0,$4,true)',
   [tenant,consumer,'a'.repeat(64),JSON.stringify(consumer.endsWith('-completed')?[]:[{},tail])]);
  await db.query('GRANT USAGE ON SCHEMA synthetic_work TO synthetic_rt;GRANT SELECT ON '+table+' TO synthetic_rt');
  const policy=f.sql.find(row=>row.text.startsWith('CREATE POLICY pgstream_realtime_output ')).text;
  await db.query(policy);
  scope.setTenancyMode('multi');
  const url=new URL('postgres://synthetic_rt@localhost/postgres');url.searchParams.set('host',process.env.NS_PGSTREAM_INIT_PG_SOCKET);
  connection=await require('../../lib/storage/postgres-connection')({connectionString:url.href,max:1});
  const config={completedOutput:{namespace:'synthetic_work',consumer:'evaluator-synthetic'},maxRows:3,maxBytes:10000};
  const reader=require('../../lib/pgstream/storage-events').create({config,connection});
  assert.deepEqual(await reader.read(A),tail,'DEFAULT_BOUND_RAW_TAIL_READ');
  assert.equal((await connection.readOnly('SELECT consumer FROM '+table+" WHERE consumer='evaluator-synthetic'")).rows.length,0,'UNBOUND_SCAN_MUST_NOT_READ_INPUT');
  await scope.withTenant(A,async()=>{
   assert.equal((await connection.query('SELECT consumer FROM '+table+' WHERE tenant_id=$1 AND consumer=$2',[B,'evaluator-synthetic'])).rows.length,0,'FOREIGN_INPUT_MUST_BE_HIDDEN');
   await assert.rejects(connection.query('UPDATE '+table+' SET projection=projection WHERE tenant_id=$1',[A]),error=>error.code==='42501');
  });
  // Removing the ordinary tenant policy must expose the missing input row:
  // completed-only metadata policy cannot replace tenant-bound journal access.
  await db.query('DROP POLICY tenant_consumer_checkpoint_isolation ON '+table);
  await assert.rejects(reader.read(A),/STORAGE_EVENT_NOT_PROVISIONED/,'ISOLATION_POLICY_CONTROL_MUST_FAIL_RAW_READ');
  const base=migrations[0].up.find(sql=>sql.startsWith('CREATE POLICY tenant_consumer_checkpoint_isolation '));
  await db.query('SET search_path=synthetic_work,pg_catalog');await db.query(base);await db.query('RESET search_path');
  assert.deepEqual(await reader.read(A),tail,'RESTORED_DEFAULT_BOUND_RAW_TAIL_READ');
 }finally{
  await connection?.end();scope.setTenancyMode(previous);f.close();
  try{if(createdSchema)await db.query('DROP SCHEMA synthetic_work CASCADE');if(createdRole)await db.query('DROP ROLE synthetic_rt');}finally{await db.end();}
 }
});
