'use strict';
// Explicit synthetic qualification adapter. All authority comes from the real
// private admin, DATA and management-issuance APIs; no SQL or Vault client.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const assert=require('node:assert/strict'),primer=require('../prime');
function raw(origin,route,host){return new Promise((resolve,reject)=>{const req=http.get(new URL(route,origin),{headers:{host},timeout:5000},res=>{let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>1048576)req.destroy(new Error('LIVE_ADD_RESPONSE_LIMIT'));});res.on('end',()=>resolve(res.statusCode));res.on('error',reject);});req.on('timeout',()=>req.destroy(new Error('LIVE_ADD_REQUEST_TIMEOUT')));req.on('error',reject);});}
async function qualify({directory,edgeOrigin='http://nginx:8080',config=primer.load(path.join(directory,'config.json'))}){
 const known=JSON.parse(fs.readFileSync(path.join(directory,'tenants.json')));assert.equal(known.version,1);assert.ok(known.tenants.length>=2);
 const oldBytes=fs.readFileSync(path.join(directory,'tenants.json')),old=known.tenants[0];
 const roots=JSON.parse(fs.readFileSync(path.join(directory,'provisioned.json')));const root=roots.find(row=>row.id===old.id);assert.ok(root);
 const headers={host:old.host,'api-secret':crypto.createHash('sha1').update(root.rootSecret).digest('hex')};
 const before=await primer.request(edgeOrigin,'/api/v1/entries.json',{headers});assert.equal(before.status,200);assert.ok(Array.isArray(before.body));
 const nonce=crypto.randomUUID(),id=crypto.randomUUID(),host='live-add-'+nonce+'.example.test';
 // Sealed request before any mutation: rerunning this fixture is refused. Its
 // targeted API retries below preserve the exact tenant and root custody.
 const journal=path.join(directory,'live-add-qualification.json');fs.writeFileSync(journal,JSON.stringify({version:1,id,host,state:'started'})+'\n',{flag:'wx',mode:0o600});
 const spec={id,hosts:[host],issueRootSecret:true};
 // One valid new tenant plus a conflicting existing tenant exercises actual
 // per-tenant partial failure, not a synthetic transport exception.
 await assert.rejects(primer.provision({...config,seed:[spec,{id:old.id,hosts:['conflict-'+nonce+'.example.test'],issueRootSecret:true}]},directory),{code:'PRIMER_PROVISION_REFUSED_OR_CUSTODY_MISSING'});
 assert.deepEqual(fs.readFileSync(path.join(directory,'tenants.json')),oldBytes);
 const partial=JSON.parse(fs.readFileSync(path.join(directory,'provisioned.json')));assert.ok(partial.find(row=>row.id===id)?.rootSecret);assert.deepEqual(partial.find(row=>row.id===old.id),root);
 const newRoot=partial.find(row=>row.id===id).rootSecret;
 await primer.provision({...config,seed:[spec]},directory);
 assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'provisioned.json'))).find(row=>row.id===id).rootSecret,newRoot);
 await primer.prime(config,directory);
 const after=JSON.parse(fs.readFileSync(path.join(directory,'tenants.json')));assert.deepEqual(after.tenants.slice(0,known.tenants.length),known.tenants);assert.equal(after.tenants.length,known.tenants.length+1);
 const added=after.tenants.find(row=>row.id===id);assert.ok(added?.dataToken&&added?.managementToken);
 const freshHeaders={host,'api-secret':crypto.createHash('sha1').update(newRoot).digest('hex')};
 const deadline=Date.now()+60000;let fresh;
 do{fresh=await primer.request(edgeOrigin,'/api/v1/entries.json',{headers:freshHeaders});if(fresh.status===200)break;if(fresh.status!==503||fresh.body.error!=='TENANT_WARMING')throw new Error('LIVE_ADD_FRONTDOOR_REFUSED');await new Promise(r=>setTimeout(r,200));}while(Date.now()<deadline);
 assert.equal(fresh.status,200);assert.ok(fresh.body.some(row=>row._id==='synthetic-reading-'+known.tenants.length),'new tenant data reaches actual edge');
 const continuity=await primer.request(edgeOrigin,'/api/v1/entries.json',{headers});assert.equal(continuity.status,200);assert.deepEqual(continuity.body,before.body,'old tenant clinical rows unchanged');
 const foreign=await primer.request(edgeOrigin,'/api/v1/entries.json',{headers:{host:old.host,'api-secret':added.dataToken}});assert.ok([401,403].includes(foreign.status),'new credential refused on old tenant');
 assert.equal(await raw(edgeOrigin,'/api/v1/entries.json','unknown-'+nonce+'.example.test'),421);
 for(const route of ['/v1/tenants','/admin','/api/v1/tenant'])assert.ok([404,421].includes(await raw(edgeOrigin,route,host)),'private operator/management route not exposed');
 const sealed=fs.readFileSync(path.join(directory,'tenants.json'));await primer.prime(config,directory);assert.deepEqual(fs.readFileSync(path.join(directory,'tenants.json')),sealed);
 const result={version:1,state:'passed',oldTenants:known.tenants.length,newTenants:1,partialFailure:'existing-host-conflict',resume:'same-id-root-custody',scope:'synthetic-shipping-registry-admin-live-add',pauseSuspend:'deferred'};primer.privateWrite(journal,result);return result;
}
if(require.main===module){if(process.env.NS_SHIPPING_LIVE_ADD_ACK!=='synthetic-disposable-only'){console.error('SHIPPING_LIVE_ADD_NOT_SELECTED');process.exitCode=1;}else qualify({directory:process.env.NS_PRIMER_STATE||'/run/ns-primer'}).then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('SHIPPING_LIVE_ADD_FAILED');process.exitCode=1;});}
module.exports={qualify,raw};
