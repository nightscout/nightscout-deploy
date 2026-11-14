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
  const writePrivate=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
  await require('../registry-bootstrap').finish({options:{output:root,uid:process.getuid(),gid:process.getgid(),sourceCommit:'a'.repeat(40),deployCommit:'b'.repeat(40),vault:{origin:'https://vault:8200'}},request:async()=>({auth:{client_token:'synthetic'}}),rootToken:'synthetic',layout,roleURLs:urls,writePrivate});
  assert.equal(constructed,0);assert(fs.existsSync(path.join(root,'bootstrap/complete.json')));assert(!fs.existsSync(path.join(root,'feed-reader')));
 }finally{Module._load=load;fs.rmSync(root,{recursive:true,force:true});}
});
test('legacy capture disable refuses before product preparation',()=>{
 assert.throws(()=>require('../pgstream').enabled({NS_PGSTREAM:'0'}),/PGSTREAM_LEGACY_MODE_RETIRED/);
 assert.equal(require('../pgstream').enabled({}),true);
});
