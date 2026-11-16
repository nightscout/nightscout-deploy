'use strict';
const crypto = require('node:crypto');

// Observed 2026-11-11; refresh against doctl compute size list before a live campaign.
const SIZES = Object.freeze({
  'c-2': { vcpus: 2, memoryGiB: 4, hourlyUSD: 0.0625 },
  'c-4': { vcpus: 4, memoryGiB: 8, hourlyUSD: 0.125 },
  'c-8': { vcpus: 8, memoryGiB: 16, hourlyUSD: 0.25 },
  'c-16': { vcpus: 16, memoryGiB: 32, hourlyUSD: 0.5 },
  'g-4vcpu-16gb': { vcpus: 4, memoryGiB: 16, hourlyUSD: 0.1875 }
});
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
function validate(s) {
  const allowed = ['version','profile','diagnostics','diagnosticsIntervalMs','diagnosticProbeSha256','k6Image','testMongo8Image','testMongoImage','testPostgresImage','testVaultImage','apiReplicas','capacityLevels','instrumentCommit','runId','region','topology','appNodes','generatorNodes','appSize','databaseSize','generatorSize','tenants','socketsPerTenant','credentialProfile','seed','historyHours','hotFactor','acceleration','httpEnabled','recoveryTest','warmSeconds','loadSeconds','maxMinutes','maxEstimatedUSD','coreCommit','deployCommit','alignmentCommit','appImage','bundleSha256','sshKeyFingerprint','sshPublicKey','sshIdentityFile','sshUser','controllerCidr','vpcUuid','osImage'];
  assert(s && typeof s === 'object' && !Array.isArray(s), 'Experiment must be an object');
  assert(Object.keys(s).every(k => allowed.includes(k)), 'Unknown experiment field');
  assert(s.version === 1, 'Unsupported experiment version');
  if(s.profile!==undefined)assert(['colocated-smoke-v1','colocated-capacity-v1','joined-diagnostic-v1','joined-pilot-v1','joined-baseline-diagnostic-v1','cache-diagnostic-v1','core-acceptance-v1','joined-external-generator-v1'].includes(s.profile),'Unknown workload profile');
  if(s.profile==='cache-diagnostic-v1'){
    assert(s.topology==='colocated'&&s.appNodes===1&&s.generatorNodes===0&&s.appSize==='c-8'&&s.tenants===1&&s.socketsPerTenant===0&&s.httpEnabled===false&&s.recoveryTest==='none'&&s.warmSeconds===0&&s.loadSeconds===1&&s.maxMinutes<=30,'Invalid cache diagnostic bounds');
    assert(typeof s.diagnosticProbeSha256==='string'&&/^[a-f0-9]{64}$/.test(s.diagnosticProbeSha256),'Cache diagnostic requires hashed source-bound probe');
  }else assert(s.diagnosticProbeSha256===undefined,'Diagnostic probe requires cache diagnostic profile');
  if(s.profile==='core-acceptance-v1'){
    assert(s.topology==='colocated'&&s.appNodes===1&&s.generatorNodes===0&&s.appSize==='c-16'&&s.tenants===1&&s.socketsPerTenant===0&&s.httpEnabled===false&&s.recoveryTest==='none'&&s.warmSeconds===0&&s.loadSeconds===1,'Invalid core acceptance bounds');
    for(const [field,repository]of [['testMongo8Image','mongo'],['testMongoImage','mongo'],['testPostgresImage','postgres'],['testVaultImage','hashicorp/vault']])assert(typeof s[field]==='string'&&new RegExp('^'+repository+'@sha256:[a-f0-9]{64}$').test(s[field]),'Core acceptance requires pinned test images');
  }else assert(['testMongo8Image','testMongoImage','testPostgresImage','testVaultImage'].every(k=>s[k]===undefined),'Test image overrides require core acceptance profile');
  if(s.profile==='joined-external-generator-v1'){
    assert(s.topology==='colocated'&&s.appNodes===1&&s.generatorNodes===1&&s.appSize==='c-16'&&s.apiReplicas===1&&Array.isArray(s.capacityLevels)&&s.capacityLevels.length>=1&&s.capacityLevels.length<=3&&s.capacityLevels.every((n,i)=>integer(n,1,1000)&&(i===0||n>s.capacityLevels[i-1]))&&s.tenants===s.capacityLevels.at(-1)&&s.socketsPerTenant===2&&s.hotFactor===10&&s.acceleration===1&&s.httpEnabled===true&&s.recoveryTest==='role-restart'&&s.warmSeconds===120&&s.loadSeconds===300&&s.diagnostics==='off'&&s.diagnosticsIntervalMs===5000,'Invalid external-generator bounds');
    assert(typeof s.k6Image==='string'&&/^grafana\/k6@sha256:[a-f0-9]{64}$/.test(s.k6Image),'External generator requires pinned k6 image');
  }else if(['joined-pilot-v1','joined-baseline-diagnostic-v1'].includes(s.profile)){
    assert(s.topology==='colocated'&&s.appNodes===1&&s.generatorNodes===0&&s.appSize==='c-16'&&s.apiReplicas===1&&s.tenants===1000&&JSON.stringify(s.capacityLevels)==='[500,750,1000]'&&s.socketsPerTenant===2&&s.hotFactor===10&&s.acceleration===1&&s.httpEnabled===true&&s.recoveryTest==='role-restart'&&s.warmSeconds===120&&s.loadSeconds===300,'Invalid joined pilot bounds');
    assert(['off','on'].includes(s.diagnostics)&&integer(s.diagnosticsIntervalMs,1000,60000),'Invalid pilot diagnostics selection');
    if(s.profile==='joined-baseline-diagnostic-v1')assert(s.diagnostics==='off'&&s.diagnosticsIntervalMs===5000,'Unaccepted baseline requires diagnostics off/5000');
    assert(typeof s.k6Image==='string'&&/^grafana\/k6@sha256:[a-f0-9]{64}$/.test(s.k6Image),'Joined pilot requires pinned k6 image');
  }else {
    assert(s.k6Image===undefined,'k6 image override requires joined pilot profile');
    assert(s.diagnostics===undefined&&s.diagnosticsIntervalMs===undefined,'Diagnostics selection requires joined pilot profile');
  }
  if(s.profile==='joined-diagnostic-v1')assert(s.topology==='colocated'&&s.appNodes===1&&s.generatorNodes===0&&integer(s.tenants,1,10)&&integer(s.apiReplicas,1,2)&&s.warmSeconds===0&&integer(s.loadSeconds,1,180)&&s.socketsPerTenant===1,'Invalid joined diagnostic bounds');
  else if(!['joined-pilot-v1','joined-baseline-diagnostic-v1','joined-external-generator-v1'].includes(s.profile))assert(s.apiReplicas===undefined,'API replica override requires joined diagnostic profile or joined pilot profile');
  if(s.profile==='colocated-capacity-v1') {
    assert(Array.isArray(s.capacityLevels) && s.capacityLevels.length>=1 && s.capacityLevels.length<=5 && s.capacityLevels.every((n,i)=>integer(n,1,10000) && (i===0 || n>s.capacityLevels[i-1])),'Invalid capacity levels');
    assert(s.tenants===s.capacityLevels.at(-1),'Capacity tenants must name maximum level');
  } else if(!['joined-pilot-v1','joined-baseline-diagnostic-v1','joined-external-generator-v1'].includes(s.profile))assert(s.capacityLevels===undefined,'Capacity levels require capacity profile or joined pilot profile');
  assert(/^[a-z][a-z0-9-]{2,39}$/.test(s.runId), 'Invalid runId');
  assert(/^[a-z]{3}[1-9]$/.test(s.region), 'Invalid region');
  assert(['colocated','separated'].includes(s.topology), 'Invalid topology');
  assert(integer(s.appNodes,1,4) && integer(s.generatorNodes,0,8) && (s.generatorNodes>0 || s.topology==='colocated' && s.appNodes===1), 'Invalid node counts');
  assert([s.appSize,s.databaseSize,s.generatorSize].every(k => Object.hasOwn(SIZES,k)), 'Unknown size');
  assert(integer(s.tenants,1,10000) && integer(s.socketsPerTenant,0,20), 'Invalid workload size');
  assert(['legacy','local-token','mixed'].includes(s.credentialProfile), 'Invalid credential profile');
  assert(integer(s.seed,0,2147483647), 'Invalid seed');
  assert(integer(s.historyHours,1,8760) && integer(s.hotFactor,1,100) && integer(s.acceleration,1,100), 'Invalid synthetic workload parameters');
  assert(typeof s.httpEnabled==='boolean' && ['none','role-restart'].includes(s.recoveryTest), 'Invalid workload/recovery selection');
  assert(integer(s.warmSeconds,0,1800) && integer(s.loadSeconds,1,3600), 'Invalid phase duration');
  assert(integer(s.maxMinutes,5,180) && s.maxMinutes * 60 > s.warmSeconds + s.loadSeconds + 120, 'Insufficient run deadline');
  assert(Number.isFinite(s.maxEstimatedUSD) && s.maxEstimatedUSD > 0 && s.maxEstimatedUSD <= 20, 'Invalid estimated-cost ceiling');
  assert([s.coreCommit,s.deployCommit].every(v => /^[0-9a-f]{40}$/.test(v)), 'Source commits must be pinned');
  assert(/^ghcr\.io\/[a-z0-9/_.-]+@sha256:[0-9a-f]{64}$/.test(s.appImage) || s.appImage===`source:${s.coreCommit}:${s.deployCommit}`, 'Image must be pinned by digest or exact source commits');
  if(s.alignmentCommit!==undefined) assert(/^[0-9a-f]{40}$/.test(s.alignmentCommit),'Alignment commit must be pinned');
  if(s.instrumentCommit!==undefined) assert(/^[0-9a-f]{40}$/.test(s.instrumentCommit),'Instrument commit must be pinned');
  if(s.sshPublicKey!==undefined) assert(typeof s.sshPublicKey==='string' && /^(ssh-ed25519|ssh-rsa) [A-Za-z0-9+/=]+$/.test(s.sshPublicKey),'Invalid public SSH key');
  if(s.sshIdentityFile!==undefined) assert(typeof s.sshIdentityFile==='string' && /^\/[A-Za-z0-9_./-]+$/.test(s.sshIdentityFile) && !s.sshIdentityFile.split('/').includes('..'),'Invalid controller SSH identity path');
  if(s.sshUser!==undefined)assert(['root','nsperf'].includes(s.sshUser),'Unsupported bootstrap user');
  assert(/^[0-9a-f]{64}$/.test(s.bundleSha256), 'Bundle manifest digest required');
  assert(typeof s.sshKeyFingerprint === 'string' && s.sshKeyFingerprint.length > 0 && s.sshKeyFingerprint.length < 160, 'Existing SSH key fingerprint required');
  if(s.sshKeyFingerprint==='cloud-init')assert(s.sshPublicKey,'Cloud-init public key required');
  assert(/^(\d{1,3}\.){3}\d{1,3}\/32$/.test(s.controllerCidr) && s.controllerCidr.split('/')[0].split('.').every(v => Number(v) <= 255), 'Controller must be a single IPv4 /32');
  assert(/^[0-9a-f-]{36}$/.test(s.vpcUuid), 'Existing VPC UUID required');
  assert(integer(s.osImage,1,Number.MAX_SAFE_INTEGER), 'OS image must be an exact numeric DigitalOcean image ID');
  const estimate = cost(s);
  assert(estimate.maximumRuntimeUSD <= s.maxEstimatedUSD, 'Estimated runtime exceeds cost ceiling');
  return s;
}
function nodes(s) {
  const result = {};
  for (let i=0;i<s.appNodes;i++) result[`app-${i}`] = { role:'app', size:s.appSize };
  if (s.topology === 'separated') result['postgres-0'] = { role:'postgres', size:s.databaseSize };
  for (let i=0;i<s.generatorNodes;i++) result[`generator-${i}`] = { role:'generator', size:s.generatorSize };
  return result;
}
function cost(s) {
  const selected = Object.values(nodes(s));
  const hourlyUSD = selected.reduce((sum,n) => sum + (SIZES[n.size]?.hourlyUSD || 0),0);
  return { hourlyUSD, maximumRuntimeUSD:selected.reduce((sum,n) => sum + Math.max(0.01,SIZES[n.size].hourlyUSD * s.maxMinutes / 60),0), pricingDate:'2026-11-11', excludes:'tax, transfer overage, retained artifacts, and failed cleanup beyond the deadline; estimate is not a billing cap' };
}
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
module.exports = { validate, nodes, cost, digest, SIZES };
