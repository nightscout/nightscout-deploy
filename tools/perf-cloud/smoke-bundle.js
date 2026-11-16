'use strict';
// Export committed objects only, without history or compression work on the controller.
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {createReadStream,createWriteStream}=require('node:fs');
const crypto=require('node:crypto');
const {command,checkBundle}=require('./drivers');
const {validate}=require('./spec');
async function hash(file) {const h=crypto.createHash('sha256');for await(const c of createReadStream(file))h.update(c);return h.digest('hex');}
async function exportPack(repo,commit,file) {
  await command('git',['-C',repo,'cat-file','-e',commit+'^{commit}']);
  const objects=(await command('git',['-C',repo,'rev-list','--objects','--no-object-names',commit+'^{tree}'])).stdout;
  await new Promise((resolve,reject)=>{
    const out=createWriteStream(file,{mode:0o600});let written=false,exited=false;
    const done=()=>{if(written && exited)resolve();};out.on('finish',()=>{written=true;done();});
    const p=spawn('nice',['-n','19','git','-C',repo,'pack-objects','--compression=0','--threads=1','--stdout'],{stdio:['pipe','pipe','pipe']});
    let error='';p.stderr.on('data',c=>error+=c);p.on('error',reject);out.on('error',reject);
    p.stdout.pipe(out);p.stdin.end(commit+'\n'+objects);
    p.on('close',code=>{if(code!==0)reject(new Error('SOURCE_EXPORT_FAILED '+error));else {exited=true;done();}});
  });
}
async function buildWorkloadBundle({directory,core,deploy,alignment,spec},capacity=false) {
  validate(spec);
  if(spec.topology!=='colocated' || spec.appNodes!==1 || spec.generatorNodes!==0 || (!capacity && spec.tenants>100) ||
     spec.credentialProfile!=='legacy' || spec.seed!==42 || spec.historyHours!==24 || spec.hotFactor!==1 || spec.acceleration!==1 || !spec.httpEnabled || spec.recoveryTest!=='role-restart' || spec.socketsPerTenant<1)
    throw new Error('SMOKE_SUPPORTS_SMALL_COLOCATED_REFERENCE_PROFILE_ONLY');
  if(capacity && (spec.profile!=='colocated-capacity-v1' || spec.socketsPerTenant!==2 || spec.warmSeconds!==600 || spec.loadSeconds!==900))throw new Error('CAPACITY_REQUIRES_REFERENCE_WORKLOAD');
  await fs.mkdir(directory,{mode:0o700});
  const files={};
  for(const [name,repo,commit] of [['core',core,spec.coreCommit],['deploy',deploy,spec.deployCommit]]) {
    await exportPack(repo,commit,path.join(directory,name+'.pack'));files[name+'.pack']=await hash(path.join(directory,name+'.pack'));
  }
  await command('git',['-C',alignment,'archive','--format=tar','--output',path.join(directory,'alignment.tar'),spec.alignmentCommit,'tools/mt-bench/capacity','tools/mt-bench/compose-baseline']);
  files['alignment.tar']=await hash(path.join(directory,'alignment.tar'));
  for(const file of ['remote-smoke.sh','smoke-runner.mjs',...(capacity?['remote-capacity.sh','capacity-assess.cjs']:['smoke-assert.cjs'])]) {
    await fs.copyFile(path.join(__dirname,file),path.join(directory,file));files[file]=await hash(path.join(directory,file));
  }
  for(const stage of capacity?['deploy','campaign','collect']:['deploy','seed','warm','load','recovery','collect']) {
    const file=stage+'.mjs';
    await fs.writeFile(path.join(directory,file),`import {run} from './smoke-runner.mjs';\nawait run('${stage}');\n`,{mode:0o600});files[file]=await hash(path.join(directory,file));
  }
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({version:1,adapter:'controller-bundle-v1',profile:capacity?'colocated-capacity-v1':'colocated-smoke-v1',files},null,2)+'\n',{mode:0o600});
  const bundleSha256=await hash(path.join(directory,'manifest.json'));
  await checkBundle(directory,bundleSha256);
  return {directory,bundleSha256};
}
const buildSmokeBundle=options=>{if(options.spec.profile==='colocated-capacity-v1')throw new Error('CAPACITY_REQUIRES_CAPACITY_BUILDER');return buildWorkloadBundle(options);};
const buildCapacityBundle=options=>buildWorkloadBundle(options,true);
module.exports={buildSmokeBundle,buildCapacityBundle,exportPack,hash};
