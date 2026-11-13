'use strict';
// Pure derivation of the only assignment-specific private worker environment.
// Admission files/claim dirs are supplied independently by the fixed allocator.
// Never overrides environment on the command line: load-env reapplies env.json.
const {isDeepStrictEqual:equal}=require('node:util'),A=require('./realtime-recovery-action');
const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)&&v!=='00000000-0000-0000-0000-000000000000';
function derive(template,assignment,{configBytes,environmentBytes}){
 need(uuid(assignment),'REALTIME_RECOVERY_WORKER_ASSIGNMENT');
 need(template.address&&equal(Object.keys(template.address),['socket']),'REALTIME_RECOVERY_WORKER_SOCKET_PROFILE');
 for(const bytes of [configBytes,environmentBytes])need(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=1048576,'REALTIME_RECOVERY_WORKER_FILE');
 need(A.rawSha(configBytes)===template.configSha256&&A.rawSha(environmentBytes)===template.environmentSha256,'REALTIME_RECOVERY_WORKER_FILE_CHANGED');
 const env=JSON.parse(environmentBytes.toString('utf8'));need(env&&typeof env==='object'&&!Array.isArray(env),'REALTIME_RECOVERY_WORKER_ENV');
 for(const [key,value] of Object.entries(env))need(/^[A-Z][A-Z0-9_]*$/.test(key)&&typeof value==='string'&&!value.includes('\0')&&!/^NS_CONNECTION_BUDGET_/.test(key)&&!['NODE_OPTIONS','NODE_PATH','PATH','LD_PRELOAD','NS_ENV_FILE','MULTITENANT_CONFIG_MAX_BYTES'].includes(key),'REALTIME_RECOVERY_WORKER_ENV');
 need(env.REALTIME_WORKER_ID===template.worker&&env.NS_REALTIME_OWNERSHIP_CONTRACT==='assignment-v2'&&uuid(env.REALTIME_WORKER_INCARNATION)&&equal({socket:env.NS_SERVE_INTERNAL_SOCKET},template.address),'REALTIME_RECOVERY_WORKER_ENV');
 const result={...env,REALTIME_WORKER_INCARNATION:assignment},bytes=Buffer.from(JSON.stringify(result)+'\n');
 return Object.freeze({configBytes:Buffer.from(configBytes),environmentBytes:bytes,configSha256:A.rawSha(configBytes),environmentSha256:A.rawSha(bytes)});
}
module.exports=Object.freeze({derive});
