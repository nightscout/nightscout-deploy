import test from 'node:test';
import assert from 'node:assert/strict';
import {PROFILE,PINS,CADENCE,validate,proposal,coordinateCalibration,PRIMER_PINS,REPAIRED_PINS,MINIMUM_PINS,PERFORMANCE_PINS,workloadBinding} from './pgstream-calibration.mjs';
const clone=x=>structuredClone(x);
function fixture(){const transport={interface:'ens7',mac:'02:00:00:00:00:01',approvedAddress:'10.8.0.2',approvalReference:'synthetic-control'};return {profile:PROFILE,completionContract:'evaluator-work-v2',diagnostics:'on',tenants:1000,logicalPollingClients:2000,cadence:CADENCE,pins:PINS,extensionSha256:'a'.repeat(64),helperCommit:'b'.repeat(40),transport,port:18080,controllerIPv4:'192.0.2.1',hosts:{sut:{providerId:'synthetic-app',privateIPv4:'10.8.0.2',cpuCores:16,ramBytes:64000000000,networkBitsPerSecond:1000000000,allocationSource:'provider-inventory',headroom:{measurement:'UNMEASURED'}},driver:{providerId:'synthetic-driver',privateIPv4:'10.8.0.3',cpuCores:2,ramBytes:4000000000,networkBitsPerSecond:1000000000,allocationSource:'provider-inventory',headroom:{measurement:'UNMEASURED'}}},receipt:{completionContract:'evaluator-work-v2',kind:'joined-diagnostic',status:'AUTHORIZED_DIAGNOSTIC',functionalAcceptanceAtAuthorization:'PENDING',imageId:PINS.app,pair:{core:PINS.core,deploy:PINS.deploy},instrument:'c'.repeat(64),limits:{tenants:1000,apiReplicas:1,trafficSeconds:310},remoteProfile:PROFILE,remoteExtensionSha256:'a'.repeat(64),remoteTransport:transport},sutInbound:[{protocol:'tcp',port:22,sourceIPv4:'192.0.2.1'},{protocol:'tcp',port:18080,sourceIPv4:'10.8.0.3',sourceProviderId:'synthetic-driver'}],driverLimits:{fdSoft:65536,fdHard:65536,k6PreallocatedVUsFormula:'min(400,ceil(rate/300)*2+5)',k6MaxVUsPerScenario:800,measurement:'UNMEASURED'},pgstreamProducer:'canonical-262-with-pool-initialize',providerTokenOnHosts:false};}
test('finite explicit profile and source/cadence/producer/receipt controls',()=>{validate(fixture());for(const edit of [s=>s.cadence.hotFactor=10,s=>s.pins.deploy='a'.repeat(40),s=>s.pgstreamProducer='pilot-ledger',s=>s.receipt.status='PASS',s=>s.receipt.remoteExtensionSha256='d'.repeat(64),s=>s.tenants=2000,s=>s.providerTokenOnHosts=true]){const s=clone(fixture());edit(s);assert.throws(()=>validate(s));}});
test('actual private host identity and exact generator-only firewall controls',()=>{for(const edit of [s=>s.hosts.sut.privateIPv4='0.0.0.0',s=>s.hosts.sut.privateIPv4='8.8.8.8',s=>s.hosts.sut.privateIPv4='10.8.0.9',s=>s.sutInbound[1].sourceIPv4='10.8.0.0/24',s=>s.sutInbound[1].sourceTag='shared-run',s=>s.sutInbound[1].sourceProviderId='wrong-driver',s=>s.sutInbound[1].port='1-65535',s=>s.sutInbound.push({protocol:'tcp',port:'all'})]){const s=clone(fixture());edit(s);assert.throws(()=>validate(s));}});
test('pending artifact proposal is explicit and has no invented archive SHA',()=>{const p=proposal('a'.repeat(64),'b'.repeat(40));assert.equal(p.artifacts.app.status,'PENDING_EXPORT');assert.equal(p.artifacts.app.sha256,null);assert.equal(p.liveQualification,'UNMEASURED');assert.equal(p.capacityAcceptance,'NOT_GRANTED');});
test('no-restart coordinator does not request restart and preserves transfer-before-finish',async()=>{const events=[];const app={next:async k=>{events.push('app:'+k);return k==='cell-complete'?{verdict:'PASS'}:k==='server-recovery-complete'?{measurement:'NOT_RUN'}:{};},send:k=>events.push('app-send:'+k),finish:async()=>events.push('app-finish')};const gen={next:async k=>{events.push('gen:'+k);return {primed:2000};},send:k=>events.push('gen-send:'+k),finish:async()=>events.push('gen-finish')};await coordinateCalibration(app,async()=>gen,async()=>events.push('transfer'));assert(events.indexOf('transfer')<events.indexOf('app-send:finish'));assert(events.every(e=>!e.includes('restart')));});
test('source byte changes and pending archives fail the executable packet check',async()=>{
  const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),crypto=await import('node:crypto');
  const {packet,HELPER_FILES}=await import('./pgstream-calibration.mjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pgcal-control-'));try{
    const directory=path.join(root,'tools/mt-bench/remote-pgstream');await fs.mkdir(directory,{recursive:true});
    const hashes={};for(const name of [...HELPER_FILES].sort()){await fs.writeFile(path.join(directory,name),'synthetic-control\n');hashes[name]=crypto.createHash('sha256').update('synthetic-control\n').digest('hex');}
    const canonical='{'+Object.keys(hashes).map(k=>JSON.stringify(k)+': '+JSON.stringify(hashes[k])).join(', ')+'}';
    const s=clone(fixture());s.extensionSha256=crypto.createHash('sha256').update(canonical).digest('hex');s.receipt.remoteExtensionSha256=s.extensionSha256;
    const archives={app:{status:'PENDING_EXPORT'},postgres:{status:'PENDING_EXPORT'}};
    await assert.rejects(packet(s,root,archives),/PENDING_EXPORT_EXECUTION_REFUSED/);
    await fs.appendFile(path.join(directory,'transport.py'),'deliberate-source-change\n');
    await assert.rejects(packet(s,root,archives),/EXTENSION_HASH_CHANGED/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('provider bandwidth omission is explicit unknown and never green headroom',()=>{const s=structuredClone(fixture());for(const host of Object.values(s.hosts)){host.networkBitsPerSecond=null;host.networkAllocation={measurement:'UNMEASURED',reason:'providerAPI-no-bandwidthfield'};}validate(s);for(const edit of [s=>delete s.hosts.sut.networkAllocation,s=>s.hosts.sut.networkBitsPerSecond=0,s=>s.hosts.sut.networkAllocation.measurement='PASS',s=>s.hosts.sut.networkAllocation.reason='estimated',s=>s.hosts.sut.headroom.measurement='PASS']){const bad=structuredClone(s);edit(bad);assert.throws(()=>validate(bad),/RESOURCE_PROVENANCE/);}});
test('observed SSH FD limits differ from an explicit requested worker limit',()=>{const s=structuredClone(fixture());s.driverLimits.fdSoft=1024;s.driverLimits.fdHard=1048576;s.driverLimits.requestedWorkerFdSoft=65536;validate(s);s.driverLimits.requestedWorkerFdSoft=1048577;assert.throws(()=>validate(s),/DRIVER_LIMITS/);});

test('explicit small cell keeps clients and genuine receipt limits matched',()=>{
 const s=structuredClone(fixture());s.tenants=10;s.logicalPollingClients=20;s.receipt.limits.tenants=10;validate(s);
 for(const edit of [v=>v.tenants=11,v=>v.logicalPollingClients=2000,v=>v.receipt.limits.tenants=1000]){const b=structuredClone(s);edit(b);assert.throws(()=>validate(b));}validate(s);
});
test('actual load-start cutoff is checked after priming before any load message',async()=>{
 let sends=0;const app={next:async()=>({}),send:()=>{}},gen={next:async()=>({}),send:()=>sends++};
 await assert.rejects(coordinateCalibration(app,async()=>gen,async()=>{},()=>{throw Error('PGCAL_NEW_POINT_CUTOFF');}),/NEW_POINT_CUTOFF/);assert.equal(sends,0);
});

test('completion and diagnostic selection are explicit and receipt-bound',()=>{
 const good=structuredClone(fixture());validate(good);
 for(const edit of [v=>delete v.completionContract,v=>v.completionContract='evaluator-work-v1',v=>delete v.receipt.completionContract,v=>v.diagnostics='unknown']){const bad=structuredClone(good);edit(bad);assert.throws(()=>validate(bad),/OBSERVATION_CONTRACT/);}validate(good);
});

function parameterized({tenants=3000,rate=180,seconds=120,concurrency=1,primer=false}={}){
 const s=structuredClone(fixture());s.tenants=tenants;s.logicalPollingClients=tenants*2;
 s.cadence={...CADENCE,loadSeconds:seconds,offeredRps:rate};s.primerConcurrency=concurrency;s.driverLimits.k6PreallocatedVUsFormula='min(400,ceil(rate*1000/arrivalCycleMs)*2+5)';
 if(primer){s.pins=structuredClone(PRIMER_PINS);s.receipt.pair={core:s.pins.core,deploy:s.pins.deploy};s.receipt.imageId=s.pins.app;s.sourceQualification={path:'/synthetic/qualified-primer-receipt.json',sha256:'e'.repeat(64)};}
 s.resourcePlan={reference:'synthetic-file-only-plan',tenants,logicalPollingClients:tenants*2,hosts:Object.fromEntries(Object.entries(s.hosts).map(([role,h])=>[role,{providerId:h.providerId,cpuCores:h.cpuCores,ramBytes:h.ramBytes}]))};
 s.receipt.limits={tenants,apiReplicas:1,trafficSeconds:seconds};s.receipt.remoteWorkload=workloadBinding(s);return s;
}
function performance(){
 const s=parameterized({primer:true,tenants:1000,rate:180,seconds:310});
 s.pins=structuredClone(PERFORMANCE_PINS);s.receipt.pair={core:s.pins.core,deploy:s.pins.deploy};s.receipt.imageId=s.pins.app;return s;
}
test('performance discovery admits only the exact candidate and bounded ordinary1k workload',()=>{
 const s=performance();validate(s);
 for(const edit of [v=>v.pins.core=MINIMUM_PINS.core,v=>v.pins.deploy=MINIMUM_PINS.deploy,v=>v.pins.app=MINIMUM_PINS.app,v=>delete v.sourceQualification,v=>v.sourceQualification.sha256='unknown',v=>{v.completionContract='evaluator-work-v1';v.receipt.completionContract='evaluator-work-v1';},v=>v.tenants=3000,v=>v.cadence.offeredRps=240,v=>v.cadence.loadSeconds=600,v=>v.primerConcurrency=2,v=>v.cadence.restart=true,v=>delete v.resourcePlan,v=>v.receipt.pair.core=MINIMUM_PINS.core,v=>v.receipt.remoteWorkload.cadence.offeredRps=240,v=>v.sutInbound[1].sourceIPv4='10.8.0.0/24',v=>v.providerTokenOnHosts=true]){
  const bad=structuredClone(s);edit(bad);assert.throws(()=>validate(bad));
 }
 validate(s);
});
test('performance packet verifies build receipt and archive bytes without granting capacity',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),crypto=await import('node:crypto');
 const {packet,HELPER_FILES}=await import('./pgstream-calibration.mjs'),{runtimeBinding}=await import('./pgstream-caller.mjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pgcal-performance-')),hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
 try{
  const s=performance(),directory=path.join(root,'tools/mt-bench/remote-pgstream');await fs.mkdir(directory,{recursive:true});
  const hashes={};for(const name of [...HELPER_FILES].sort()){await fs.writeFile(path.join(directory,name),'synthetic');hashes[name]=hash('synthetic');}
  const canonical='{'+Object.keys(hashes).map(k=>JSON.stringify(k)+': '+JSON.stringify(hashes[k])).join(', ')+'}';s.extensionSha256=hash(canonical);s.receipt.remoteExtensionSha256=s.extensionSha256;
  s.sourceQualification.path=path.join(root,'qualification.json');
  const good={status:'CANONICAL_BUILD_AND_QUALIFICATION_PASS_NO_RUNTIME',core:s.pins.core,deploy:s.pins.deploy,imageId:s.pins.app,buildReturncode:0,imageInspection:{mismatches:[]}};
  async function qualify(value){const raw=JSON.stringify(value);await fs.writeFile(s.sourceQualification.path,raw);s.sourceQualification.sha256=hash(raw);}
  const archives={};for(const name of ['app','postgres']){const file=path.join(root,name+'.tar');await fs.writeFile(file,'synthetic-'+name);archives[name]={imageId:s.pins[name],path:file,sha256:hash('synthetic-'+name)};}
  await qualify(good);const result=await packet(s,root,archives);assert.equal(result.status,'OFFLINE_PACKET_VALIDATED');assert.equal(result.capacityAcceptance,'NOT_GRANTED');assert.equal(result.liveQualification,'UNMEASURED');
  const binding=runtimeBinding(s);assert.deepEqual(binding.pair,s.receipt.pair);assert.equal(binding.imageId,PERFORMANCE_PINS.app);assert.deepEqual(binding.workload,s.receipt.remoteWorkload);
  await fs.appendFile(s.sourceQualification.path,' ');await assert.rejects(packet(s,root,archives),/QUALIFICATION_HASH/);
  for(const bad of [{...good,status:'EXPERIMENTAL_CANONICAL_IMAGE_BUILT'},{...good,core:MINIMUM_PINS.core},{...good,deploy:MINIMUM_PINS.deploy},{...good,imageId:MINIMUM_PINS.app},{...good,buildReturncode:1},{...good,imageInspection:{mismatches:['wrong labels']}}]){await qualify(bad);await assert.rejects(packet(s,root,archives),/QUALIFICATION_MISMATCH/);}
  await qualify(good);await fs.appendFile(archives.app.path,'changed');await assert.rejects(packet(s,root,archives),/ARTIFACT_HASH_CHANGED/);
  await fs.writeFile(archives.app.path,'synthetic-app');assert.equal((await packet(s,root,archives)).capacityAcceptance,'NOT_GRANTED');
  await fs.appendFile(path.join(directory,'transport.py'),'changed');await assert.rejects(packet(s,root,archives),/EXTENSION_HASH_CHANGED/);
  await fs.writeFile(path.join(directory,'transport.py'),'synthetic');assert.equal((await packet(s,root,archives)).status,'OFFLINE_PACKET_VALIDATED');
  s.reportMode='discovery';s.receipt.remoteReportMode='discovery';s.pins={...s.pins,core:'1'.repeat(40),deploy:'2'.repeat(40)};s.receipt.pair={core:s.pins.core,deploy:s.pins.deploy};
  await assert.rejects(packet(s,root,archives),/QUALIFICATION_MISMATCH/);
  const discoveryProof={...good,core:s.pins.core,deploy:s.pins.deploy,checkImageReturncode:0,imageInspection:{mismatches:[],sourceLabel:s.pins.core,deployLabel:s.pins.deploy}};
  for(const bad of [{...discoveryProof,checkImageReturncode:undefined},{...discoveryProof,checkImageReturncode:1},{...discoveryProof,imageInspection:{...discoveryProof.imageInspection,sourceLabel:good.core}},{...discoveryProof,imageInspection:{mismatches:[]}},{status:'CANONICAL_COMMITTED_BUILD_IMAGE_ONLY_NOT_RUNTIME_ACCEPTED',coreCommit:s.pins.core,deployCommit:s.pins.deploy,imageId:s.pins.app}]){await qualify(bad);await assert.rejects(packet(s,root,archives),/QUALIFICATION/);}
  await qualify(discoveryProof);assert.equal((await packet(s,root,archives)).liveQualification,'UNMEASURED');assert.equal(runtimeBinding(s).reportMode,'discovery');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('supported cohorts use explicit inventory-bound workload plans and genuine matching receipts',()=>{
 for(const tenants of [10,1000,3000,5000,10000])validate(parameterized({tenants}));
 for(const edit of [s=>delete s.resourcePlan,s=>s.resourcePlan.tenants=1000,s=>s.resourcePlan.logicalPollingClients--,s=>s.resourcePlan.hosts.driver.providerId='foreign',s=>s.resourcePlan.hosts.sut.ramBytes++,s=>s.receipt.remoteWorkload.cadence={...s.cadence,offeredRps:240},s=>s.cadence.offeredRps=NaN,s=>s.cadence.loadSeconds=0,s=>s.cadence.loadSeconds=3601,s=>s.cadence.hotFactor=10,s=>s.primerConcurrency=33,s=>s.driverLimits.k6PreallocatedVUsFormula='min(400,ceil(rate/300)*2+5)']){
  const s=structuredClone(parameterized());edit(s);assert.throws(()=>validate(s));
 }
});
test('concurrent primer requires the exact independently qualified source capability',()=>{
 validate(parameterized({primer:true,concurrency:2}));
 assert.throws(()=>parameterized({concurrency:2}),/CONCURRENCY_UNSUPPORTED_SOURCE/);
 for(const edit of [s=>s.pins.app=PINS.app,s=>s.pins.deploy=PINS.deploy,s=>delete s.sourceQualification,s=>s.sourceQualification.sha256='unknown']){const s=parameterized({primer:true,concurrency:2});edit(s);assert.throws(()=>validate(s));}
});
test('actual runtime binding and worker argv forward cohort, rate, duration and concurrency',async()=>{
 const {runtimeBinding}=await import('./pgstream-caller.mjs');const {spawnSync}=await import('node:child_process');
 const s=parameterized({primer:true,concurrency:2,tenants:5000,rate:240,seconds:600});Object.assign(s,{runId:'synthetic-test',cloudId:'synthetic-test-'+'a'.repeat(12),nonce:'b'.repeat(32),expiresAt:Date.now()/1000+3600,k6Image:'grafana/k6@sha256:'+'f'.repeat(64)});
 validate(s);const binding=runtimeBinding(s);assert.deepEqual(binding.workload,s.receipt.remoteWorkload);assert.equal(binding.pair.deploy,PRIMER_PINS.deploy);assert.equal(binding.imageId,PRIMER_PINS.app);
 const code="import importlib.util,json,sys; s=importlib.util.spec_from_file_location('worker',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(list(map(str,m.prepare_arguments(json.load(sys.stdin))))))";
 const generated=spawnSync('python3',['-B','-c',code,new URL('./pgstream-worker.py',import.meta.url).pathname],{input:JSON.stringify(s),encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);const argv=JSON.parse(generated.stdout);
 for(const [flag,value]of [['--tenants','5000'],['--offered-rps','240'],['--load-seconds','600'],['--primer-concurrency','2'],['--deploy-commit',PRIMER_PINS.deploy],['--image',PRIMER_PINS.app]])assert.equal(argv[argv.indexOf(flag)+1],value,flag);
});

test('second source admission validates actual qualification bytes before any archive or runtime',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),crypto=await import('node:crypto');const {packet,HELPER_FILES}=await import('./pgstream-calibration.mjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pgcal-source-capability-'));try{
  const s=parameterized({primer:true,concurrency:2}),directory=path.join(root,'tools/mt-bench/remote-pgstream');await fs.mkdir(directory,{recursive:true});
  const hashes={};for(const name of [...HELPER_FILES].sort()){await fs.writeFile(path.join(directory,name),'synthetic');hashes[name]=crypto.createHash('sha256').update('synthetic').digest('hex');}
  const canonical='{'+Object.keys(hashes).map(k=>JSON.stringify(k)+': '+JSON.stringify(hashes[k])).join(', ')+'}';s.extensionSha256=crypto.createHash('sha256').update(canonical).digest('hex');s.receipt.remoteExtensionSha256=s.extensionSha256;
  s.sourceQualification.path=path.join(root,'qualification.json');const good={status:'CANONICAL_BUILD_AND_QUALIFICATION_PASS_NO_RUNTIME',core:s.pins.core,deploy:s.pins.deploy,imageId:s.pins.app,buildReturncode:0,imageInspection:{mismatches:[]}};
  async function qualify(value){const bytes=JSON.stringify(value);await fs.writeFile(s.sourceQualification.path,bytes);s.sourceQualification.sha256=crypto.createHash('sha256').update(bytes).digest('hex');}
  const archives={app:{status:'PENDING_EXPORT'},postgres:{status:'PENDING_EXPORT'}};await qualify(good);
  await assert.rejects(packet(s,root,archives),/PENDING_EXPORT_EXECUTION_REFUSED/);
  await fs.appendFile(s.sourceQualification.path,' ');await assert.rejects(packet(s,root,archives),/PRIMER_QUALIFICATION_HASH/);
  await qualify({...good,deploy:PINS.deploy});await assert.rejects(packet(s,root,archives),/PRIMER_QUALIFICATION_MISMATCH/);
  await qualify(good);await assert.rejects(packet(s,root,archives),/PENDING_EXPORT_EXECUTION_REFUSED/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});


test('repaired completion source is exact, receipt-qualified, and v2 before packet preparation',async()=>{
 const s=parameterized({primer:true,concurrency:2});s.pins=structuredClone(REPAIRED_PINS);s.receipt.pair={core:s.pins.core,deploy:s.pins.deploy};s.receipt.imageId=s.pins.app;validate(s);
 for(const edit of [v=>v.pins.app=PRIMER_PINS.app,v=>v.pins.core=PINS.core,v=>delete v.sourceQualification,v=>{v.completionContract='evaluator-work-v1';v.receipt.completionContract='evaluator-work-v1';}]){const bad=structuredClone(s);edit(bad);assert.throws(()=>validate(bad));}
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),crypto=await import('node:crypto');const {packet}=await import('./pgstream-calibration.mjs');const root=await fs.mkdtemp(path.join(os.tmpdir(),'pgcal-repaired-'));
 try{
  s.sourceQualification.path=path.join(root,'qualification.json');const good={status:'CANONICAL_BUILD_AND_QUALIFICATION_PASS_NO_RUNTIME',core:s.pins.core,deploy:s.pins.deploy,imageId:s.pins.app,buildReturncode:0,imageInspection:{mismatches:[]}};
  async function qualify(value){const raw=JSON.stringify(value);await fs.writeFile(s.sourceQualification.path,raw);s.sourceQualification.sha256=crypto.createHash('sha256').update(raw).digest('hex');}
  await qualify(good);await assert.rejects(packet(s,root,{}),/ENOENT/);
  await fs.appendFile(s.sourceQualification.path,' ');await assert.rejects(packet(s,root,{}),/QUALIFICATION_HASH/);
  await qualify({...good,core:PINS.core});await assert.rejects(packet(s,root,{}),/QUALIFICATION_MISMATCH/);
  await qualify(good);await assert.rejects(packet(s,root,{}),/ENOENT/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

// This capability is additional; old repaired and primer controls remain above.
test('minimum source requires exact pins, v2 and canonical receipt before packet files',async()=>{
 const s=parameterized({primer:true,concurrency:2,tenants:1000,rate:180,seconds:310});s.pins=structuredClone(MINIMUM_PINS);s.receipt.pair={core:s.pins.core,deploy:s.pins.deploy};s.receipt.imageId=s.pins.app;validate(s);
 for(const edit of [v=>v.pins.app=REPAIRED_PINS.app,v=>v.pins.core=REPAIRED_PINS.core,v=>v.pins.deploy=PINS.deploy,v=>delete v.sourceQualification,v=>{v.completionContract='evaluator-work-v1';v.receipt.completionContract='evaluator-work-v1';}]){const bad=structuredClone(s);edit(bad);assert.throws(()=>validate(bad));}
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),crypto=await import('node:crypto');const {packet}=await import('./pgstream-calibration.mjs');const root=await fs.mkdtemp(path.join(os.tmpdir(),'pgcal-minimum-'));
 try{
  s.sourceQualification.path=path.join(root,'qualification.json');const good={status:'CANONICAL_BUILD_AND_QUALIFICATION_PASS_NO_RUNTIME',core:s.pins.core,deploy:s.pins.deploy,imageId:s.pins.app,buildReturncode:0,imageInspection:{mismatches:[]}};
  async function qualify(value){const raw=JSON.stringify(value);await fs.writeFile(s.sourceQualification.path,raw);s.sourceQualification.sha256=crypto.createHash('sha256').update(raw).digest('hex');}
  await qualify(good);await assert.rejects(packet(s,root,{}),/ENOENT/);
  await fs.appendFile(s.sourceQualification.path,' ');await assert.rejects(packet(s,root,{}),/QUALIFICATION_HASH/);
  for(const bad of [{...good,core:REPAIRED_PINS.core},{...good,imageId:REPAIRED_PINS.app},{...good,buildReturncode:1},{...good,imageInspection:{mismatches:['changed']}}]){await qualify(bad);await assert.rejects(packet(s,root,{}),/QUALIFICATION_MISMATCH/);}
  await qualify(good);await assert.rejects(packet(s,root,{}),/ENOENT/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('actual Session cold wait times out by aborting owned child and forbids late load',async()=>{
 const {Session}=await import('./external-runner.mjs'),{EventEmitter}=await import('node:events'),{PassThrough}=await import('node:stream');
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();let killed=0;child.kill=signal=>{assert.equal(signal,'SIGTERM');killed++;setImmediate(()=>child.emit('close',1));};
 const binding={runId:'synthetic',nonce:'a'.repeat(32),cell:1,expiresAt:Date.now()/1000+3600};
 const gen=new Session(child,binding,'generator-0',{write(){}});let loaded=false;
 const app={next:async()=>({}),send:()=>{loaded=true;}};
 await assert.rejects(coordinateCalibration(app,async()=>gen,async()=>{},()=>{loaded=true;},310,()=>10),/EXTERNAL_HANDSHAKE_TIMEOUT/);
 assert.equal(killed,1);assert.equal(gen.waiting,null);assert.equal(child.stdin.writableEnded,true);assert.equal(loaded,false);
});
test('cold waits end at beforeLoad and ordinary load keeps its duration budget',async()=>{
 const waits=[],sends=[],app={next:async(k,ms)=>{waits.push([k,ms]);return k==='server-recovery-complete'?{measurement:'NOT_RUN'}:k==='cell-complete'?{verdict:'PASS'}:{};},send:k=>sends.push(k),finish:async()=>{}},gen={next:async(k,ms)=>{waits.push([k,ms]);return {};},send:k=>sends.push(k),finish:async()=>{}};
 await coordinateCalibration(app,async()=>gen,async()=>{},()=>sends.push('ack-beforeLoad'),310,()=>123);
 for(const k of ['app-ready','client-primed','load-ready'])assert.equal(waits.find(x=>x[0]===k)[1],123);
 assert.equal(waits.find(x=>x[0]==='load-complete')[1],910000);assert(sends.indexOf('ack-beforeLoad')<sends.indexOf('load-start'));
});


test('explicit discovery changes population, clients, rate and duration with exact authorization',()=>{
 const s=parameterized({tenants:1000});s.reportMode='discovery';s.receipt.remoteReportMode='discovery';s.sourceQualification={path:'/synthetic/image-qualification.json',sha256:'e'.repeat(64)};s.pins={...PINS,core:'1'.repeat(40),deploy:'2'.repeat(40),app:'sha256:'+'3'.repeat(64)};s.receipt.pair={core:s.pins.core,deploy:s.pins.deploy};s.receipt.imageId=s.pins.app;
 s.tenants=271;s.logicalPollingClients=813;s.cadence={...CADENCE,warmupSeconds:2,idleSeconds:5,loadSeconds:45,offeredRps:73,socketsPerTenant:3};s.primerConcurrency=3;
 Object.assign(s.resourcePlan,{tenants:271,logicalPollingClients:813});s.receipt.limits={tenants:271,apiReplicas:1,trafficSeconds:45};s.receipt.remoteWorkload=clone(workloadBinding(s));validate(s);
 for(const edit of [v=>delete v.sourceQualification,v=>v.pins.core='not-a-commit',v=>v.pins.postgres='sha256:'+'4'.repeat(64),v=>delete v.reportMode,v=>v.reportMode=null,v=>v.reportMode='automatic',v=>delete v.receipt.remoteReportMode,v=>v.receipt.remoteReportMode='strict',v=>v.receipt.remoteReportMode=null,v=>v.logicalPollingClients--,v=>v.cadence.socketsPerTenant=9,v=>v.cadence.loadSeconds=0,v=>v.cadence.restart=true,v=>delete v.resourcePlan,v=>v.receipt.remoteWorkload.cadence.offeredRps=74,v=>{v.completionContract='evaluator-work-v1';v.receipt.completionContract='evaluator-work-v1';}]){
  const bad=clone(s);edit(bad);assert.throws(()=>validate(bad));
 }
 validate(s);
});
test('discovery partial finishes both sessions while strict nonpass still refuses',async()=>{
 for(const mode of ['strict','discovery']){
  const events=[],app={next:async k=>k==='cell-complete'?{verdict:'PARTIAL',missing:['probe-accounting.json']}:k==='server-recovery-complete'?{measurement:'NOT_RUN'}:{},send:()=>{},finish:async()=>events.push('app-finished')},gen={next:async()=>({}),send:()=>{},finish:async()=>events.push('gen-finished')};
  const call=()=>coordinateCalibration(app,async()=>gen,async()=>events.push('transferred'),()=>{},45,()=>1800000,mode);
  if(mode==='strict')await assert.rejects(call(),/CELL_NONPASS/);else{assert.equal((await call()).verdict,'PARTIAL');assert.deepEqual(events,['transferred','app-finished','gen-finished']);}
 }
});
