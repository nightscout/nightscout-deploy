'use strict';
// Actual private host admission against an owned local clone of exact core.
// No Docker, database, provider, browser or serving-role execution.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const driver=require('../run'),profile=require('../profile'),resources=require('../resources'),install=require('../install');
const source=process.env.IDP_TEST_CORE,commit=process.env.IDP_TEST_CORE_COMMIT;
if(!source||!/^[a-f0-9]{40}$/.test(commit||''))throw Error('IDP_TEST_SOURCE_REQUIRED');
const deployment=path.resolve(__dirname,'../../../..');
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});};
function fixture(body){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'idp-joined-admission-'));
  fs.chmodSync(root,0o700);
  try{
    const core=path.join(root,'core'),appState=path.join(root,'app'),state=path.join(root,'provider');
    // Shared immutable objects are read-only; checkout and all overlays are owned.
    execFileSync('git',['clone','--quiet','--shared','--no-checkout',source,core],{stdio:'pipe'});
    git(core,'checkout','--quiet','--detach',commit);
    const head=git(deployment,'rev-parse','HEAD'),base=path.join(core,'deploy/multitenant');
    for(const file of git(deployment,'ls-tree','-r','--name-only',head,'bindings/compose/multitenant').split('\n')){
      const target=path.join(base,path.relative('bindings/compose/multitenant',file));
      fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(deployment,file),target);
    }
    fs.mkdirSync(appState,{mode:0o700});
    const nonce=crypto.randomBytes(12).toString('hex');
    const p={version:1,provider:'authentik',nonce,state,appProject:'nsidp-app-'+nonce,appNetwork:'nsidp-app-'+nonce+'_backend',coreCommit:commit,deployCommit:head,appImage:'sha256:'+'3'.repeat(64),bind:'127.0.0.9',issuerHost:'idp-'+nonce+'.synthetic.invalid',origins:['https://one.example.test','https://two.example.test'],apiServices:['api','api-2'],bindings:[{tenant:crypto.randomUUID(),principal:'existing_a',origin:'https://one.example.test',purposes:['data','management']},{tenant:crypto.randomUUID(),principal:'existing_b',origin:'https://two.example.test',purposes:['data']}],backchannel:false};
    const input={profile:p,core,deployment,appState,profileCommit:head};
    write(path.join(base,'.overlay.json'),{version:1,deployCommit:head});
    write(path.join(base,'.env'),'NS_DEMO_STATE='+appState+'\nNS_SOURCE_COMMIT='+commit+'\nNS_DEPLOY_COMMIT='+head+'\nNS_API_REPLICAS=2\n');
    write(path.join(appState,'bootstrap/complete.json'),{sourceCommit:commit,deployCommit:head});
    write(path.join(appState,'idp-resources-'+nonce+'.json'),resources.application(p.apiServices));
    const replicas=require(path.join(base,'replicas'));
    write(path.join(appState,'compose.replicas.yaml'),replicas.compose(2,path.join(base,'compose.yaml')));
    return body({input,base,head,root});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
test('joined actual core and complete binding are privately source-admitted without resource execution',()=>fixture(({input})=>{
  const result=driver.admit(input);assert.equal(result.p.coreCommit,commit);assert.equal(result.p.deployCommit,input.profileCommit);
}));
test('changed copied primer bytes refuse source admission, then exact restoration admits',()=>fixture(({input,base})=>{
  const file=path.join(base,'prime.js'),before=fs.readFileSync(file);
  fs.appendFileSync(file,'\n// synthetic changed fixture\n');
  assert.throws(()=>driver.admit(input),/IDP_APP_OVERLAY/);
  fs.writeFileSync(file,before);assert.equal(driver.admit(input).p.coreCommit,commit);
}));
test('wrong core, completed-state source and generated replica bytes refuse with restored admission',()=>fixture(({input})=>{
  assert.throws(()=>driver.admit({...input,profile:{...input.profile,coreCommit:'1'.repeat(40)}}),/IDP_CONTEXT_SOURCE/);
  const complete=path.join(input.appState,'bootstrap/complete.json'),before=fs.readFileSync(complete);
  write(complete,{sourceCommit:'1'.repeat(40),deployCommit:input.profile.deployCommit});
  assert.throws(()=>driver.admit(input),/IDP_APP_SOURCE/);fs.writeFileSync(complete,before);
  const roster=path.join(input.appState,'compose.replicas.yaml'),rosterBefore=fs.readFileSync(roster);fs.appendFileSync(roster,'\n# changed synthetic roster\n');
  assert.throws(()=>driver.admit(input),/IDP_APP_ROSTER/);fs.writeFileSync(roster,rosterBefore);
  assert.equal(driver.admit(input).p.coreCommit,commit);
}));
test('actual source defaults and OIDC environment preserve canonical mg/dL representation',()=>fixture(({input})=>{
  assert.equal(require(path.join(input.core,'lib/settings'))().units,'mg/dl');
  const p=input.profile;write(path.join(p.state,'private/client-secret'),crypto.randomBytes(32).toString('base64url'));write(path.join(p.state,'private/cookie-key'),crypto.randomBytes(32).toString('base64'));
  const before={DISPLAY_UNITS:'mg/dl',ENABLE:'api'};
  const result=install.mergeEnvironment(before,profile.adapter(p),'synthetic-only','synthetic_human',{namespaces:{authorization:'synthetic_auth',access:'synthetic_access'},mount:'synthetic_transit'},crypto.randomBytes(32).toString('hex'));
  assert.equal(result.DISPLAY_UNITS,'mg/dl');assert(!Object.hasOwn(profile.apiOverlay(p).services.api.environment,'DISPLAY_UNITS'));
}));
