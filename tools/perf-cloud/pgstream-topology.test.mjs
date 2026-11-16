import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {runtimeBinding} from './pgstream-caller.mjs';
import {PINS,CADENCE,PROFILE,HELPER_FILES,hashFile,packet,validate,topologyBinding} from './pgstream-calibration.mjs';
const sha=text=>createHash('sha256').update(text).digest('hex');
function spec(){const t={interface:'ens7',mac:'02:00:00:00:00:01',approvedAddress:'10.8.0.2',approvalReference:'synthetic-root-approved'};const host=(id,ip,pub,key)=>({providerId:id,privateIPv4:ip,publicIPv4:pub,sshHostKeySha256:sha(key),cpuCores:4,ramBytes:8000000000,networkBitsPerSecond:1000000000,allocationSource:'provider-inventory',headroom:{measurement:'UNMEASURED'}});return {profile:PROFILE,completionContract:'evaluator-work-v2',diagnostics:'on',tenants:1000,logicalPollingClients:2000,pins:PINS,cadence:CADENCE,extensionSha256:'a'.repeat(64),helperCommit:'b'.repeat(40),transport:t,port:18080,controllerIPv4:'192.0.2.1',runId:'remote-test',cloudId:'remote-test-'+'a'.repeat(12),nonce:'b'.repeat(32),paidT0:1000,lastNewPointAt:2800,expiresAt:4600,k6Image:'grafana/k6@sha256:'+'f'.repeat(64),budget:{rootOwned:true,totalUsd:6},hosts:{sut:host('synthetic-sut','10.8.0.2','192.0.2.2','sut-key'),driver:host('synthetic-driver','10.8.0.3','192.0.2.3','driver-key')},receipt:{completionContract:'evaluator-work-v2',kind:'joined-diagnostic',status:'AUTHORIZED_DIAGNOSTIC',functionalAcceptanceAtAuthorization:'PENDING',imageId:PINS.app,pair:{core:PINS.core,deploy:PINS.deploy},instrument:'c'.repeat(64),limits:{tenants:1000,apiReplicas:1,trafficSeconds:310},remoteProfile:PROFILE,remoteExtensionSha256:'a'.repeat(64),remoteTransport:t},sutInbound:[{protocol:'tcp',port:22,sourceIPv4:'192.0.2.1'},{protocol:'tcp',port:18080,sourceIPv4:'10.8.0.3',sourceProviderId:'synthetic-driver'}],driverLimits:{fdSoft:65536,fdHard:65536,k6PreallocatedVUsFormula:'min(400,ceil(rate/300)*2+5)',k6MaxVUsPerScenario:800,measurement:'UNMEASURED'},pgstreamProducer:'canonical-262-with-pool-initialize',providerTokenOnHosts:false};}

function selected(){const s=spec();s.reportMode='discovery';s.receipt.remoteReportMode='discovery';s.sourceQualification={path:'/synthetic/qualification.json',sha256:'e'.repeat(64)};s.resourcePlan={reference:'synthetic-topology',tenants:s.tenants,logicalPollingClients:s.logicalPollingClients,hosts:Object.fromEntries(Object.entries(s.hosts).map(([k,h])=>[k,{providerId:h.providerId,cpuCores:h.cpuCores,ramBytes:h.ramBytes}]))};s.receipt.remoteWorkload={cadence:s.cadence,primerConcurrency:1,resourcePlan:s.resourcePlan};s.pgstreamTopology='external-service-v1';s.diagnosticResourceProfile='local-diagnostic-external-pgstream-4cpu-8g-v1';s.receipt.remotePgstreamTopology=s.pgstreamTopology;s.receipt.remoteDiagnosticResourceProfile=s.diagnosticResourceProfile;s.helperDependencies={version:1,profile:'external-service-v1',files:{'tools/mt-bench/m7-joined/stream_topology.py':'a'.repeat(64),'tools/mt-bench/m7-joined/diagnostic_resources.py':'b'.repeat(64)}};s.receipt.remoteHelperDependencies=s.helperDependencies;return s;}
test('explicit source topology and finite profile bind through caller and receipt',()=>{const s=selected();validate(s);assert.deepEqual(topologyBinding(s),{pgstreamTopology:s.pgstreamTopology,diagnosticResourceProfile:s.diagnosticResourceProfile});assert.equal(runtimeBinding(s).pgstreamTopology,s.pgstreamTopology);assert.equal(runtimeBinding(s).diagnosticResourceProfile,s.diagnosticResourceProfile);
for(const change of [s=>delete s.pgstreamTopology,s=>delete s.diagnosticResourceProfile,s=>s.pgstreamTopology='colocated-v1',s=>delete s.receipt.remotePgstreamTopology,s=>delete s.receipt.remoteDiagnosticResourceProfile,s=>delete s.helperDependencies,s=>delete s.helperDependencies.files['tools/mt-bench/m7-joined/stream_topology.py']]){const b=structuredClone(s);change(b);assert.throws(()=>validate(b));}
assert.equal(runtimeBinding(spec()).pgstreamTopology,undefined);
});
test('source-specific dependency allowlist includes exact shared files and refuses omission/tamper',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'pgcal-topology-'));try{
 const s=selected(),dir=path.join(root,'tools/mt-bench/remote-pgstream');await fs.mkdir(dir,{recursive:true});const hashes={};for(const n of [...HELPER_FILES].sort()){await fs.writeFile(path.join(dir,n),'synthetic');hashes[n]=sha('synthetic');}const canonical='{'+Object.keys(hashes).map(k=>JSON.stringify(k)+': '+JSON.stringify(hashes[k])).join(', ')+'}';s.extensionSha256=sha(canonical);s.receipt.remoteExtensionSha256=s.extensionSha256;
 for(const n of Object.keys(s.helperDependencies.files)){await fs.mkdir(path.dirname(path.join(root,n)),{recursive:true});await fs.writeFile(path.join(root,n),'# synthetic module');s.helperDependencies.files[n]=sha('# synthetic module');}
 const q={status:'CANONICAL_BUILD_AND_QUALIFICATION_PASS_NO_RUNTIME',core:s.pins.core,deploy:s.pins.deploy,imageId:s.pins.app,buildReturncode:0,checkImageReturncode:0,imageInspection:{mismatches:[],sourceLabel:s.pins.core,deployLabel:s.pins.deploy}};s.sourceQualification.path=path.join(root,'qualification.json');await fs.writeFile(s.sourceQualification.path,JSON.stringify(q));s.sourceQualification.sha256=await hashFile(s.sourceQualification.path);
 const archives={};for(const n of ['app','postgres']){const file=path.join(root,n+'.tar');await fs.writeFile(file,'synthetic');archives[n]={path:file,sha256:sha('synthetic'),imageId:s.pins[n]};}
 assert.equal((await packet(s,root,archives)).status,'OFFLINE_PACKET_VALIDATED');const topology=path.join(root,'tools/mt-bench/m7-joined/stream_topology.py');await fs.unlink(topology);await assert.rejects(packet(s,root,archives),/ENOENT/);await fs.writeFile(topology,'tamper');await assert.rejects(packet(s,root,archives),/DEPENDENCY_BYTES/);await fs.writeFile(topology,'# synthetic module');assert.equal((await packet(s,root,archives)).status,'OFFLINE_PACKET_VALIDATED');
 const resource=path.join(root,'tools/mt-bench/m7-joined/diagnostic_resources.py');await fs.writeFile(resource,'from experiment_batch import child_lock\n');s.helperDependencies.files['tools/mt-bench/m7-joined/diagnostic_resources.py']=await hashFile(resource);await assert.rejects(packet(s,root,archives),/DEPENDENCY_PROFILE/);
 s.helperDependencies.profile='external-service-batch-v1';const batchFile='tools/mt-bench/m7-joined/experiment_batch.py';s.helperDependencies.files[batchFile]=sha('# batch');await assert.rejects(packet(s,root,archives),/ENOENT/);await fs.writeFile(path.join(root,batchFile),'# batch');assert.equal((await packet(s,root,archives)).status,'OFFLINE_PACKET_VALIDATED');
 // Genuine new qualification has its own schema, never a fabricated old receipt.
 const newer={status:'CANONICAL_INTERMEDIATE_BUILD_LABEL_CHECK_AND_BUILDER_ABSENCE_PASS',source:s.pins.core,deploy:s.pins.deploy,imageId:s.pins.app,buildReturncode:0,imageLabelMismatches:[],builderReferencesAbsent:['synthetic-builder'],sourceProcessSameBirthPresent:false,runtime:'NOT_RUN',capacityAcceptance:'NOT_GRANTED'};const check=path.join(root,'check.json');await fs.writeFile(check,JSON.stringify({returncode:0,source:s.pins.core,deploy:s.pins.deploy,image:s.pins.app,runtime:'NOT_RUN'}));await fs.writeFile(s.sourceQualification.path,JSON.stringify(newer));s.sourceQualification.sha256=await hashFile(s.sourceQualification.path);s.sourceQualification.check={path:check,sha256:await hashFile(check)};assert.equal((await packet(s,root,archives)).status,'OFFLINE_PACKET_VALIDATED');await fs.appendFile(check,' ');await assert.rejects(packet(s,root,archives),/CHECK_HASH/);
}finally{await fs.rm(root,{recursive:true,force:true});}});

function actualDependencyProfile(){
 const profile=process.env.PGCAL_TOPOLOGY_DEPENDENCY_PROFILE??'external-service-v1';
 assert(['external-service-v1','external-service-batch-v1'].includes(profile),'explicit supported dependency profile required');
 return profile;
}
test('actual pinned helper sparse source carries the new shared topology module',async t=>{
 const helper=process.env.PGCAL_TOPOLOGY_HELPER;if(!helper)return t.skip('set PGCAL_TOPOLOGY_HELPER to an immutable source worktree');
 const {createRequire}=await import('node:module'),require=createRequire(import.meta.url),{sparsePack,PATHS}=require('./source-pack.cjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pgcal-topology-pack-'));
 const git=(args,opt={})=>{const r=spawnSync('git',args,{encoding:'utf8',...opt});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 try{const head=git(['-C',helper,'rev-parse','HEAD']),file=path.join(root,'alignment.pack');await sparsePack(helper,head,file,[...PATHS,'tools/mt-bench/remote-pgstream']);const repo=path.join(root,'repo');git(['init','--bare','-q',repo]);git(['-C',repo,'index-pack','--stdin'],{input:await fs.readFile(file)});
 for(const name of ['stream_topology.py','diagnostic_resources.py',...(actualDependencyProfile()==='external-service-batch-v1'?['experiment_batch.py']:[])])assert(git(['-C',repo,'show',head+':tools/mt-bench/m7-joined/'+name]).length>0);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('actual intermediate qualification and check retain exact tuple before export',async t=>{
 const helper=process.env.PGCAL_TOPOLOGY_HELPER,qualification=process.env.PGCAL_INTERMEDIATE_QUALIFICATION,check=process.env.PGCAL_INTERMEDIATE_CHECK;
 if(!helper||!qualification||!check)return t.skip('set exact immutable helper and intermediate qualification/check records');
 const actual=JSON.parse(await fs.readFile(qualification)),s=selected();s.pins={...s.pins,core:actual.source,deploy:actual.deploy,app:actual.imageId};s.receipt.pair={core:actual.source,deploy:actual.deploy};s.receipt.imageId=actual.imageId;s.sourceQualification={path:qualification,sha256:await hashFile(qualification),check:{path:check,sha256:await hashFile(check)}};
 const hashes={};for(const n of [...HELPER_FILES].sort())hashes[n]=await hashFile(path.join(helper,'tools/mt-bench/remote-pgstream',n));const canonical='{'+Object.keys(hashes).map(k=>JSON.stringify(k)+': '+JSON.stringify(hashes[k])).join(', ')+'}';s.extensionSha256=sha(canonical);s.receipt.remoteExtensionSha256=s.extensionSha256;
 s.helperDependencies.profile=actualDependencyProfile();
 if(s.helperDependencies.profile==='external-service-batch-v1')s.helperDependencies.files['tools/mt-bench/m7-joined/experiment_batch.py']='0'.repeat(64);
 for(const n of Object.keys(s.helperDependencies.files))s.helperDependencies.files[n]=await hashFile(path.join(helper,n));
 const archives={app:{status:'PENDING_EXPORT'},postgres:{status:'PENDING_EXPORT'}};
 await assert.rejects(packet(s,helper,archives),/PENDING_EXPORT_EXECUTION_REFUSED/);
 if(s.helperDependencies.profile==='external-service-batch-v1'){
  const omitted=structuredClone(s);omitted.helperDependencies.profile='external-service-v1';delete omitted.helperDependencies.files['tools/mt-bench/m7-joined/experiment_batch.py'];omitted.receipt.remoteHelperDependencies=omitted.helperDependencies;
  await assert.rejects(packet(omitted,helper,archives),/DEPENDENCY_PROFILE/);
 }
 const changed=structuredClone(s);changed.pins.core='f'.repeat(40);changed.receipt.pair.core=changed.pins.core;await assert.rejects(packet(changed,helper,archives),/INTERMEDIATE_IMAGE_QUALIFICATION/);
});
