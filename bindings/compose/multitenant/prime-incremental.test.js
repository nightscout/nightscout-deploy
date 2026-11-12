'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {prime,provision,add}=require('./prime');
const A='10000000-0000-4000-8000-000000000001',B='10000000-0000-4000-8000-000000000002';
async function fixture(run){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ns-primer-incremental-'));let answer=()=>({status:403,body:{}});const calls=[];
const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const call={method:req.method,path:req.url,host:req.headers.host,body:raw?JSON.parse(raw):null};calls.push(call);const reply=answer(call);res.writeHead(reply.status,{'content-type':'application/json'});res.end(JSON.stringify(reply.body));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
try{await run({dir,calls,config:{adminOrigin:origin,apiOrigin:origin,ownerConsumer:'test-owner'},answer:fn=>{answer=fn;}});}finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}}
function write(dir,name,value){fs.writeFileSync(path.join(dir,name),JSON.stringify(value),{mode:0o600});}
test('completed seed marker must not hide new tenant; refusal preserves sealed old commissioning',async()=>fixture(async({dir,calls,config})=>{
const old={id:A,host:'a.example.test',dataToken:'synthetic-only-old',managementToken:'synthetic-only-owner'};
write(dir,'provisioned.json',[{id:A,hosts:['a.example.test'],rootSecret:'synthetic-only-a'},{id:B,hosts:['b.example.test'],rootSecret:'synthetic-only-b'}]);
write(dir,'tenants.json',{version:1,tenants:[old]});write(dir,'primed.json',{state:'synthetic-data-primed',tenants:1});
const before=fs.readFileSync(path.join(dir,'tenants.json'));
await assert.rejects(prime(config,dir),{code:'PRIMER_DATA_API_REFUSED_403'});
assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.equal(calls[0].path,'/api/v2/authorization/roles');assert.deepEqual(fs.readFileSync(path.join(dir,'tenants.json')),before);
}));
test('completed existing tenants require no traffic or credential renewal',async()=>fixture(async({dir,calls,config})=>{
write(dir,'provisioned.json',[{id:A,hosts:['a.example.test'],rootSecret:'synthetic-only'}]);write(dir,'tenants.json',{version:1,tenants:[{id:A,host:'a.example.test',dataToken:'synthetic-only',managementToken:'synthetic-only'}]});write(dir,'primed.json',{state:'synthetic-data-primed',tenants:1});
assert.deepEqual(await prime(config,dir),{state:'synthetic-data-primed',tenants:1});assert.equal(calls.length,0);
}));
test('partial provisioning saves successful custody then resumes exact ids without losing old roots',async()=>fixture(async({dir,calls,config,answer})=>{
const seed=[{id:A,hosts:['a.example.test'],issueRootSecret:true},{id:B,hosts:['b.example.test'],issueRootSecret:true}];
answer(()=>({status:200,body:{results:[{id:A,outcome:'created',rootSecret:'synthetic-only-a'},{id:B,outcome:'refused',code:'TENANT_PROVISION_FAILED'}]}}));
await assert.rejects(provision({...config,seed},dir),{code:'PRIMER_PROVISION_REFUSED_OR_CUSTODY_MISSING'});assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'provisioned.json')))[0].rootSecret,'synthetic-only-a');
answer(()=>({status:200,body:{results:[{id:A,outcome:'existing'},{id:B,outcome:'created',rootSecret:'synthetic-only-b'}]}}));
assert.equal((await provision({...config,seed},dir)).tenants,2);assert.deepEqual(calls.map(c=>c.body.tenants),[seed,seed]);assert.equal(fs.statSync(path.join(dir,'provisioned.json')).mode&0o777,0o600);
}));

test('new commissioning resumes after DATA refusal using same issuance request and never reprimes old tenant',async()=>fixture(async({dir,calls,config,answer})=>{
const old={id:A,host:'a.example.test',dataToken:'synthetic-only-old',managementToken:'synthetic-only-old-owner'};
write(dir,'provisioned.json',[{id:A,hosts:['a.example.test'],rootSecret:'synthetic-only-a'},{id:B,hosts:['b.example.test'],rootSecret:'synthetic-only-b'}]);write(dir,'tenants.json',{version:1,tenants:[old]});write(dir,'primed.json',{state:'synthetic-data-primed',tenants:1});
let refuse=true;const requests=[];
answer(call=>{
if(call.path==='/api/v2/authorization/roles')return{status:200,body:[{name:'demo'}]};
if(call.path==='/api/v2/authorization/subjects')return{status:200,body:[{name:'Synthetic demo uploader',_id:'uploader_b',accessToken:'synthetic-only-b-data'},{name:'Synthetic demo owner',_id:'owner_b'}]};
if(call.path==='/ownership/list')return{status:200,body:{outcome:'listed',owners:[{principal:'owner_b',consumer:'test-owner'}]}};
if(call.path==='/v1/tenants/'+B+'/management-sessions'){requests.push(call.body.requestId);return{status:200,body:{token:'synthetic-only-b-management',expiresAt:2000000000}};}
if(call.path==='/api/v1/entries')return{status:refuse?403:200,body:[]};throw new Error('UNEXPECTED_FIXTURE_ROUTE');
});
await assert.rejects(prime(config,dir),{code:'PRIMER_DATA_API_REFUSED_403'});assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'tenants.json'))).tenants,[old]);refuse=false;
assert.equal((await prime(config,dir)).tenants,2);assert.equal(requests.length,2);assert.equal(requests[0],requests[1]);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'tenants.json'))).tenants[0],old);
assert.ok(calls.filter(c=>c.path.startsWith('/api/')).every(c=>c.host==='b.example.test'));const count=calls.length;await prime(config,dir);assert.equal(calls.length,count,'idempotent completed retry sends no traffic');
}));
test('addition file is explicit bounded provisioning input, malformed spec sends no traffic',async()=>fixture(async({dir,calls,config})=>{
for(const value of [{version:1,tenants:[]},{version:1,tenants:Array(101).fill({})},{version:1,tenants:[{id:B,hosts:['b.example.test'],module:'invalid'}]}]){write(dir,'add.json',value);await assert.rejects(add(config,dir));assert.equal(calls.length,0);}
}));
test('lost sealed commissioning custody refuses without reissuing or uploading',async()=>fixture(async({dir,calls,config})=>{
write(dir,'provisioned.json',[{id:A,hosts:['a.example.test'],rootSecret:'synthetic-only'}]);write(dir,'primed.json',{state:'synthetic-data-primed',tenants:1});await assert.rejects(prime(config,dir),{code:'PRIMER_CUSTODY_INVALID'});assert.equal(calls.length,0);
}));
