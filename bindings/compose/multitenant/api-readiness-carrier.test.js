'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const {read,validate}=require('./fixtures/api-readiness-private.cjs');
test('private client sends DATA api-secret to exact service/status; no exchange, token URL or bearer',async()=>{
 const target={service:'api-2',tenantOrdinal:1,host:'two.synthetic.example',credential:'synthetic-opaque-data-token'};
 validate({targets:[target]});let selected;
 const response=await read(target,{timeoutMs:1000,request:(options,callback)=>{selected=options;const req=new EventEmitter();req.destroy=()=>req.emit('error',new Error('synthetic'));req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;callback(res);res.emit('data',Buffer.from('{"status":"ok"}'));res.emit('end');req.emit('close');});return req;}});
 assert.deepEqual(response,{status:200,code:null});assert.equal(selected.hostname,'api-2');assert.equal(selected.port,1337);assert.equal(selected.path,'/api/v1/status.json');assert.equal(selected.method,'GET');assert.deepEqual(selected.headers,{host:target.host,accept:'application/json','api-secret':target.credential});assert.equal(selected.agent,false);
 for(const bad of ['\r','\n','\0'])assert.throws(()=>validate({targets:[{...target,credential:'token'+bad}]}),/INPUT_REFUSED/);
});
const core=process.env.NS_UI_TEST_CORE;
test('actual source tenant middleware, secrets derivation, permission and status handler accept DATA carrier only after initialized',{skip:!core},async()=>{
 const source=file=>require(path.join(core,file)),express=source('node_modules/express'),request=source('node_modules/supertest'),scope=source('lib/storage/tenant-scope');const before=scope.getTenancyMode();scope.setTenancyMode('multi');
 try{
 const records=new Map(),provider=source('tests/fixtures/tenant-credential-provider')(),subjects=new Map([['A','subject-a'],['B','subject-b']]);
 const secrets=source('lib/secrets/component').createSecrets({maxTokenLifetimeSeconds:28800,providerFor:async()=>provider,store:{get:async(t,id)=>records.get(t+':'+id),insert:async record=>records.set(record.tenant+':'+record.id,record)},authorize:async()=>true,audit:async()=>{},legacyAuthorityFor:async tenant=>({reference:{tenant,id:'root'},subjects:[{subjectId:subjects.get(tenant),tokenPrefix:'synthetic'}]})});
 const token=new Map();for(const tenant of ['A','B']){const root=crypto.randomBytes(24).toString('hex'),context={tenant,principal:'synthetic',consumer:'api'};await secrets.encrypt(context,'root',Buffer.from(root));token.set(tenant,(await secrets.rootLegacyTokens(context,{apiSecret:crypto.createHash('sha1').update(root).digest('hex')})).get(subjects.get(tenant)));}
 let revoked=false,warm=false,verifications=0;const seen=[];
 const access=source('lib/server/tenant-app/data-access')({secrets:{verifyLegacyCredential:async(context,carrier)=>{verifications++;seen.push({tenant:context.tenant,apiSecret:carrier.apiSecret,token:carrier.token});return secrets.verifyLegacyCredential(context,carrier);}},authority:{authorize:async({tenant,principal,permission})=>!revoked&&principal.subjectId===subjects.get(tenant)&&permission==='api:status:read'},verifierContext:async tenant=>({tenant,principal:'synthetic',consumer:'api'}),safeRoutes:{1:['/status']}});
 const statusApp=express();statusApp.set('name','synthetic');statusApp.set('version','synthetic');statusApp.enable('api');statusApp.extendedClientSettings={};
 const env={settings:{enable:[],filteredSettings:()=>({})}},wares=source('lib/middleware')(env),authorization=source('lib/server/tenant-app/legacy-authorization')();
 const legacy=source('lib/api/status')(statusApp,wares,env,{authorization},{authorizeStatus:async()=>null});
 const app=source('lib/server/tenant-app').createTenantApp({resolver:{resolve:async req=>req.headers.host==='a.synthetic'?'A':'B'},verifyCredential:async()=>null,authorizeRequest:async()=>false,tenantSettings:{read(){},replace(){},rollback(){}},subjectPolicy:{read(){},replace(){}},dataRouter:express.Router(),dataAccess:access,legacyRouter:legacy,prepareTenant:async()=>{if(!warm)throw Object.assign(new Error('TENANT_WARMING'),{code:'TENANT_WARMING',retryAfter:5});}});
 let response=await request(app).get('/api/v1/status.json').set('Host','a.synthetic').set('api-secret',token.get('A'));assert.equal(response.status,503);assert.equal(response.body.error,'TENANT_WARMING');assert.equal(verifications,0);
 warm=true;response=await request(app).get('/api/v1/status.json').set('Host','a.synthetic').set('api-secret',token.get('A'));assert.equal(response.status,200);assert.equal(response.body.status,'ok');assert.equal(seen.at(-1).apiSecret,token.get('A'));assert.equal(seen.at(-1).token,undefined);
 for(const credential of ['invalid-synthetic',token.get('B')]){response=await request(app).get('/api/v1/status.json').set('Host','a.synthetic').set('api-secret',credential);assert.equal(response.status,401);}
 revoked=true;response=await request(app).get('/api/v1/status.json').set('Host','a.synthetic').set('api-secret',token.get('A'));assert.equal(response.status,401);
 }finally{scope.setTenancyMode(before);}
});
