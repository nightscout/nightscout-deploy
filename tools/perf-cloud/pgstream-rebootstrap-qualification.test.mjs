import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {rebootstrapQualification} from './pgstream-calibration.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
test('actual canonical producer schema binds bytes, labels, build capture and exact absence without invented returncodes',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pgcal-rebootstrap-'));try{
  const pins={core:'a'.repeat(40),deploy:'b'.repeat(40),app:'sha256:'+'c'.repeat(64)};
  const d={version:1,profile:'external-service-v1',files:{'tools/mt-bench/m7-joined/stream_topology.py':'d'.repeat(64),'tools/mt-bench/m7-joined/diagnostic_resources.py':'e'.repeat(64)}};
  const s={reportMode:'discovery',pins,pgstreamTopology:'external-service-v1',diagnosticResourceProfile:'local-diagnostic-external-pgstream-4cpu-8g-v1',helperDependencies:d,receipt:{remotePgstreamTopology:'external-service-v1',remoteDiagnosticResourceProfile:'local-diagnostic-external-pgstream-4cpu-8g-v1',remoteHelperDependencies:d}};
  const write=async(name,value)=>{const bytes=typeof value==='string'?value:JSON.stringify(value);const file=path.join(dir,name);await fs.writeFile(file,bytes);return {path:file,sha256:sha(bytes)};};
  const bytes={mismatches:[],sourceFiles:1,binding:{coreCommit:pins.core,deployCommit:pins.deploy},node:'v24.22.1'};
  const q={manifest:await write('manifest.json',{core:pins.core,deploy:pins.deploy,files:{'/synthetic/source.js':'f'.repeat(64)}}),buildLog:await write('build.log','Successfully built '+pins.app.slice(7,19)+'\nSuccessfully tagged synthetic:fixed\n'),byteCheck:await write('bytes.json',bytes),inspection:await write('labels.json',{imageId:pins.app,sourceLabel:pins.core,deployLabel:pins.deploy})};
  const receipt={status:'PASS',basis:'reproduced',core:pins.core,deploy:pins.deploy,imageId:pins.app,tag:'synthetic:fixed',qualifierAbsent:true,builderReferencesAbsent:['d'.repeat(12)],sourceByteCheck:bytes,manifestSha256:q.manifest.sha256,buildLogSha256:q.buildLog.sha256};Object.assign(q,await write('qualification.json',receipt));
  const result=await rebootstrapQualification(s,q);assert.equal(result.buildReturncode,'UNMEASURED');assert.equal(result.capacityAcceptance,'NOT_GRANTED');
  for(const change of [r=>r.core='0'.repeat(40),r=>r.qualifierAbsent=false,r=>r.sourceByteCheck.mismatches=['/synthetic/source.js'],r=>r.sourceByteCheck.sourceFiles=2,r=>r.manifestSha256='0'.repeat(64),r=>r.builderReferencesAbsent=[]]){
   const bad=structuredClone(receipt);change(bad);const wrong={...q,...await write('bad.json',bad)};await assert.rejects(rebootstrapQualification(s,wrong),/PGCAL_REBOOTSTRAP_/);
  }
  await fs.writeFile(q.inspection.path,JSON.stringify({imageId:pins.app,sourceLabel:'0'.repeat(40),deployLabel:pins.deploy}));await assert.rejects(rebootstrapQualification(s,q),/PROOF_HASH/);q.inspection=await write('labels.json',{imageId:pins.app,sourceLabel:'0'.repeat(40),deployLabel:pins.deploy});await assert.rejects(rebootstrapQualification(s,q),/IMAGE_LABELS/);q.inspection=await write('labels.json',{imageId:pins.app,sourceLabel:pins.core,deployLabel:pins.deploy});await rebootstrapQualification(s,q);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
