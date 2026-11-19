'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const plan=require('../config');
test('generated maintained role files pass actual product parsers without constructing PostgreSQL',async()=>{
 const Module=require('node:module'),load=Module._load,root=fs.mkdtempSync(path.join(os.tmpdir(),'ns-maintained-config-'));let constructed=0;
 Module._load=function(name,...args){if(name==='pg')return{Client:class{constructor(){constructed++;throw Error('PG forbidden');}},Pool:class{constructor(){constructed++;throw Error('PG forbidden');}}};return load.call(this,name,...args);};
 try{
  const layout=plan.layout(),urls=Object.fromEntries(Object.keys(layout.roles).map(key=>[key,'postgres://'+layout.roles[key]+':synthetic@postgres:5432/synthetic']));
  const docs=plan.documents({layout,urls,tokens:[],publicKeys:[],managementKeys:[],vaultAddress:'https://vault:8200'});
  assert(!('feed' in docs));assert(!('feed_reader' in layout.roles));assert(!('change_stamps' in layout.namespaces));
  assert.deepEqual(Object.keys(docs.configs.realtime.postgres.namespaces).sort(),['checkpoint','clock']);
  assert.deepEqual(docs.configs.realtime.activity,{namespace:layout.namespaces.control});
  assert.equal(docs.configs.realtime.completedOutput.namespace,layout.namespaces.eval_checkpoint);
  const sql=plan.grants(layout).join('\n');
  assert(sql.includes('REVOKE SELECT ON "'+layout.namespaces.entries+'"."entries" FROM "'+layout.roles.realtime+'"'));
  assert(!sql.includes('GRANT SELECT ON "'+layout.namespaces.entries+'"."entries" TO "'+layout.roles.realtime+'"'));
  assert.throws(()=>plan.documents({layout,urls,registryMode:false}),/STATIC_PRODUCT_CONFIGURATION_RETIRED/);
  // Every role document renders before apply from seeded credentials, with no database or Vault.
  const credentials=path.join(root,'credentials');require('../credentials').seed(credentials,Object.keys(layout.roles));
  const render=require('../render');render.render(render.input({NS_CREDENTIALS_DIR:credentials,NS_RENDER_OUTPUT:path.join(root,'state')}));
  const state=path.join(root,'state'),read=file=>JSON.parse(fs.readFileSync(path.join(state,file)));
  assert.equal(constructed,0);assert(!fs.existsSync(path.join(state,'bootstrap')));assert(!fs.existsSync(path.join(state,'feed-reader')));assert(fs.existsSync(path.join(state,'pgstream/pgstream.yaml')));assert(!fs.existsSync(path.join(state,'evaluator/pgstream.yaml')));assert(!('NS_PGSTREAM_BINARY' in read('evaluator/env.json')));assert(!('NS_PGSTREAM_CONFIG' in read('evaluator/env.json')));
  for(const role of plan.serviceRoles)assert(!('nativeSelection' in read(role+'/operation.json')),role+' carries no stream identity pin');
 }finally{Module._load=load;fs.rmSync(root,{recursive:true,force:true});}
});
test('legacy capture disable refuses before product preparation',()=>{
 assert.throws(()=>require('../pgstream').enabled({NS_PGSTREAM:'0'}),/PGSTREAM_LEGACY_MODE_RETIRED/);
 assert.equal(require('../pgstream').enabled({}),true);
});
