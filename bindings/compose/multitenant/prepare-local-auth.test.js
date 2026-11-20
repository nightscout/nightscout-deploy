'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module');
const tenant='11111111-1111-4111-8111-111111111111';
test('operator closes audited-reader pools before real maintenance factory and releases root/owners',async()=>{
 const events=[],root=Buffer.from('synthetic-root-for-protocol-only'),original=Module._load;
 const controller={close:async()=>events.push('controller-close')};
 Module._load=function(name,...rest){
  if(name.endsWith('/tenant-scope'))return{setTenancyMode:()=>{}};
  if(name.endsWith('/postgres-connection'))return async()=>({withTenant:async(t,fn)=>{assert.equal(t,tenant);return fn();},query:async()=>({rows:[{root_reference_id:'root'}]}),end:async()=>events.push('reader-close')});
  if(name.endsWith('/secrets/postgres'))return{createPostgresSecrets:async()=>({close:async()=>events.push('audit-close')})};
  if(name.endsWith('/secrets/component'))return{createSecrets:()=>({decrypt:async()=>{events.push('audit-decrypt');return root;}})};
  if(name.endsWith('/secrets/vault-transit'))return{createVaultTransit:options=>{assert.equal(typeof options.getToken,'function');assert.deepEqual(Object.keys(options).sort(),['address','encryptionKey','getToken','mount','timeoutMs']);return{};}};
  if(name.endsWith('/tenant-registry/rules'))return{vaultKey:(t,p)=>'tenant-'+p};
  if(name==='./config')return{layout:()=>({mount:'synthetic'})};
  if(name==='pg')return{Pool:class{async end(){events.push('pool-close');}}};
  if(name.endsWith('/maintenance-window'))return{create:()=>{assert.deepEqual(events,['reader-close','audit-decrypt','audit-close']);return controller;}};
  if(name.endsWith('/secrets/prepare-local-auth'))return{withMaintenance:options=>{assert.equal(options.controller,controller);return async(t,args)=>{assert.equal(t,tenant);assert.deepEqual(Object.keys(args),['artifactDigest']);assert.match(args.artifactDigest,/^[a-f0-9]{64}$/);assert.equal(await options.readRoot({tenant,id:'root'}),root);await assert.rejects(options.readRoot({tenant,id:'changed'}));events.push('maintenance-committed');return{prepared:true};};}};
  return original.call(this,name,...rest);
 };
 try{const result=await require('./prepare-local-auth').prepare({tenants:[{id:tenant}],namespaces:{legacy:'ns_legacy',secrets:'ns_secrets'},control:{namespace:'ns_control',registry:{namespace:'ns_registry'},participants:[],locks:[]},drainTimeoutMs:1000},tenant,{NS_OPERATOR_PG:'synthetic-runtime-reference',NS_AUTH_AUDIT_PG:'synthetic-audit-reference'});assert.deepEqual(result,{prepared:true});assert(root.every(b=>b===0));assert.deepEqual(events.slice(-3),['maintenance-committed','controller-close','pool-close']);}
 finally{Module._load=original;}
});
