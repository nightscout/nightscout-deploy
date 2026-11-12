'use strict';
// Test-only lower-port composition, not a shipping owner/operator API. Authority
// rows and this narrow credential are bootstrapped separately by the native
// fixture. Every settings mutation below uses the actual source component,
// tenant scope, operation window, policy generation and configuration fence.
const assert=require('node:assert/strict'),fs=require('node:fs');
const selected=JSON.parse(fs.readFileSync('/run/ns-settings-control.json','utf8'));
const {Pool}=require('/opt/app/node_modules/pg');
const source='/opt/app/lib/';
async function main(){
 require(source+'storage/tenant-scope').setTenancyMode('multi');
 const pool=new Pool({connectionString:selected.lifetimeUrl,max:2});
 const window=require(source+'tenant-lifecycle/operation-window').create({namespace:selected.controlNamespace,lockRule:'tenant-id-sha256-v1',pool});
 let release,store,policies;
 try{
  await window.ready();release=require(source+'storage/postgres-connection').installOperationWindow(window);
  store=await require(source+'tenant-settings/postgres')({connectionString:selected.connectionString,namespace:selected.namespaces.settings,policyNamespace:selected.namespaces.operatorPolicy,configurationAuthorityNamespace:selected.namespaces.authority});
  policies=await require(source+'operator-policy/postgres-read')({connectionString:selected.connectionString,namespace:selected.namespaces.operatorPolicy});
  const service=require(source+'tenant-settings/component').createTenantSettings({store,
   policyFor:async tenant=>{const current=await policies.read(tenant);return {...current.policy,generation:current.generation};},
   authorize:async actor=>{const current=await store.currentConfigurationAuthority(actor);return !!current&&current.active===true&&current.canConfigure===true;}});
  const mode=process.argv[2];
  if(mode==='admit'){console.log(JSON.stringify({outcome:'ready',boundary:'source-lower-port'}));return;}
  if(mode==='enable'){
   const wrong={...selected.actors[0],tenant:selected.actors[1].tenant};
   await assert.rejects(service.replace(wrong,1,{enable:['simplealarms']}),{code:'SETTINGS_FORBIDDEN'});
   for(const actor of selected.actors){const current=await service.read(actor);await service.replace(actor,current.version,{...current.values,enable:['bgnow','delta','direction','simplealarms']});}
   console.log(JSON.stringify({outcome:'configured',tenants:selected.actors.length,wrongTenant:'refused',boundary:'source-lower-port'}));return;
  }
  if(mode==='revoked'){
   await assert.rejects(service.replace(selected.actors[0],1,{enable:['simplealarms']}),{code:'SETTINGS_FORBIDDEN'});
   console.log(JSON.stringify({outcome:'refused',reason:'SETTINGS_FORBIDDEN',boundary:'source-lower-port'}));return;
  }
  throw Object.assign(new Error(),{code:'EVALUATOR_SETTINGS_CONTROL_REFUSED'});
 }finally{await policies?.close();await store?.close();release?.();await window.close();await pool.end();}
}
main().catch(error=>{console.error(JSON.stringify({code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:error.name}));process.exitCode=1;});
