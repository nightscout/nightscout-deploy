import {componentCases} from './component-cases.mjs';
// Finite file-only packet preparation and bounded no-restart phase coordination.
// No provider API, SSH, Docker, SQL, actor allocation or image export is invoked here.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual as equal} from 'node:util';
export const PROFILE='remote-pgstream-calibration-v1';
export const PINS={core:'5d305dd08f006b7956c5c9a647d5e541b307c9f1',deploy:'0dcde57e1dd3959e3420a6e1e4ff2ef65a40902d',app:'sha256:544ab2001b46297aec069f32beacdc7a152711a521f83faea9630de38032472d',postgres:'sha256:21e7e1665c3dd2fdd80ebd9ce6d36fb160d6a4129683b315b6492a71d87bfda7'};
export const CADENCE={warmupSeconds:10,idleSeconds:30,loadSeconds:310,accel:1,hotFactor:1,samplerIntervalSeconds:2,probeEveryMs:300000,restart:false,socketsPerTenant:2};
// Individually qualified source capabilities; no arbitrary source/image substitution.
export const PRIMER_PINS={...PINS,deploy:'df5362745a1b2d1b02b9186daedef3faccc14e58',app:'sha256:153505ae2a2568cd8a081762506a6ca8d6c8eef3b7ad10529ca04c30993f8416'};
export const REPAIRED_PINS={...PRIMER_PINS,core:'7291af9b9cc48dbe58c488e892e7b34cf367c88e',app:'sha256:2a4e911fc9d4a06a4a25286c90d8d9fca835d873849eb6974c15bdb498d41ff8'};
export const MINIMUM_PINS={...PRIMER_PINS,core:'8aeefaefc88c79c3d548f7683d5651bec9cf5c01',app:'sha256:382e44696c4415e710698ee6135c499ae2d480d9f39a2fb85c59675fdd8d2150'};
// Experimental ordinary deployment; full acceptance remains independent.
export const PERFORMANCE_PINS={...PINS,core:'d5ec3998986365034c3189485339ec12960ba3f7',deploy:'bf8327f4de096bb342a65ecb75ef7a356a21ffc9',app:'sha256:0775fcd95b0a1807b2de7345caa9547584265a3c1495af75d89fffe7350c49e2'};
export const COHORTS=[10,1000,3000,5000,10000];
export function discoveryMode(spec){const mode=spec.reportMode===undefined?'strict':spec.reportMode;need(['strict','discovery'].includes(mode),'PGCAL_REPORT_MODE');return mode==='discovery';}
export function topologyBinding(spec){
  const selected=spec.pgstreamTopology!==undefined||spec.diagnosticResourceProfile!==undefined;
  if(!selected){need(spec.receipt?.remotePgstreamTopology===undefined&&spec.receipt?.remoteDiagnosticResourceProfile===undefined&&spec.helperDependencies===undefined&&spec.receipt?.remoteHelperDependencies===undefined,'PGCAL_TOPOLOGY_RECEIPT');return null;}
  need(discoveryMode(spec)&&spec.pgstreamTopology==='external-service-v1'&&spec.diagnosticResourceProfile==='local-diagnostic-external-pgstream-4cpu-8g-v1','PGCAL_EXPLICIT_TOPOLOGY');
  need(spec.receipt?.remotePgstreamTopology===spec.pgstreamTopology&&spec.receipt?.remoteDiagnosticResourceProfile===spec.diagnosticResourceProfile,'PGCAL_TOPOLOGY_RECEIPT');
  const d=spec.helperDependencies;
  need(d&&equal(Object.keys(d).sort(),['files','profile','version'])&&['external-service-v1','external-service-batch-v1'].includes(d.profile)&&d.version===1&&equal(spec.receipt?.remoteHelperDependencies,d),'PGCAL_TOPOLOGY_DEPENDENCIES');
  const names=['tools/mt-bench/m7-joined/stream_topology.py','tools/mt-bench/m7-joined/diagnostic_resources.py',...(d.profile==='external-service-batch-v1'?['tools/mt-bench/m7-joined/experiment_batch.py']:[])];
  need(equal(Object.keys(d.files??{}).sort(),names.sort())&&Object.values(d.files).every(v=>/^[a-f0-9]{64}$/.test(v)),'PGCAL_TOPOLOGY_DEPENDENCIES');
  return {pgstreamTopology:spec.pgstreamTopology,diagnosticResourceProfile:spec.diagnosticResourceProfile};
}
export function workloadBinding(spec){
  const discovery=discoveryMode(spec);
  const concurrency=spec.primerConcurrency??1;
  need(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=32,'PGCAL_PRIMER_CONCURRENCY');
  need(discovery||equal(spec.pins,PRIMER_PINS)||(equal(spec.pins,REPAIRED_PINS)||equal(spec.pins,MINIMUM_PINS))||concurrency===1,'PGCAL_PRIMER_CONCURRENCY_UNSUPPORTED_SOURCE');
  const cadence=spec.cadence;
  need(cadence&&Number.isInteger(cadence.loadSeconds)&&cadence.loadSeconds>=1&&cadence.loadSeconds<=(discovery?10800:3600),'PGCAL_LOAD_DURATION');
  const {loadSeconds,offeredRps,...fixed}=cadence;
  const {loadSeconds:ignored,...expected}=CADENCE;
  if(discovery){
    need(equal(Object.keys(cadence).sort(),Object.keys(offeredRps===undefined?CADENCE:{...CADENCE,offeredRps}).sort())&&cadence.restart===false,'PGCAL_EXPLICIT_CADENCE');
    for(const key of Object.keys(CADENCE).filter(k=>k!=='restart'))need(Number.isInteger(cadence[key])&&cadence[key]>=1&&cadence[key]<=({samplerIntervalSeconds:60,socketsPerTenant:8,probeEveryMs:3600000}[key]??10800),'PGCAL_EXPLICIT_CADENCE');
    need(cadence.warmupSeconds+cadence.idleSeconds+cadence.loadSeconds<=10800,'PGCAL_LOAD_DURATION');
  }else need(equal(fixed,expected),'PGCAL_EXPLICIT_CADENCE');
  need(offeredRps===undefined||(Number.isFinite(offeredRps)&&offeredRps>=1&&offeredRps<=10000),'PGCAL_EXPLICIT_CADENCE');
  if(spec.resourcePlan===undefined){
    need(!discovery,'PGCAL_RESOURCE_PLAN_REQUIRED');
    need([10,1000].includes(spec.tenants)&&equal(cadence,CADENCE)&&concurrency===1,'PGCAL_RESOURCE_PLAN_REQUIRED');
    return null;
  }
  const plan=spec.resourcePlan;
  need(plan&&equal(Object.keys(plan).sort(),['reference','tenants','logicalPollingClients','hosts'].sort())&&typeof plan.reference==='string'&&/^[A-Za-z0-9_.:/-]{1,160}$/.test(plan.reference)&&plan.tenants===spec.tenants&&plan.logicalPollingClients===(discovery?cadence.socketsPerTenant:2)*spec.tenants&&equal(Object.keys(plan.hosts??{}).sort(),['driver','sut']),'PGCAL_RESOURCE_PLAN_BINDING');
  for(const role of ['sut','driver']){
    const host=plan.hosts[role],actual=spec.hosts?.[role];
    need(host&&actual&&equal(Object.keys(host).sort(),['providerId','cpuCores','ramBytes'].sort())&&typeof host.providerId==='string'&&host.providerId.length>0&&host.providerId.length<=160&&Number.isFinite(host.cpuCores)&&host.cpuCores>0&&Number.isSafeInteger(host.ramBytes)&&host.ramBytes>0&&equal(host,{providerId:actual.providerId,cpuCores:actual.cpuCores,ramBytes:actual.ramBytes}),'PGCAL_RESOURCE_PLAN_HOST');
  }
  need(plan.hosts.sut.providerId!==plan.hosts.driver.providerId,'PGCAL_RESOURCE_PLAN_HOST');
  return {cadence,primerConcurrency:concurrency,resourcePlan:plan};
}
export const HELPER_FILES=['host_binding.py','component_cases.py','component_sut.py','component_sessions.py','app.py','cell.py','clinical.py','generator.py','producer.py','protocol.py','recovery.cjs','traffic_probe.py','transport.py'];
export const TRAFFIC_FILES=['probe-accounting.cjs','package.json','package-lock.json','tenants.private.json','probe.js','workload.js','recovery.cjs'];
const need=(v,code)=>{if(!v)throw Error(code);};
export function privateIPv4(value){
  if(typeof value!=='string'||!/^\d{1,3}(\.\d{1,3}){3}$/.test(value))return false;
  const p=value.split('.').map(Number);return p.every(n=>n<=255)&&(p[0]===10||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168));
}
export function validate(spec){
  const discovery=discoveryMode(spec);
  topologyBinding(spec);
  need((spec.receipt?.remoteReportMode===undefined?'strict':spec.receipt.remoteReportMode)===(spec.reportMode===undefined?'strict':spec.reportMode),'PGCAL_REPORT_AUTHORIZATION');
  need(!discovery||spec.componentCases===undefined,'PGCAL_DISCOVERY_COMPONENTS_UNSUPPORTED');
  const components=componentCases(spec.componentCases,spec.tenants);
  need(components===null||equal(spec.receipt?.remoteComponentCases,components),'PGCAL_COMPONENT_RECEIPT');
  need(spec.profile===PROFILE&&Number.isInteger(spec.tenants)&&(discovery?spec.tenants>=1&&spec.tenants<=10000:COHORTS.includes(spec.tenants))&&spec.logicalPollingClients===spec.tenants*(discovery?spec.cadence?.socketsPerTenant:2),'PGCAL_FIXED_PROFILE');
  // Discovery configuration is an unverified request. packet() binds a genuine
  // image qualification; the SUT still executes source/image/loader preflight.
  const requestedPins=spec.pins;
  need(discovery ? requestedPins&&equal(Object.keys(requestedPins).sort(),['app','core','deploy','postgres'])&&/^[a-f0-9]{40}$/.test(requestedPins.core)&&/^[a-f0-9]{40}$/.test(requestedPins.deploy)&&/^sha256:[a-f0-9]{64}$/.test(requestedPins.app)&&requestedPins.postgres===PINS.postgres : equal(spec.pins,PINS)||equal(spec.pins,PRIMER_PINS)||(equal(spec.pins,REPAIRED_PINS)||equal(spec.pins,MINIMUM_PINS))||equal(spec.pins,PERFORMANCE_PINS),'PGCAL_QUALIFIED_SOURCE');
  if(equal(spec.pins,PERFORMANCE_PINS)&&!discovery)need(spec.tenants===1000&&spec.logicalPollingClients===2000&&equal(spec.cadence,{...CADENCE,offeredRps:180})&&(spec.primerConcurrency??1)===1&&spec.componentCases===undefined,'PGCAL_PERFORMANCE_PROFILE');
  const workload=workloadBinding(spec);
  if(discovery)need(spec.completionContract==='evaluator-work-v2','PGCAL_REPAIRED_COMPLETION_V2_REQUIRED');
  need(workload===null||equal(spec.receipt?.remoteWorkload,workload),'PGCAL_WORKLOAD_RECEIPT_BINDING');
  if(discovery||equal(spec.pins,PRIMER_PINS)||(equal(spec.pins,REPAIRED_PINS)||equal(spec.pins,MINIMUM_PINS))||equal(spec.pins,PERFORMANCE_PINS))need(path.isAbsolute(spec.sourceQualification?.path??'')&&/^[a-f0-9]{64}$/.test(spec.sourceQualification?.sha256??''),'PGCAL_PRIMER_QUALIFICATION_REQUIRED');
  if((equal(spec.pins,REPAIRED_PINS)||equal(spec.pins,MINIMUM_PINS))||equal(spec.pins,PERFORMANCE_PINS))need(spec.completionContract==='evaluator-work-v2','PGCAL_REPAIRED_COMPLETION_V2_REQUIRED');
  need(['evaluator-work-v1','evaluator-work-v2'].includes(spec.completionContract)&&spec.receipt?.completionContract===spec.completionContract&&['on','off'].includes(spec.diagnostics),'PGCAL_EXPLICIT_OBSERVATION_CONTRACT');
  need(spec.receipt?.kind==='joined-diagnostic'&&spec.receipt.status==='AUTHORIZED_DIAGNOSTIC'&&spec.receipt.functionalAcceptanceAtAuthorization==='PENDING'&&spec.receipt.imageId===spec.pins.app&&equal(spec.receipt.pair,{core:spec.pins.core,deploy:spec.pins.deploy})&&equal(spec.receipt.limits,{tenants:spec.tenants,apiReplicas:1,trafficSeconds:spec.cadence.loadSeconds})&&/^[a-f0-9]{64}$/.test(spec.receipt.instrument||'')&&spec.receipt.remoteProfile===PROFILE&&spec.receipt.remoteExtensionSha256===spec.extensionSha256,'PGCAL_GENUINE_DIAGNOSTIC_REQUIRED');
  need(/^[a-f0-9]{64}$/.test(spec.extensionSha256||'')&&/^[a-f0-9]{40}$/.test(spec.helperCommit||''),'PGCAL_EXTENSION_IDENTITY');
  if(spec.lifecycleSeconds!==undefined){
    need(Number.isInteger(spec.lifecycleSeconds)&&spec.lifecycleSeconds>=3600&&spec.lifecycleSeconds<=10800&&spec.receipt.remoteLifecycleSeconds===spec.lifecycleSeconds,'PGCAL_EXPLICIT_LIFECYCLE');
    const b=spec.budget,authority=b&&{scopeId:b.scopeId,authoritySha256:b.authoritySha256,authorizedAt:b.authorizedAt,absenceVerifiedBy:b.absenceVerifiedBy};
    need(b?.rootOwned===true&&Number.isFinite(b.totalUsd)&&b.totalUsd>0&&b.totalUsd<=6&&/^[A-Za-z0-9_.:-]{1,120}$/.test(b.scopeId||'')&&/^[a-f0-9]{64}$/.test(b.authoritySha256||'')&&Number.isFinite(b.authorizedAt)&&Number.isFinite(b.absenceVerifiedBy)&&b.authorizedAt<b.absenceVerifiedBy&&equal(spec.receipt.remoteBudgetAuthority,authority),'PGCAL_EXTENDED_BUDGET_AUTHORITY');
  }
  const {sut,driver}=spec.hosts||{};
  need(sut&&driver&&privateIPv4(sut.privateIPv4)&&privateIPv4(driver.privateIPv4)&&sut.privateIPv4!==driver.privateIPv4&&typeof sut.providerId==='string'&&typeof driver.providerId==='string'&&sut.providerId.length>0&&driver.providerId.length>0&&sut.providerId!==driver.providerId,'PGCAL_ACTUAL_PROVIDER_HOSTS');
  need(spec.transport?.approvedAddress===sut.privateIPv4&&/^[A-Za-z][A-Za-z0-9_.-]{0,14}$/.test(spec.transport.interface||'')&&/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(spec.transport.mac||'')&&/^[A-Za-z0-9_.:/-]{1,160}$/.test(spec.transport.approvalReference||'')&&equal(spec.receipt.remoteTransport,spec.transport),'PGCAL_APPROVED_NIC');
  need(Number.isInteger(spec.port)&&spec.port>=1024&&spec.port<=65535,'PGCAL_PORT');
  // Provider effective inbound rules are finite and role-specific. A shared run
  // tag, broad CIDR, all-TCP or alternate generator cannot satisfy this record.
  need(equal(spec.sutInbound,[{protocol:'tcp',port:22,sourceIPv4:spec.controllerIPv4},{protocol:'tcp',port:spec.port,sourceIPv4:driver.privateIPv4,sourceProviderId:driver.providerId}])&&typeof spec.controllerIPv4==='string'&&/^\d{1,3}(\.\d{1,3}){3}$/.test(spec.controllerIPv4),'PGCAL_GENERATOR_ONLY_FIREWALL');
  for(const host of [sut,driver])need(host.cpuCores>0&&host.ramBytes>0&&((Number.isFinite(host.networkBitsPerSecond)&&host.networkBitsPerSecond>0)||(host.networkBitsPerSecond===null&&equal(host.networkAllocation,{measurement:'UNMEASURED',reason:'providerAPI-no-bandwidthfield'})))&&host.allocationSource==='provider-inventory'&&host.headroom?.measurement==='UNMEASURED','PGCAL_RESOURCE_PROVENANCE');
  need(spec.driverLimits?.fdSoft>0&&spec.driverLimits.fdHard>=spec.driverLimits.fdSoft&&(spec.driverLimits.requestedWorkerFdSoft===undefined||(Number.isInteger(spec.driverLimits.requestedWorkerFdSoft)&&spec.driverLimits.requestedWorkerFdSoft>=8192&&spec.driverLimits.requestedWorkerFdSoft<=spec.driverLimits.fdHard))&&spec.driverLimits.k6PreallocatedVUsFormula===(spec.cadence.offeredRps===undefined?'min(400,ceil(rate/300)*2+5)':'min(400,ceil(rate*1000/arrivalCycleMs)*2+5)')&&spec.driverLimits.k6MaxVUsPerScenario===800&&spec.driverLimits.measurement==='UNMEASURED','PGCAL_DRIVER_LIMITS');
  need(spec.pgstreamProducer==='canonical-262-with-pool-initialize'&&spec.providerTokenOnHosts===false,'PGCAL_PRODUCER_OR_CREDENTIAL_BOUNDARY');
  return spec;
}
export function proposal(extensionSha256,helperCommit){
  return {version:1,profile:PROFILE,status:'SOURCE_PREPARED_ALLOCATION_AND_EXPORT_PENDING',tenants:1000,logicalPollingClients:2000,pins:PINS,cadence:CADENCE,extensionSha256,helperCommit,capacityAcceptance:'NOT_GRANTED',liveQualification:'UNMEASURED',authorization:'GENUINE_AUTHORIZED_DIAGNOSTIC_RECEIPT_PENDING',allocation:'ROOT_AND_HUMAN_REVIEW_PENDING',artifacts:Object.fromEntries([['app','app-8956.tar'],['postgres','postgres-21e.tar']].map(([name,file])=>[name,{imageId:PINS[name],status:'PENDING_EXPORT',sha256:null,path:'/mnt/data/nightscout-workspace/artifacts/pgstream-remote1k-transport-36be-262-20261114/'+file}])),executionRefusedUntil:['actual export bytes/checksums reviewed','actual provider inventory and approved NIC/MAC/privateIP','generator-only exact-port provider firewall and SUT pre-DNAT admission','genuine diagnostic receipt bound to base and extension identities','paid allocation approval'],driverLimits:{k6PreallocatedVUsFormula:'min(400,ceil(rate/300)*2+5)',k6MaxVUsPerScenario:800,scenarioCount:7,fdSoft:'UNMEASURED',fdHard:'UNMEASURED',headroom:'UNMEASURED'}};
}
export async function hashFile(file){const h=createHash('sha256');for await(const block of createReadStream(file))h.update(block);return h.digest('hex');}
// Existing canonical rebootstrap producer records complete image/source bytes,
// rather than the older build-returncode envelope. Preserve that actual evidence
// shape; no synthetic returncode or runtime/capacity qualification is inferred.
export async function rebootstrapQualification(spec,qualification){
  const read=async ref=>{need(path.isAbsolute(ref?.path??'')&&/^[a-f0-9]{64}$/.test(ref.sha256??'')&&await hashFile(ref.path)===ref.sha256,'PGCAL_REBOOTSTRAP_PROOF_HASH');return fs.readFile(ref.path,'utf8');};
  const receipt=JSON.parse(await read(qualification));
  need(discoveryMode(spec)&&topologyBinding(spec)&&receipt.status==='PASS'&&receipt.basis==='reproduced'&&receipt.core===spec.pins.core&&receipt.deploy===spec.pins.deploy&&receipt.imageId===spec.pins.app&&receipt.qualifierAbsent===true&&Array.isArray(receipt.builderReferencesAbsent)&&receipt.builderReferencesAbsent.length>0&&new Set(receipt.builderReferencesAbsent).size===receipt.builderReferencesAbsent.length&&receipt.builderReferencesAbsent.every(x=>/^[a-f0-9]{12}$/.test(x)),'PGCAL_REBOOTSTRAP_BINDING');
  const manifestText=await read(qualification.manifest),manifest=JSON.parse(manifestText),buildLog=await read(qualification.buildLog),byteCheck=JSON.parse(await read(qualification.byteCheck)),inspection=JSON.parse(await read(qualification.inspection));
  need(qualification.manifest.sha256===receipt.manifestSha256&&qualification.buildLog.sha256===receipt.buildLogSha256&&manifest.core===spec.pins.core&&manifest.deploy===spec.pins.deploy&&manifest.files&&Object.keys(manifest.files).length>0&&Object.values(manifest.files).every(x=>/^[a-f0-9]{64}$/.test(x)),'PGCAL_REBOOTSTRAP_MANIFEST');
  need(equal(byteCheck,receipt.sourceByteCheck)&&equal(byteCheck.mismatches,[])&&byteCheck.sourceFiles===Object.keys(manifest.files).length&&byteCheck.binding?.coreCommit===spec.pins.core&&byteCheck.binding?.deployCommit===spec.pins.deploy&&byteCheck.node==='v24.22.1','PGCAL_REBOOTSTRAP_SOURCE_BYTES');
  need(inspection.imageId===spec.pins.app&&inspection.sourceLabel===spec.pins.core&&inspection.deployLabel===spec.pins.deploy,'PGCAL_REBOOTSTRAP_IMAGE_LABELS');
  need(typeof receipt.tag==='string'&&buildLog.split('\n').includes('Successfully built '+spec.pins.app.slice(7,19))&&buildLog.split('\n').includes('Successfully tagged '+receipt.tag),'PGCAL_REBOOTSTRAP_BUILD_MARKER');
  return {status:'SOURCE_BYTE_IMAGE_PROOF_PASS',buildReturncode:'UNMEASURED',runtime:'NOT_RUN',capacityAcceptance:'NOT_GRANTED'};
}
export async function packet(spec,helperRoot,archives){
  validate(spec);
  if(discoveryMode(spec)||equal(spec.pins,PRIMER_PINS)||(equal(spec.pins,REPAIRED_PINS)||equal(spec.pins,MINIMUM_PINS))||equal(spec.pins,PERFORMANCE_PINS)){
    const qualification=spec.sourceQualification;
    need(await hashFile(qualification.path)===qualification.sha256,'PGCAL_PRIMER_QUALIFICATION_HASH');
    const receipt=JSON.parse(await fs.readFile(qualification.path));
    if(receipt.status==='PASS'){
      await rebootstrapQualification(spec,qualification);
    }else if(receipt.status==='CANONICAL_INTERMEDIATE_BUILD_LABEL_CHECK_AND_BUILDER_ABSENCE_PASS'){
      need(discoveryMode(spec)&&topologyBinding(spec)&&receipt.source===spec.pins.core&&receipt.deploy===spec.pins.deploy&&receipt.imageId===spec.pins.app&&receipt.buildReturncode===0&&equal(receipt.imageLabelMismatches,[])&&receipt.sourceProcessSameBirthPresent===false&&receipt.runtime==='NOT_RUN'&&receipt.capacityAcceptance==='NOT_GRANTED'&&Array.isArray(receipt.builderReferencesAbsent)&&receipt.builderReferencesAbsent.length>0,'PGCAL_INTERMEDIATE_IMAGE_QUALIFICATION');
      const check=qualification.check;need(path.isAbsolute(check?.path??'')&&/^[a-f0-9]{64}$/.test(check.sha256??'')&&await hashFile(check.path)===check.sha256,'PGCAL_INTERMEDIATE_CHECK_HASH');
      const result=JSON.parse(await fs.readFile(check.path));need(result.returncode===0&&result.source===spec.pins.core&&result.deploy===spec.pins.deploy&&result.image===spec.pins.app&&result.runtime==='NOT_RUN','PGCAL_INTERMEDIATE_CHECK_BINDING');
    }else{
      need(receipt.status==='CANONICAL_BUILD_AND_QUALIFICATION_PASS_NO_RUNTIME'&&receipt.core===spec.pins.core&&receipt.deploy===spec.pins.deploy&&receipt.imageId===spec.pins.app&&receipt.buildReturncode===0&&equal(receipt.imageInspection?.mismatches,[]),'PGCAL_PRIMER_QUALIFICATION_MISMATCH');
      if(discoveryMode(spec))need(receipt.checkImageReturncode===0&&receipt.imageInspection.sourceLabel===spec.pins.core&&receipt.imageInspection.deployLabel===spec.pins.deploy,'PGCAL_DISCOVERY_IMAGE_QUALIFICATION');
    }
  }
  if(topologyBinding(spec)){
    const d=spec.helperDependencies;
    for(const [name,sha256]of Object.entries(d.files))need(await hashFile(path.join(helperRoot,name))===sha256,'PGCAL_TOPOLOGY_DEPENDENCY_BYTES');
    const resourceSource=await fs.readFile(path.join(helperRoot,'tools/mt-bench/m7-joined/diagnostic_resources.py'),'utf8');
    need(/(?:^|\n)[ \t]*(?:from experiment_batch import|import experiment_batch)(?:\s|$)/.test(resourceSource)===(d.profile==='external-service-batch-v1'),'PGCAL_TOPOLOGY_DEPENDENCY_PROFILE');
  }
  const directory=path.join(helperRoot,'tools/mt-bench/remote-pgstream');
  const actual=(await fs.readdir(directory)).filter(f=>/\.(py|cjs)$/.test(f)&&!f.startsWith('test_')).sort();
  need(equal(actual,[...HELPER_FILES].sort()),'PGCAL_HELPER_ALLOWLIST');
  const hashes={};for(const name of actual)hashes[name]=await hashFile(path.join(directory,name));
  // Python source_identity uses sorted JSON with the default space separators.
  const canonical='{'+Object.keys(hashes).sort().map(k=>JSON.stringify(k)+': '+JSON.stringify(hashes[k])).join(', ')+'}';
  need(createHash('sha256').update(canonical).digest('hex')===spec.extensionSha256,'PGCAL_EXTENSION_HASH_CHANGED');
  need(equal(Object.keys(archives).sort(),['app','postgres']),'PGCAL_ARTIFACT_ALLOWLIST');
  const artifacts={};for(const name of ['app','postgres']){
    const a=archives[name];need(a.status!=='PENDING_EXPORT','PGCAL_PENDING_EXPORT_EXECUTION_REFUSED');need(a.imageId===spec.pins[name]&&/^[a-f0-9]{64}$/.test(a.sha256||'')&&path.isAbsolute(a.path),'PGCAL_IMMUTABLE_ARTIFACT');
    need((await fs.lstat(a.path)).isFile()&&await hashFile(a.path)===a.sha256,'PGCAL_ARTIFACT_HASH_CHANGED');
    artifacts[name]={imageId:a.imageId,sha256:a.sha256,bytes:(await fs.stat(a.path)).size};
  }
  return {version:1,profile:PROFILE,status:'OFFLINE_PACKET_VALIDATED',liveQualification:'UNMEASURED',capacityAcceptance:'NOT_GRANTED',spec,helperFiles:hashes,...(spec.helperDependencies?{helperDependencies:spec.helperDependencies}:{}),artifacts,
    transfer:{sut:['alignment source at helperCommit','core source at pins.core','deploy overlay at pins.deploy','app image archive','postgres image archive','genuine diagnostic receipt','binding'],driver:['remote-pgstream helper allowlist','binding','traffic descriptor',...TRAFFIC_FILES]},
    clocks:{sut:'local SQL request bookends/cgroup/process/IO only',driver:'local monotonic write-to-frame and event-loop',crossHostSubtraction:false,writeToEvaluation:'UNMEASURED'},
    coldBoot:'deployment-stages.json; infrastructure/bootstrap/provision/commission/pool-initialize/API/prime/publish before steady sampling',
    headroom:'REST-owned sampler integration pending; current generator CPU/RSS/network scope retained',
    executionBoundary:'Root reviews this packet and paid allocation before any provider or host action'};
}
// Reuses existing external-runner Session instances and exact-file traffic export.
// Callers own remote staging/collection and must use the packet source identities.
export async function coordinateCalibration(app,startGenerator,transfer,beforeLoad=()=>{},loadSeconds=310,coldWaitMs=()=>1800000,reportMode='strict'){
  await app.next('app-ready',coldWaitMs());const gen=await startGenerator();
  app.send('client-primed',await gen.next('client-primed',coldWaitMs()));
  await app.next('load-ready',coldWaitMs());beforeLoad();gen.send('load-start');
  await gen.next('load-complete',(loadSeconds+600)*1000);app.send('load-complete');
  const [server]=await Promise.all([app.next('server-recovery-complete',1000000),gen.next('client-complete',1500000)]);
  need(equal(server,{measurement:'NOT_RUN'}),'PGCAL_NO_RESTART');
  await transfer();app.send('finish');
  const result=await app.next('cell-complete',180000);need(result.verdict==='PASS'||(reportMode==='discovery'&&result.verdict==='PARTIAL'),'PGCAL_CELL_NONPASS');
  gen.send('finish');await Promise.all([app.finish(),gen.finish()]);return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [input,helperRoot,output]=process.argv.slice(2);need(input&&helperRoot&&output,'PGCAL_USAGE_SPEC_HELPER_OUTPUT');
  const {spec,archives}=JSON.parse(await fs.readFile(input));
  const result=await packet(spec,helperRoot,archives);
  await fs.writeFile(output,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
}
