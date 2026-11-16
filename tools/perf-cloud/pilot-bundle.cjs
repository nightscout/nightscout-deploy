'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {constants}=require('node:fs');
const {validate}=require('./spec');
const {command,checkBundle}=require('./drivers');
const {exportPack,hash}=require('./smoke-bundle');
const {sparsePack,PATHS}=require('./source-pack.cjs');
const {instrumentIdentity}=require('./joined-bundle.cjs');
const {acceptance,counts}=require('./joined-preflight.cjs');
const {isDeepStrictEqual}=require('node:util');
const CAPABILITY={"version":4,"kind":"m7-joined-profile-capabilities","settingsFingerprint":{"schema":1,"source":"pinned-core-defaults-and-actual-blank-registry-primer","observation":"existing-k6-r_status","missing":"UNMEASURED","invalidOrMismatch":"functional-FAIL","extraHttp":false},"diagnostics":{"default":"off","choices":["off","on"],"intervalDefaultMs":5000,"intervalMinMs":1000,"intervalMaxMs":60000,"environmentWhitelist":["NS_M7_DIAGNOSTICS","NS_M7_DIAGNOSTICS_INTERVAL_MS"]},"profileComparison":{"field":"profileSelection","hashField":"profileSelection.sha256","sameAcrossPilotAndApiScaling":true},"topology":{"binding":"registry-default","secretsBackend":"vault-server","vaultAgentOverlay":false},"privateRoleLogs":{"secondsPerRole":5,"perRoleBytes":65536,"globalBytes":524288,"truncationExplicit":true},"loadGeneratorMetrics":{"separateFromServingRoles":true,"missingRss":"UNMEASURED"},"capacity":"UNMEASURED; capability is not a campaign receipt","evaluatorProgress":{"version":2,"moduleVersion":2,"selectorRows":128,"maxTenants":10000,"maxInstances":4,"roundsPerPhase":3,"maxQueriesPerPhase":1024,"maxBytesPerPhase":67108864,"responseMaxBytes":1048576,"rpcTimeoutMs":5000,"roundDeadlineMs":15000,"idleWitness":"successful-time-only-completion","loadWitness":"successful-work-progression","recoveryCadenceMs":15000,"recoveryTimeoutMs":900000,"recoveryMaxRounds":60,"readinessMaxQueries":25600,"readinessMaxBytes":268435456,"readinessMaxRounds":80,"deadlineClaim":false,"workloadCohortChanged":false,"dueState":"captured-only-not-opportunity-assessed"},"evaluatorIdleSafety":{"version":1,"kind":"evaluator-idle-safety","moduleVersion":2,"strictWorkPolicy":{"version":2,"moduleVersion":2,"selectorRows":128,"maxTenants":10000,"maxInstances":4,"roundsPerPhase":3,"maxQueriesPerPhase":1024,"maxBytesPerPhase":67108864,"responseMaxBytes":1048576,"rpcTimeoutMs":5000,"roundDeadlineMs":15000,"idleWitness":"successful-time-only-completion","loadWitness":"successful-work-progression","recoveryCadenceMs":15000,"recoveryTimeoutMs":900000,"recoveryMaxRounds":60,"readinessMaxQueries":25600,"readinessMaxBytes":268435456,"readinessMaxRounds":80,"deadlineClaim":false,"workloadCohortChanged":false,"dueState":"captured-only-not-opportunity-assessed"},"meaning":"NO_EVALUATOR_TIME_DEMAND or observed successful time work","quietMeaning":"TIME_NOT_EXERCISED","clockGuard":"common-bracketed-realtime-minus-monotonic-offset","jobEncoding":"six-fixed-clinical-flags-bitmask-v1","newClinicalDemand":"UNMEASURED","explicitNullDue":"NO_TIMER_DECLARED_WITH_COMPLETE_JOB_OBSERVATION","missingDue":"UNMEASURED","nativeTimeWitnessRequired":true,"deadlineClaim":false,"continuousQuiescenceClaim":false}};
const MEASUREMENT_CAPABILITY={version:1,kind:'m7-unaccepted-measurement-admission',receiptKind:'joined-measurement-authorization',receiptStatus:'AUTHORIZED_UNACCEPTED_MEASUREMENT',measurementMode:'unaccepted',profile:'remote-pilot',limits:{tenantCounts:[500,750,1000],apiReplicas:1,realtimeReplicas:1,evaluatorReplicas:1,maximumRunMinutes:180},diagnostics:'off',diagnosticsIntervalMs:5000,functionalAcceptance:'UNACCEPTED',functionalAcceptanceAtAuthorization:'PENDING',capacityAcceptance:'NOT_GRANTED',cellKind:'m7-joined-unaccepted-measurement-cell',aggregateKind:'m7-joined-unaccepted-measurement',acceptedClaims:false};
const K6='grafana/k6@sha256:3ddc8b1a33a2c3d8edc6e99b6a762ae36cba08788463458f5e6a7703e14eb77d';
const GATE='tools/queue/gates/m7_joined_receipt.py';
const PAYLOAD=['pilot-docker-store.py','pilot-native-witness.py','remote-pilot.sh','pilot-ledger.py','smoke-runner.mjs','joined-prerequisites.cjs','joined-capture.py'];
const GUARDED=[...PAYLOAD,'pilot-bundle.cjs','prepare-pilot.js','spec.js','drivers.js','smoke-bundle.js','source-pack.cjs','joined-bundle.cjs','joined-preflight.cjs','fleet-budget.cjs','supervise.js'];
function pilotReceipt(receipt,evidence,spec){
  validate(spec);
  if(spec.profile!=='joined-pilot-v1'||spec.k6Image!==K6||spec.maxMinutes>180||spec.appImage!==`source:${spec.coreCommit}:${spec.deployCommit}`)throw new Error('PILOT_BOUNDED_FIXED_PROFILE_REQUIRED');
  if(!Buffer.isBuffer(evidence)||evidence.length>32*1024*1024)throw new Error('PILOT_RAW_ACCEPTANCE_EVIDENCE_REQUIRED');
  acceptance(receipt,evidence,{core:spec.coreCommit,deploy:spec.deployCommit});
}
function measurementReceipt(receipt,spec,identity){
  validate(spec);
  if(spec.profile!=='joined-baseline-diagnostic-v1'||spec.k6Image!==K6||spec.maxMinutes>180||spec.appImage!==`source:${spec.coreCommit}:${spec.deployCommit}`)throw new Error('UNACCEPTED_BASELINE_FIXED_PROFILE_REQUIRED');
  const expected={version:1,kind:'joined-measurement-authorization',status:'AUTHORIZED_UNACCEPTED_MEASUREMENT',pair:{core:spec.coreCommit,deploy:spec.deployCommit},instrument:receipt?.instrument,imageId:receipt?.imageId,runId:spec.runId,functionalAcceptanceAtAuthorization:'PENDING',purpose:'PRE_ACCEPTANCE_BASELINE_ONLY',limits:{tenantCounts:[500,750,1000],apiReplicas:1,realtimeReplicas:1,evaluatorReplicas:1,maximumRunMinutes:180}};
  if(!isDeepStrictEqual(receipt,expected)||!/^[a-f0-9]{64}$/.test(receipt.instrument||'')||!/^sha256:[a-f0-9]{64}$/.test(receipt.imageId||''))throw new Error('UNACCEPTED_MEASUREMENT_AUTHORIZATION_MISMATCH');
  if(identity&&(receipt.instrument!==identity.instrument||receipt.imageId!==identity.imageId))throw new Error('UNACCEPTED_MEASUREMENT_QUALIFICATION_MISMATCH');
}
function admission(receipt,evidence,spec,identity){
  if(spec.profile==='joined-baseline-diagnostic-v1'){
    if(evidence!==undefined)throw new Error('UNACCEPTED_MEASUREMENT_CANNOT_USE_ACCEPTANCE_EVIDENCE');
    measurementReceipt(receipt,spec,identity);
  }else pilotReceipt(receipt,evidence,spec);
}
async function pilotCapability({alignment,commit}){
  if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('PILOT_CAPABILITY_SOURCE_PIN_REQUIRED');
  let value;try{value=JSON.parse((await command('git',['-C',alignment,'show',commit+':tools/mt-bench/m7-joined/capabilities.json'])).stdout);}catch{throw new Error('PILOT_SETTINGS_FINGERPRINT_CAPABILITY_REQUIRED');}
  if(!isDeepStrictEqual(value,CAPABILITY))throw new Error('PILOT_SOURCE_CAPABILITY_UNSUPPORTED');
  return value;
}
async function measurementCapability({alignment,commit,spec,receipt,instrument}){
  if(spec.profile!=='joined-baseline-diagnostic-v1')return undefined;
  instrument=instrument||await instrumentIdentity(alignment,commit);
  measurementReceipt(receipt,spec,{instrument:instrument.sha256,imageId:receipt.imageId});
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'pilot-measurement-source-'));
  try{
    for(const name of Object.keys(instrument.files)){
      const file=path.join(temporary,name);await fs.mkdir(path.dirname(file),{recursive:true});
      await fs.writeFile(file,(await command('git',['-C',alignment,'show',commit+':'+name])).stdout);
    }
    const source=path.join(temporary,'tools/mt-bench/m7-joined');
    let descriptor;try{descriptor=JSON.parse((await command('python3',['-I','-B',path.join(source,'adapter.py'),'measurement-capabilities'])).stdout);}catch{throw new Error('UNACCEPTED_SOURCE_ADMISSION_UNSUPPORTED');}
    if(!isDeepStrictEqual(descriptor,MEASUREMENT_CAPABILITY))throw new Error('UNACCEPTED_SOURCE_ADMISSION_DESCRIPTOR_CHANGED');
    const manifest={pair:receipt.pair,instrument:{sha256:instrument.sha256},profile:'remote-pilot',tenants:500,replicas:1,measurementMode:'unaccepted',runId:spec.runId,imageId:receipt.imageId,maximumRunMinutes:180,diagnostics:{mode:'off',intervalMs:5000,environment:{NS_M7_DIAGNOSTICS:'0',NS_M7_DIAGNOSTICS_INTERVAL_MS:'5000'}}};
    await fs.writeFile(path.join(temporary,'manifest.json'),JSON.stringify(manifest),{mode:0o600});await fs.writeFile(path.join(temporary,'authorization.json'),JSON.stringify(receipt),{mode:0o600});
    const probe="import sys,json;sys.path.insert(0,sys.argv[1]);from contract import receipt_scope;print(json.dumps(receipt_scope(json.load(open(sys.argv[2])),json.load(open(sys.argv[3])),'deploy')))";
    const scope=JSON.parse((await command('python3',['-I','-B','-c',probe,source,path.join(temporary,'manifest.json'),path.join(temporary,'authorization.json')])).stdout);
    if(!isDeepStrictEqual(scope,{kind:'unaccepted-measurement',measurementMode:'unaccepted',functionalAcceptance:'UNACCEPTED',functionalAcceptanceAtAuthorization:'PENDING',capacityAcceptance:'NOT_GRANTED'}))throw new Error('UNACCEPTED_SOURCE_ADMISSION_SCOPE_CHANGED');
    return descriptor;
  }finally{await fs.rm(temporary,{recursive:true,force:true});}
}
async function transportIdentity(spec){
  const repository=path.resolve(__dirname,'../..');
  const instrumentCommit=(await command('git',['-C',repository,'rev-parse','HEAD'])).stdout.trim();
  if(spec.instrumentCommit!==instrumentCommit)throw new Error('PILOT_TRANSPORT_INSTRUMENT_PIN_MISMATCH');
  const tracked=GUARDED.map(name=>'tools/perf-cloud/'+name);
  if((await command('git',['-C',repository,'status','--porcelain','--',...tracked])).stdout.trim())throw new Error('PILOT_TRANSPORT_NOT_COMMITTED');
  return instrumentCommit;
}
async function buildPilotBundle({directory,core,deploy,alignment,spec,receipt,evidence,expectation,expectationRaw,evidenceRoot,qualifiedImage,imageSha256}){
  admission(receipt,evidence,spec);
  if(!expectation?.nativeEvaluatorTimeWitness||!evidenceRoot)throw new Error('PILOT_NATIVE_EVALUATOR_TIME_WITNESS_REQUIRED');
  if(!qualifiedImage||!/^[a-f0-9]{64}$/.test(imageSha256||''))throw new Error('PILOT_QUALIFIED_IMAGE_ARCHIVE_REQUIRED');
  const imageStat=await fs.lstat(qualifiedImage);if(!imageStat.isFile()||imageStat.size===0)throw new Error('PILOT_QUALIFIED_IMAGE_ARCHIVE_REQUIRED');
  const instrumentCommit=await transportIdentity(spec);
  for(const [repo,pin]of [[core,spec.coreCommit],[deploy,spec.deployCommit],[alignment,spec.alignmentCommit]]){
    try{if((await command('git',['-C',repo,'rev-parse','--verify',pin+'^{commit}'])).stdout.trim()!==pin)throw new Error('pin mismatch');}catch{throw new Error('PILOT_SOURCE_PIN_UNAVAILABLE');}
  }
  const contract=(await command('git',['-C',alignment,'show',spec.alignmentCommit+':tools/mt-bench/m7-joined/contract.py'])).stdout;
  if(JSON.stringify(counts(contract,'PILOT_COUNTS'))!==JSON.stringify([500,750,1000]))throw new Error('PILOT_SOURCE_COUNT_CONTRACT_CHANGED');
  const capability=await pilotCapability({alignment,commit:spec.alignmentCommit});
  const instrument=await instrumentIdentity(alignment,spec.alignmentCommit);
  for(const name of ['evaluator_progress.py','evaluator_recovery.py','evaluator_idle.py','evaluator-progress.cjs','profile_provenance.py','probe.py','workload.py']){
    if(!instrument.files['tools/mt-bench/m7-joined/'+name])throw new Error('PILOT_PROGRESS_INSTRUMENT_MODULE_REQUIRED');
  }
  const nativeIdentity={pair:{core:spec.coreCommit,deploy:spec.deployCommit},imageId:expectation.nativeEvaluatorTimeWitness.attribution?.imageId,instrument:instrument.sha256};
  admission(receipt,evidence,spec,nativeIdentity);
  const measurementDescriptor=await measurementCapability({alignment,commit:spec.alignmentCommit,spec,receipt,instrument});
  const gateText=(await command('git',['-C',alignment,'show',spec.alignmentCommit+':'+GATE])).stdout;
  const gateDescription={commit:spec.alignmentCommit,path:GATE,bytes:Buffer.byteLength(gateText),sha256:crypto.createHash('sha256').update(gateText).digest('hex')};
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'pilot-native-check-'));
  let nativeRaw;
  try{
    await fs.writeFile(path.join(temporary,'expectation.json'),expectationRaw||JSON.stringify(expectation),{mode:0o600});
    for(const [name,value]of [['identity.json',nativeIdentity],['gate.json',gateDescription]])await fs.writeFile(path.join(temporary,name),JSON.stringify(value),{mode:0o600});
    for(const name of [GATE,'tools/mt-bench/m7-joined/evaluator_progress.py']){const file=path.join(temporary,'source',name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,(await command('git',['-C',alignment,'show',spec.alignmentCommit+':'+name])).stdout);}
    await command('python3',['-I','-B',path.join(__dirname,'pilot-native-witness.py'),'verify','--alignment',path.join(temporary,'source'),'--expected',path.join(temporary,'expectation.json'),'--identity',path.join(temporary,'identity.json'),'--gate-description',path.join(temporary,'gate.json'),'--evidence-root',path.resolve(evidenceRoot),'--copy-artifact',path.join(temporary,'native.bin'),'--record',path.join(temporary,'verified.json')]);
    nativeRaw=await fs.readFile(path.join(temporary,'native.bin'));
  }finally{await fs.rm(temporary,{recursive:true,force:true});}
  await fs.mkdir(directory,{mode:0o700});const files={};
  const imageFile='pilot-qualified-image.tar';await fs.copyFile(qualifiedImage,path.join(directory,imageFile),constants.COPYFILE_FICLONE);
  files[imageFile]=await hash(path.join(directory,imageFile));if(files[imageFile]!==imageSha256)throw new Error('PILOT_QUALIFIED_IMAGE_ARCHIVE_HASH');
  await fs.writeFile(path.join(directory,'pilot-native-artifact.bin'),nativeRaw,{mode:0o600});files['pilot-native-artifact.bin']=await hash(path.join(directory,'pilot-native-artifact.bin'));

  for(const [name,repo,pin]of [['core',core,spec.coreCommit],['deploy',deploy,spec.deployCommit]]){
    const file=name+'.pack';await exportPack(repo,pin,path.join(directory,file));files[file]=await hash(path.join(directory,file));
  }
  await sparsePack(alignment,spec.alignmentCommit,path.join(directory,'alignment.pack'),[...PATHS,GATE]);files['alignment.pack']=await hash(path.join(directory,'alignment.pack'));
  for(const [name,value]of [[spec.profile==='joined-baseline-diagnostic-v1'?'pilot-authorization.json':'pilot-acceptance.json',receipt],['pilot-instrument.json',instrument],['pilot-capabilities.json',capability],['pilot-native-expectation.json',expectation],['pilot-native-identity.json',nativeIdentity],['pilot-receipt-gate.json',gateDescription],['pilot-qualified-image.json',{kind:'qualified-pilot-image-archive-v1',file:'pilot-qualified-image.tar',sha256:imageSha256,...nativeIdentity}]]){
    await fs.writeFile(path.join(directory,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});files[name]=await hash(path.join(directory,name));
  }
  if(spec.profile==='joined-pilot-v1'){await fs.writeFile(path.join(directory,'pilot-acceptance-evidence.bin'),evidence,{mode:0o600});files['pilot-acceptance-evidence.bin']=await hash(path.join(directory,'pilot-acceptance-evidence.bin'));}
  if(measurementDescriptor){await fs.writeFile(path.join(directory,'pilot-measurement-capabilities.json'),JSON.stringify(measurementDescriptor,null,2)+'\n',{mode:0o600});files['pilot-measurement-capabilities.json']=await hash(path.join(directory,'pilot-measurement-capabilities.json'));}
  for(const name of PAYLOAD){await fs.copyFile(path.join(__dirname,name),path.join(directory,name));files[name]=await hash(path.join(directory,name));}
  for(const stage of ['deploy','campaign','collect']){
    const name=stage+'.mjs';await fs.writeFile(path.join(directory,name),`import {run} from './smoke-runner.mjs';\nawait run('${stage}');\n`,{mode:0o600});files[name]=await hash(path.join(directory,name));
  }
  // The collector and small metadata precede potentially long archive transfers.
  const ordered=Object.fromEntries([...new Set(['remote-pilot.sh',...PAYLOAD,...Object.keys(files).filter(name=>!name.endsWith('.pack')&&name!==imageFile),...Object.keys(files).filter(name=>name.endsWith('.pack')),imageFile])].map(name=>[name,files[name]]));
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({version:1,adapter:'controller-bundle-v1',profile:spec.profile,instrumentCommit,files:ordered},null,2)+'\n',{mode:0o600});
  const bundleSha256=await hash(path.join(directory,'manifest.json'));await checkBundle(directory,bundleSha256);return {directory,bundleSha256};
}
module.exports={CAPABILITY,MEASUREMENT_CAPABILITY,measurementCapability,GATE,K6,PAYLOAD,GUARDED,pilotReceipt,measurementReceipt,admission,pilotCapability,transportIdentity,buildPilotBundle};
