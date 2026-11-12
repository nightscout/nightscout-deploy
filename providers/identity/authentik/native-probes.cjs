'use strict';
// Native journey helpers, not a transport adapter. Recording exchanges exist only
// as explicit function arguments in focused tests; CLI always uses node:https.
const https=require('node:https'),fs=require('node:fs'),path=require('node:path');
const generic=require('../generic-oidc/adapter'),profile=require('./profile');
function need(value,code){if(!value)generic.fail(code);}
const TRUST_ERRORS=new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT']);
function exchange(c,url,ca,headers={},client=https){
 return new Promise((resolve,reject)=>{
  let timer;const req=client.get(url,{ca,rejectUnauthorized:true,servername:url.hostname,agent:false,headers,timeout:5000,
   lookup:(host,options,done)=>{if(host!==url.hostname||![c.p.issuerHost,...c.p.origins.map(x=>new URL(x).hostname)].includes(host))return done(Error('IDP_DNS_SCOPE'));return options.all?done(null,[{address:c.p.bind,family:4}]):done(null,c.p.bind,4);}},res=>{
    const authorized=res.socket.authorized;const blocks=[];let size=0;res.on('error',reject);res.on('aborted',()=>reject(Error('IDP_PROBE_ABORTED')));
    res.on('data',block=>{size+=block.length;if(size>1048576){req.destroy(Error('IDP_PROBE_BOUND'));return;}blocks.push(block);});
    res.on('end',()=>{clearTimeout(timer);resolve({status:res.statusCode,authorized,body:Buffer.concat(blocks).toString('utf8')});});
   });
  timer=setTimeout(()=>req.destroy(Error('IDP_PROBE_TIMEOUT')),5000);req.on('error',error=>{clearTimeout(timer);reject(error);});req.on('timeout',()=>req.destroy(Error('IDP_PROBE_TIMEOUT')));
 });
}
function discovery(c,response){need(response.authorized===true&&response.status===200,'IDP_TRUST_POSITIVE');let body;try{body=JSON.parse(response.body);}catch{generic.fail('IDP_TRUST_POSITIVE');}generic.discovery(profile.adapter(c.p),body);}
async function untrustedCA(c,send=exchange){
 const url=new URL(profile.adapter(c.p).issuer+'.well-known/openid-configuration');
 const trusted=fs.readFileSync(path.join(c.p.state,'tls/ca.crt')),untrusted=fs.readFileSync(path.join(c.input.appState,'tls/ca.crt'));
 need(!trusted.equals(untrusted),'IDP_DISTINCT_CA_REQUIRED');
 discovery(c,await send(c,url,trusted));
 let code;try{await send(c,url,untrusted);}catch(error){code=error.code;}
 need(TRUST_ERRORS.has(code),'IDP_UNTRUSTED_CA_NOT_REFUSED');
 discovery(c,await send(c,url,trusted));
 return{before:200,refusal:code,restored:200};
}
async function unknownHost(c,origin,cookie,sessionId,send=exchange){
 need(c.p.origins.includes(origin),'IDP_HOST_SCOPE');
 const url=new URL('/api/v2/oidc/session?purpose=management',origin),ca=fs.readFileSync(path.join(c.p.state,'tls/ca.crt'));
 const headers={cookie:cookie.name+'='+cookie.value};
 function healthy(value){let body;try{body=JSON.parse(value.body);}catch{}need(value.authorized===true&&value.status===200&&body?.session?.id===sessionId,'IDP_HOST_POSITIVE');}
 healthy(await send(c,url,ca,headers));
 const host='unknown-'+c.p.nonce+'.synthetic.invalid';need(![c.p.issuerHost,...c.p.origins.map(x=>new URL(x).hostname)].includes(host),'IDP_UNKNOWN_HOST_SCOPE');
 // Keep URL, SNI, trust and connection target unchanged; only HTTP Host changes.
 const denied=await send(c,url,ca,{...headers,host});
 need(denied.authorized===true&&denied.status===421,'IDP_UNKNOWN_HOST_NOT_REFUSED');
 healthy(await send(c,url,ca,headers));
 return{before:200,refusal:421,restored:200};
}
function passwordRefusal(status,body){need(status===200&&body?.component==='ak-stage-password'&&Array.isArray(body?.response_errors?.password)&&body.response_errors.password.some(error=>error.code==='invalid'),'IDP_WRONG_CREDENTIAL_NOT_REFUSED');}
module.exports={exchange,untrustedCA,unknownHost,passwordRefusal};
