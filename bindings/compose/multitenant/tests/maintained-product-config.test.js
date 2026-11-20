'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const plan=require('../config');
test('generated maintained role files pass actual product parsers without constructing PostgreSQL',async()=>{
 const Module=require('node:module'),load=Module._load,root=fs.mkdtempSync(path.join(os.tmpdir(),'ns-maintained-config-'));let constructed=0;
 Module._load=function(name,...args){if(name==='pg')return{Client:class{constructor(){constructed++;throw Error('PG forbidden');}},Pool:class{constructor(){constructed++;throw Error('PG forbidden');}}};return load.call(this,name,...args);};
 try{
  const layout=plan.layout();
  const sql=plan.grants(layout).join('\n');
  assert(sql.includes('REVOKE SELECT ON "'+layout.namespaces.entries+'"."entries" FROM "'+layout.roles.realtime+'"'));
  assert(!sql.includes('GRANT SELECT ON "'+layout.namespaces.entries+'"."entries" TO "'+layout.roles.realtime+'"'));
  const credentials=path.join(root,'credentials'),state=path.join(root,'state');
  require('../credentials').seed(credentials);
  const render=require('../render');render.render(render.input({NS_RENDER_OUTPUT:state,NS_CREDENTIALS_DIR:credentials}));
  const configure=require('../../../lib/cli/commands/multitenant').configure;
  for(const role of [...plan.serviceRoles,'admin']){
    // compose.yaml sets NS_SIGNING_SECRET_FILE for the roles that issue tokens (decision deployment-signing-secret).
    const secret=path.join(state,role,'signing-secret');
    if(['api','admin','tenant-admin'].includes(role))assert(fs.existsSync(secret),role+' has a rendered signing secret');
    const settings=configure([role],{NS_SECRETS_DIR:path.join(state,role),NS_VAULT_ADDR:'https://vault:8200',NS_INPUT_TRANSPORT:'writer-driven',...(fs.existsSync(secret)?{NS_SIGNING_SECRET_FILE:secret}:{})});
    if(role!=='admin')assert.equal(settings.operationConfig.namespace,layout.namespaces.control);
  }
  assert.equal(constructed,0);
 }finally{Module._load=load;fs.rmSync(root,{recursive:true,force:true});}
});
