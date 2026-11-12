'use strict';
// Executes the exact pure settings() body from the pinned source; no provider,
// datastore or serving-role substitutes. Full startup remains native-unmeasured.
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),{execFileSync}=require('node:child_process');
const core=process.env.IDP_TEST_CORE,commit=process.env.IDP_TEST_CORE_COMMIT;
if(!core||!/^[a-f0-9]{40}$/.test(commit||''))throw Error('IDP_TEST_SOURCE_REQUIRED');
const source=execFileSync('git',['-C',core,'show',commit+':lib/human-session/runtime.js'],{encoding:'utf8'});
const start=source.indexOf('function settings ('),end=source.indexOf('\n}\n',start)+2;
assert(start>=0&&end>start);
const settings=vm.runInNewContext('('+source.slice(start,end)+')',{Buffer,URL});
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const generic=require('../../generic-oidc/adapter');
function fixture(body){const root=fs.mkdtempSync(path.join(os.tmpdir(),'idp-settings-unit-'));try{for(const [name,value]of [['secret',crypto.randomBytes(32).toString('base64url')],['cookie',crypto.randomBytes(32).toString('base64')]])fs.writeFileSync(path.join(root,name),value,{mode:0o600});const descriptor={version:1,provider:'generic-oidc',mode:'registry',issuer:'https://issuer.synthetic.invalid/oidc/',clientId:'synthetic-client',secretFile:path.join(root,'secret'),cookieKeyFile:path.join(root,'cookie'),origins:['https://one.example.test','https://two.example.test'],signingAlgorithm:'RS256'};body(descriptor);}finally{fs.rmSync(root,{recursive:true,force:true});}}
test('pinned actual registry settings parser accepts generated env without static origin',()=>fixture(a=>{const env=generic.environment(a),parsed=settings(env,{registry:true});assert.equal(parsed.issuer,a.issuer);assert.equal(parsed.origin,undefined);assert.equal(parsed.cookieKey.length,32);assert.equal(parsed.signingAlgorithm,'RS256');assert.throws(()=>settings(env));}));
test('pinned actual single settings parser accepts exact origin and rejects malformed cookie',()=>fixture(a=>{a.mode='single';a.origins=a.origins.slice(0,1);const env=generic.environment(a);assert.equal(settings(env).origin,a.origins[0]);assert.throws(()=>settings({...env,OIDC_COOKIE_KEY:'invalid'}));assert.throws(()=>settings({...env,OIDC_ORIGIN:'http://one.example.test'}));}));
