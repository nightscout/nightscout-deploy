'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const {isDeepStrictEqual}=require('node:util');
const {validate}=require('./spec');
const {command,checkBundle}=require('./drivers');
const {buildPilotBundle}=require('./pilot-bundle.cjs');
const {sparsePack,PATHS}=require('./source-pack.cjs');
const {hash}=require('./smoke-bundle');
const {PROFILE,TRAFFIC_FILES}=require('./external-contract.cjs');
const SOURCE='tools/mt-bench/external-generator';
const SOURCE_FILES=['app.py','generator.py','protocol.py','traffic_probe.py','recovery.cjs'];
const PAYLOAD=['external-contract.cjs','external-runner.mjs','external-setup.py','remote-external-app.sh','remote-external-generator.sh'];
function baseSpec(spec){return {...spec,profile:'joined-pilot-v1',generatorNodes:0,tenants:1000,capacityLevels:[500,750,1000]};}
function extensionIdentity(files){
  const ordered=Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)));
  // Match the source descriptor's explicit Python canonical mapping format.
  const encoded='{'+Object.entries(ordered).map(([key,value])=>JSON.stringify(key)+': '+JSON.stringify(value)).join(', ')+'}';
  return {version:1,profile:PROFILE,files:ordered,trafficFiles:TRAFFIC_FILES,sha256:crypto.createHash('sha256').update(encoded).digest('hex')};
}
function checkSourceDescriptor(value,expected){if(!isDeepStrictEqual(value,expected))throw Error('EXTERNAL_SOURCE_INTERFACE_MISMATCH');return value;}
async function sourceIdentity(alignment,commit){
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'external-source-'));
  try{
    const hashes={};for(const name of SOURCE_FILES){const raw=(await command('git',['-C',alignment,'show',commit+':'+SOURCE+'/'+name])).stdout;hashes[name]=crypto.createHash('sha256').update(raw).digest('hex');await fs.writeFile(path.join(temporary,name),raw,{mode:0o600});}
    const expected=extensionIdentity(hashes);
    const script="import sys,json;sys.path.insert(0,sys.argv[1]);from protocol import source_identity;print(json.dumps(source_identity(sys.argv[1]),sort_keys=True))";
    const actual=JSON.parse((await command('python3',['-I','-B','-c',script,temporary])).stdout);
    return checkSourceDescriptor(actual,expected);
  }finally{await fs.rm(temporary,{recursive:true,force:true});}
}
async function buildExternalBundle(options){
  const {spec,directory,alignment}=options;
  validate(spec);if(spec.profile!==PROFILE)throw Error('EXTERNAL_PROFILE_REQUIRED');
  // This admission qualifies the unchanged application image/base instrument.
  // It is not a claim that the new cross-host transport has been exercised.
  const extension=await sourceIdentity(alignment,spec.alignmentCommit);
  const repo=path.resolve(__dirname,'../..');
  const tracked=[...PAYLOAD,'external-bundle.cjs','prepare-external-generator.js'].map(name=>'tools/perf-cloud/'+name);
  if((await command('git',['-C',repo,'status','--porcelain','--',...tracked])).stdout.trim())throw Error('EXTERNAL_TRANSPORT_NOT_COMMITTED');
  await buildPilotBundle({...options,spec:baseSpec(spec)});
  // Extend the same pinned Git tree pack. Never copy a dirty source checkout.
  await sparsePack(alignment,spec.alignmentCommit,path.join(directory,'alignment.pack'),[...PATHS,'tools/queue/gates/m7_joined_receipt.py',SOURCE]);
  const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json')));
  manifest.profile=PROFILE;manifest.externalQualification='REQUIRES_REVIEWED_LIVE_SMOKE';
  manifest.files['alignment.pack']=await hash(path.join(directory,'alignment.pack'));
  await fs.writeFile(path.join(directory,'external-source.json'),JSON.stringify(extension,null,2)+'\n',{mode:0o600});manifest.files['external-source.json']=await hash(path.join(directory,'external-source.json'));
  for(const name of PAYLOAD){await fs.copyFile(path.join(__dirname,name),path.join(directory,name));manifest.files[name]=await hash(path.join(directory,name));}
  for(const stage of ['deploy','campaign','collect']){const name=stage+'.mjs';await fs.writeFile(path.join(directory,name),`import {run} from './external-runner.mjs';\nawait run('${stage}');\n`,{mode:0o600});manifest.files[name]=await hash(path.join(directory,name));}
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  const bundleSha256=await hash(path.join(directory,'manifest.json'));await checkBundle(directory,bundleSha256);
  return {directory,bundleSha256,externalSource:extension,scope:'new external-generator transport; no capacity qualification'};
}
module.exports={PROFILE,SOURCE,SOURCE_FILES,TRAFFIC_FILES,PAYLOAD,checkSourceDescriptor,baseSpec,extensionIdentity,sourceIdentity,buildExternalBundle};
