'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {command,checkBundle}=require('./drivers');
const {validate}=require('./spec');
const {exportPack,hash}=require('./smoke-bundle');
const {sparsePack,PATHS}=require('./source-pack.cjs');
const {sha}=require('./joined-preflight.cjs');
const REUSED=['tools/mt-bench/capacity/probe.js','tools/mt-bench/capacity/k6/workload.js','tools/mt-bench/compose-baseline/probes/sample.sh','tools/mt-bench/compose-baseline/oracle/disk.sh'];
async function instrumentIdentity(repo,commit){
  const names=(await command('git',['-C',repo,'ls-tree','-r','--name-only',commit,'tools/mt-bench/m7-joined'])).stdout.trim().split('\n').filter(Boolean);
  if(!names.includes('tools/mt-bench/m7-joined/diagnostic.cjs'))throw new Error('JOINED_DIAGNOSTIC_INSTRUMENT_NOT_COMMITTED');
  const files={};for(const name of [...new Set([...names,...REUSED])].sort()){
    if(!/^tools\/[A-Za-z0-9_./-]+$/.test(name))throw new Error('JOINED_INSTRUMENT_PATH_INVALID');
    files[name]=sha((await command('git',['-C',repo,'show',commit+':'+name])).stdout);
  }
  // Python instrument() uses json.dumps(sort_keys=True), including these spaces.
  return {commit,files,sha256:sha('{'+Object.keys(files).sort().map(k=>JSON.stringify(k)+': '+JSON.stringify(files[k])).join(', ')+'}')};
}
function diagnosticReceipt(receipt,spec,instrument){
  if(receipt?.kind!=='joined-diagnostic'||receipt.status!=='AUTHORIZED_DIAGNOSTIC'||receipt.pair?.core!==spec.coreCommit||receipt.pair?.deploy!==spec.deployCommit||receipt.instrument!==instrument.sha256)throw new Error('JOINED_DIAGNOSTIC_RECEIPT_MISMATCH');
  const l=receipt.limits;
  if(!l||!Number.isInteger(l.tenants)||l.tenants<spec.tenants||l.tenants>10||!Number.isInteger(l.apiReplicas)||l.apiReplicas<spec.apiReplicas||l.apiReplicas>2||l.trafficSeconds!==spec.loadSeconds)throw new Error('JOINED_DIAGNOSTIC_LIMIT_MISMATCH');
}
async function buildJoinedBundle({directory,core,deploy,alignment,spec,receipt}){
  validate(spec);if(spec.profile!=='joined-diagnostic-v1')throw new Error('JOINED_DIAGNOSTIC_PROFILE_REQUIRED');
  const instrument=await instrumentIdentity(alignment,spec.alignmentCommit);diagnosticReceipt(receipt,spec,instrument);
  await fs.mkdir(directory,{mode:0o700});const files={};
  for(const [name,repo,commit]of [['core',core,spec.coreCommit],['deploy',deploy,spec.deployCommit]]){
    const file=name+'.pack';await exportPack(repo,commit,path.join(directory,file));files[file]=await hash(path.join(directory,file));
  }
  await sparsePack(alignment,spec.alignmentCommit,path.join(directory,'alignment.pack'),PATHS);files['alignment.pack']=await hash(path.join(directory,'alignment.pack'));
  for(const [name,value]of [['joined-receipt.json',receipt],['joined-instrument.json',instrument]]){
    await fs.writeFile(path.join(directory,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});files[name]=await hash(path.join(directory,name));
  }
  for(const file of ['remote-joined.sh','smoke-runner.mjs','joined-prerequisites.cjs','joined-capture.py']){await fs.copyFile(path.join(__dirname,file),path.join(directory,file));files[file]=await hash(path.join(directory,file));}
  for(const stage of ['deploy','campaign','collect']){const file=stage+'.mjs';await fs.writeFile(path.join(directory,file),`import {run} from './smoke-runner.mjs';\nawait run('${stage}');\n`,{mode:0o600});files[file]=await hash(path.join(directory,file));}
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({version:1,adapter:'controller-bundle-v1',profile:spec.profile,files},null,2)+'\n',{mode:0o600});
  const bundleSha256=await hash(path.join(directory,'manifest.json'));await checkBundle(directory,bundleSha256);return {directory,bundleSha256};
}
module.exports={instrumentIdentity,diagnosticReceipt,buildJoinedBundle};
