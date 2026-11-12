'use strict';
const fs=require('node:fs'),http=require('node:http');
const tenants=JSON.parse(fs.readFileSync('/run/ns-config/tenants.json','utf8')).tenants;
function call(origin,tenant,route,token){return new Promise((resolve,reject)=>{const request=http.request(origin+route,{timeout:10000,headers:{host:tenant.host,accept:'application/json',...(token?{authorization:'Bearer '+token}:{})}},response=>{const chunks=[];response.on('data',c=>chunks.push(c));response.on('end',()=>{try{resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())});}catch{resolve({status:response.statusCode,body:null});}});});request.on('timeout',()=>request.destroy());request.on('error',()=>reject(new Error('STATUS_TRANSPORT_UNAVAILABLE')));request.end();});}
(async()=>{for(const origin of ['http://api:1337','http://api-2:1337','http://nginx:8080'])for(const [index,tenant] of tenants.entries()){
 const exchange=await call(origin,tenant,'/api/v2/authorization/request/'+encodeURIComponent(tenant.dataToken));const code=result=>typeof result.body?.error==='string'&&/^[A-Z0-9_]{1,96}$/.test(result.body.error)?result.body.error:null;
 console.log(JSON.stringify({stage:'exchange',instance:origin.split('//')[1],tenant:index,status:exchange.status,code:code(exchange)}));
 if(exchange.status!==200||typeof exchange.body?.token!=='string'){process.exitCode=1;continue;}
 const status=await call(origin,tenant,'/api/v1/status.json',exchange.body.token);console.log(JSON.stringify({stage:'status',instance:origin.split('//')[1],tenant:index,status:status.status,code:code(status)}));if(status.status!==200)process.exitCode=1;
}})().catch(()=>{console.error('STATUS_PROBE_UNAVAILABLE');process.exitCode=1;});
