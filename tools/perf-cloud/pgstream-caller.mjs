import {coordinateComponents} from './component-cases.mjs';
// The root coordinator supplies inventory, budget/deadline and provider hooks.
// This caller never allocates hosts or transports a provider credential.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual as equal} from 'node:util';
import {packet,validate,PROFILE,PINS,TRAFFIC_FILES,coordinateCalibration,hashFile,workloadBinding,topologyBinding} from './pgstream-calibration.mjs';
import {Session} from './external-runner.mjs';
import {exec as execute} from './smoke-runner.mjs';
const require=createRequire(import.meta.url);
const {exportPack}=require('./smoke-bundle.js');
const {sparsePack,PATHS}=require('./source-pack.cjs');
const here=path.dirname(fileURLToPath(import.meta.url));
const need=(value,code)=>{if(!value)throw Error(code);};
export const shellQuote=value=>"'"+String(value).replaceAll("'","'\"'\"'")+"'";
const worker='/opt/nsperf/input/pgstream-worker.py';
const LARGE=new Set(['alignment.pack','core.pack','deploy.pack','app.tar','postgres.tar']);
export function sourceFiles(role){return ['spec.json','receipt.json','binding.json','manifest.json','pgstream-worker.py','alignment.pack',...(role==='sut'?['core.pack','deploy.pack','app.tar','postgres.tar']:[])];}
export function transportVerificationCommand(role,directory='/opt/nsperf/input'){
  need(role==='sut'||role==='driver','PGCAL_TRANSPORT_ROLE');
  const source="import hashlib,json\nm=json.load(open('manifest.json'));names="+JSON.stringify(sourceFiles(role).filter(n=>n!=='manifest.json'))+"\ndef digest(n):\n h=hashlib.sha256()\n with open(n,'rb') as f:\n  for block in iter(lambda:f.read(1048576),b''):h.update(block)\n return h.hexdigest()\nassert all(digest(n)==m['files'][n] for n in names),'PGCAL_TRANSPORT_HASH'";
  return 'cd '+shellQuote(directory)+' && python3 -c '+shellQuote(source);
}
export function runtimeBinding(spec,port=spec.port){return {version:1,profile:PROFILE,runId:spec.runId,cloudId:spec.cloudId,nonce:spec.nonce,cell:1,tenants:spec.tenants,appAddress:spec.hosts.sut.privateIPv4,generatorAddress:spec.hosts.driver.privateIPv4,port,expiresAt:spec.expiresAt,pair:{core:spec.pins.core,deploy:spec.pins.deploy},imageId:spec.pins.app,k6Image:spec.k6Image,sourceSha256:spec.extensionSha256,transport:spec.transport,...(spec.reportMode!==undefined?{reportMode:spec.reportMode}:{}),...(workloadBinding(spec)?{workload:workloadBinding(spec)}:{}),...(spec.componentCases?{componentCases:spec.componentCases}:{}),...(topologyBinding(spec)?{...topologyBinding(spec),helperDependencies:spec.helperDependencies}:{})};}
export function executionScope(spec,now=Date.now()/1000){
  validate(spec);
  need(/^[a-z][a-z0-9-]{2,39}$/.test(spec.runId)&&new RegExp('^'+spec.runId+'-[a-f0-9]{12}$').test(spec.cloudId)&&/^[a-f0-9]{32}$/.test(spec.nonce),'PGCAL_RUN_SCOPE');
  need(Number.isFinite(spec.expiresAt)&&spec.expiresAt>now+540&&spec.expiresAt<=now+4*3600&&spec.budget?.totalUsd<=6&&spec.budget?.totalUsd>0&&spec.budget?.rootOwned===true,'PGCAL_ROOT_BUDGET_DEADLINE');
  // Extended campaigns carry a fresh root authority and receipt; old packets
  // retain their original one-hour/half-hour limits. Never derive paidT0 here.
  const lifecycle=spec.lifecycleSeconds??3600;
  need(Number.isFinite(spec.paidT0)&&spec.paidT0<=now&&spec.expiresAt<=spec.paidT0+lifecycle&&Number.isFinite(spec.lastNewPointAt)&&spec.lastNewPointAt>spec.paidT0&&spec.lastNewPointAt<=spec.paidT0+(spec.lifecycleSeconds===undefined?1800:lifecycle-1200)&&spec.lastNewPointAt<=spec.expiresAt-1200&&now<spec.lastNewPointAt,'PGCAL_FINITE_LIFECYCLE');
  if(spec.lifecycleSeconds!==undefined)need(spec.budget.authorizedAt<=spec.paidT0&&spec.expiresAt<=spec.budget.absenceVerifiedBy,'PGCAL_ABSOLUTE_BUDGET_DEADLINE');
  need(/^grafana\/k6@sha256:[a-f0-9]{64}$/.test(spec.k6Image),'PGCAL_K6_IMAGE');
  for(const host of Object.values(spec.hosts))need(/^\d{1,3}(\.\d{1,3}){3}$/.test(host.publicIPv4)&&/^[a-f0-9]{64}$/.test(host.sshHostKeySha256||''),'PGCAL_SSH_HOST_IDENTITY');
  return spec;
}
export async function bundle(spec,roots,archives,directory){
  executionScope(spec);const verified=await packet(spec,roots.helper,archives);
  need((await execute('git',['-C',roots.helper,'rev-parse','HEAD'])).trim()===spec.helperCommit,'PGCAL_HELPER_COMMIT');
  await fs.mkdir(directory,{mode:0o700});
  await exportPack(roots.core,spec.pins.core,path.join(directory,'core.pack'));
  await exportPack(roots.deploy,spec.pins.deploy,path.join(directory,'deploy.pack'));
  await sparsePack(roots.helper,spec.helperCommit,path.join(directory,'alignment.pack'),[...PATHS,'tools/queue/gates/m7_joined_receipt.py','tools/mt-bench/remote-pgstream']);
  for(const name of ['app','postgres'])await fs.copyFile(archives[name].path,path.join(directory,name+'.tar'));
  const transported={...spec,archives:Object.fromEntries(Object.entries(archives).map(([k,a])=>[k,{imageId:a.imageId,sha256:a.sha256}]))};
  for(const [name,value]of [['spec.json',transported],['receipt.json',spec.receipt],['binding.json',runtimeBinding(spec)],['packet.json',verified]])await fs.writeFile(path.join(directory,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
  await fs.copyFile(path.join(here,'pgstream-worker.py'),path.join(directory,'pgstream-worker.py'));
  const files={};for(const name of sourceFiles('sut').filter(n=>n!=='manifest.json'))files[name]=await hashFile(path.join(directory,name));
  const manifest={version:1,profile:PROFILE,files};await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});return manifest;
}
// Root-owned hook actions: admit(private exact-port rule), delete(exact provider IDs).
// Hook executable/bytes are reviewed on the controller and never sent to hosts.
export function verifyKnownHosts(spec,text){
  for(const host of Object.values(spec.hosts)){
    const rows=text.split('\n').filter(line=>!line.startsWith('#')).map(line=>line.trim().split(/\s+/)).filter(row=>row[0]?.split(',').includes(host.publicIPv4));
    need(rows.some(row=>row.length===3&&createHash('sha256').update(Buffer.from(row[2],'base64')).digest('hex')===host.sshHostKeySha256),'PGCAL_SSH_HOST_KEY_MISMATCH');
  }
}
export function hookExec(file,args,{input,timeoutMs=120000}){
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{stdio:['pipe','pipe','pipe'],detached:true});let output='',failure=null;
    const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}};
    const timer=setTimeout(()=>{failure='PGCAL_ROOT_HOOK_TIMEOUT';kill();},timeoutMs);
    child.stdout.on('data',chunk=>{if(Buffer.byteLength(output)+chunk.length>65536){failure='PGCAL_ROOT_HOOK_OUTPUT_BOUND';kill();}else output+=chunk;});child.stderr.resume();
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);if(failure||code!==0)reject(Error(failure||'PGCAL_ROOT_HOOK_FAILED'));else resolve(output);});
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
export async function verifyProviderHook(file,expectedHash){
  need(path.isAbsolute(file)&&await hashFile(file)===expectedHash,'PGCAL_ROOT_HOOK_BYTES');
  try{await fs.access(file,constants.X_OK);}catch{throw Error('PGCAL_ROOT_HOOK_NOT_EXECUTABLE');}
}
export function providerHook(file,expectedHash,run=hookExec){return async(action,value)=>{
  await verifyProviderHook(file,expectedHash);
  return JSON.parse(await run(file,[action],{input:JSON.stringify(value),timeoutMs:120000}));
};}
export function remoteIO(spec,directory,run=execute,start=spawn){
  need(path.isAbsolute(spec.sshIdentityFile)&&path.isAbsolute(spec.knownHostsFile),'PGCAL_SSH_FILES');
  const opts=['-o','BatchMode=yes','-o','ConnectTimeout=10','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+spec.knownHostsFile,'-i',spec.sshIdentityFile,'-o','IdentitiesOnly=yes'];
  const host=role=>(spec.sshUser||'nsperf')+'@'+spec.hosts[role].publicIPv4;
  let loadStarted=false;
  const bounded=(ms,cold=true)=>{const now=Date.now()/1000,until=Math.min(spec.expiresAt-540,cold&&!loadStarted?spec.lastNewPointAt:Infinity);need(now<until,cold&&!loadStarted?'PGCAL_COLD_SETUP_CUTOFF':'PGCAL_DEADLINE');return Math.max(1,Math.min(ms,Math.floor((until-now)*1000)));};
  const ssh=(role,command,timeoutMs=120000)=>run('ssh',[...opts,host(role),command],{timeoutMs:bounded(timeoutMs)});
  const put=(role,source,target)=>run('scp',[...opts,source,host(role)+':'+target],{timeoutMs:bounded(1800000)});
  const get=(role,source,target)=>run('scp',[...opts,host(role)+':'+source,target],{timeoutMs:source==='/opt/nsperf/evidence.tar.gz'?50000:bounded(1800000)});
  const action=(role,verb,timeoutMs=120000)=>['collect','down'].includes(verb)?run('ssh',[...opts,host(role),'sudo -n python3 '+worker+' '+verb+' '+role],{timeoutMs}):ssh(role,'sudo -n python3 '+worker+' '+verb+' '+role,timeoutMs);
  return {ssh,put,get,action,markLoadStarted(){loadStarted=true;},async session(role,binding=runtimeBinding(spec)){
    const log=await fs.open(path.join(directory,role+'-session.log'),'wx',0o600);const stream=log.createWriteStream();
    const eventsFile=await fs.open(path.join(directory,role+'-session-events.jsonl'),'wx',0o600),events=eventsFile.createWriteStream();events.on('error',()=>{});
    const child=start('ssh',[...opts,host(role),'sudo -n python3 '+worker+' '+(role==='sut'?'session':'generator-session')+' '+role],{stdio:['pipe','pipe','pipe']});
    const session=new Session(child,binding,role==='sut'?'app-0':'generator-0',stream,Date.now,row=>events.write(JSON.stringify(row)+'\n'));const timer=setTimeout(()=>session.abort(Error('PGCAL_DEADLINE')),bounded(4*3600000,false));session.finished.finally(()=>{clearTimeout(timer);stream.end();events.end();}).catch(()=>{});return session;
  }};
}
export async function campaign(spec,directory,io,hooks,now=()=>Date.now()/1000){
  executionScope(spec,now());let app,gen;const result={profile:PROFILE,status:'FAIL',capacityAcceptance:'NOT_GRANTED',liveQualification:'UNMEASURED',events:[],cleanup:[]};
  const record=(event,detail={})=>{result.events.push({event,at:now(),...detail});};
  const guard=()=>need(now()<spec.expiresAt-540,'PGCAL_DEADLINE');
  try{
    const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json')));
    for(const role of ['sut','driver']){
      guard();await io.ssh(role,'sudo -n install -d -m 711 /opt/nsperf; sudo -n chown 1000:1000 /opt/nsperf; install -d -m 700 /opt/nsperf/input');
      for(const name of sourceFiles(role).sort((a,b)=>Number(LARGE.has(a))-Number(LARGE.has(b)))){
        need(name==='manifest.json'||await hashFile(path.join(directory,name))===manifest.files[name],'PGCAL_BUNDLE_CHANGED');
        await io.put(role,path.join(directory,name),'/opt/nsperf/input/'+name);
      }
      await io.ssh(role,transportVerificationCommand(role));
      const physical=JSON.parse((await io.action(role,'bind-host')).trim());need(physical.status==='PHYSICAL_HOST_ROLE_BOUND'&&physical.role===role&&physical.providerId===spec.hosts[role].providerId&&physical.expiryExtended===false,'PGCAL_PHYSICAL_HOST_ROLE_BINDING');
      await io.action(role,'bootstrap',3600000);record('bootstrapped',{role});
    }
    guard();await io.action('sut','prepare',1800000);
    const port=JSON.parse((await io.action('sut','port')).trim()).port;need(Number.isInteger(port)&&port>=1024&&port<=65535,'PGCAL_ACTUAL_PREPARED_PORT');
    spec={...spec,port,sutInbound:[spec.sutInbound[0],{...spec.sutInbound[1],port}]};executionScope(spec,now());
    const binding=path.join(directory,'binding.actual.json');await fs.writeFile(binding,JSON.stringify(runtimeBinding(spec)),{mode:0o600});
    for(const role of ['sut','driver'])await io.put(role,binding,'/opt/nsperf/input/binding.json');
    const admission=await hooks.admit(spec);need(admission.status==='APPLIED'&&equal(admission.effectiveInbound,spec.sutInbound)&&admission.sutProviderId===spec.hosts.sut.providerId,'PGCAL_EFFECTIVE_PROVIDER_ADMISSION');
    await io.action('sut','admit');guard();await io.action('sut','deploy',2400000);record('cold-deployment-complete',{port});
    const descriptor=JSON.parse((await io.action('sut','export')).trim());
    need(equal(descriptor.binding,runtimeBinding(spec))&&equal(Object.keys(descriptor.files).sort(),[...TRAFFIC_FILES].sort()),'PGCAL_TRAFFIC_TRANSFER');
    await io.ssh('driver','sudo -n install -d -m 755 -o 1000 -g 1000 /opt/nsperf/traffic');
    const traffic=path.join(directory,'traffic');await fs.mkdir(traffic,{mode:0o700});
    await fs.writeFile(path.join(traffic,'traffic.json'),JSON.stringify(descriptor),{mode:0o600});
    await io.put('driver',path.join(traffic,'traffic.json'),'/opt/nsperf/traffic/traffic.json');
    for(const name of TRAFFIC_FILES){const file=path.join(traffic,name);await io.get('sut','/opt/nsperf/work/cell/traffic-export/'+name,file);need(await hashFile(file)===descriptor.files[name],'PGCAL_TRAFFIC_HASH');await io.put('driver',file,'/opt/nsperf/traffic/'+name);}
    guard();app=await io.session('sut',runtimeBinding(spec));
    const coordinate=spec.componentCases?coordinateComponents:coordinateCalibration;
    const componentResult=await coordinate(app,async()=>{gen=await io.session('driver',runtimeBinding(spec));return gen;},async()=>{
      await io.action('driver','client-export');const file=path.join(directory,'client.tar');await io.get('driver','/opt/nsperf/work/client.tar',file);await io.put('sut',file,'/opt/nsperf/work/client.tar');await io.action('sut','client-import');
    },()=>{need(now()<spec.lastNewPointAt,'PGCAL_NEW_POINT_CUTOFF');io.markLoadStarted?.();},spec.componentCases?.cases??spec.cadence.loadSeconds,()=>{need(now()<spec.lastNewPointAt,'PGCAL_COLD_SETUP_CUTOFF');return Math.max(1,Math.floor((spec.lastNewPointAt-now())*1000));},spec.reportMode??'strict');if(spec.componentCases)result.componentMeasurements=componentResult;else result.cellMeasurement=componentResult;result.status=componentResult?.verdict==='PARTIAL'?'PARTIAL':'PASS';result.liveQualification=result.status==='PARTIAL'?'PARTIAL_MEASUREMENT':'DIAGNOSTIC_COMPLETED';record('steady-diagnostic-complete');
  }catch(error){result.error=error.message;app?.abort(error);gen?.abort(error);}
  finally{
    // Collection is attempted independently for both hosts before exact teardown.
    const collections=await Promise.allSettled(['sut','driver'].map(async role=>{
      try{await io.action(role,'collect',30000);}finally{await io.get(role,'/opt/nsperf/evidence.tar.gz',path.join(directory,role+'-evidence.tar.gz'));}
    }));collections.forEach((r,i)=>{if(r.status==='rejected'){result.status='FAIL';result.cleanup.push({role:['sut','driver'][i],collection:r.reason.message});}});
    for(const role of ['sut','driver'])try{await io.action(role,'down',300000);result.cleanup.push({role,exactOwnedDown:'PASS'});}catch(e){result.status='FAIL';result.cleanup.push({role,exactOwnedDown:e.message});}
    try{const deletion=await hooks.delete({cloudId:spec.cloudId,hosts:spec.hosts,expiresAt:spec.expiresAt});need(deletion.status==='DELETED'&&equal([...deletion.providerIds].sort(),Object.values(spec.hosts).map(h=>h.providerId).sort()),'PGCAL_PROVIDER_DELETION_NOT_CONFIRMED');result.providerDeletion=deletion;}catch(e){result.status='FAIL';result.providerDeletion={status:'UNCONFIRMED',error:e.message};}
    await fs.writeFile(path.join(directory,'campaign-result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  }
  if(result.status!=='PASS'&&!(spec.reportMode==='discovery'&&result.status==='PARTIAL'))throw Object.assign(Error('PGCAL_CAMPAIGN_INCOMPLETE'),{result});return result;
}
// A batch schedules independent finite pairs. It never allocates or reuses a rig.
const BATCH_RESOURCES=['millicpus','memoryBytes','heapMiB','hourlyMicrousd','totalMicrousd','liveResources'];
const canonical=value=>{
  if(typeof value==='number')need(Number.isFinite(value)&&(!Number.isInteger(value)||Number.isSafeInteger(value)),'PGCAL_BATCH_NUMBER_DOMAIN');
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>canonical(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value).replace(/[^\x00-\x7e]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
};
export const batchDigest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const batchHash=batchDigest;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const privateSubnet=value=>{if(typeof value!=='string'||!value.endsWith('/24'))return false;const octets=value.slice(0,-3).split('.');if(octets.length!==4||octets.some(n=>!/^\d{1,3}$/.test(n)||Number(n)>255)||Number(octets[3])!==0)return false;const [a,b]=octets.map(Number);return a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168);};
const positive=value=>Number.isSafeInteger(value)&&value>0;
export function planBatch(batch,now=Date.now()/1000){
  need(batch?.version===1&&/^[a-z][a-z0-9-]{2,39}$/.test(batch.id),'PGCAL_BATCH_ID');
  const {payload:p,envelope:e,cells}=batch;
  need(p&&/^[a-f0-9]{40}$/.test(p.source?.core)&&/^[a-f0-9]{40}$/.test(p.source?.deploy)&&/^sha256:[a-f0-9]{64}$/.test(p.image)&&/^[a-f0-9]{64}$/.test(p.helper),'PGCAL_BATCH_SOURCE');
  need(e&&positive(e.maxConcurrent)&&e.maxConcurrent<=256&&positive(e.maxLiveResources)&&positive(e.maxOfferedRps)&&Number.isFinite(e.cleanupAt)&&e.cleanupAt>now,'PGCAL_BATCH_ENVELOPE');
  for(const key of BATCH_RESOURCES.filter(k=>k!=='liveResources'))need(positive(e[key]),'PGCAL_BATCH_RESOURCE_LIMIT');
  need(Array.isArray(cells)&&cells.length>0&&cells.length<=10000,'PGCAL_BATCH_CELLS');
  const w=e.workload;
  for(const key of ['tenants','offeredRps','durationSeconds','probeEveryMs','hotFactor'])need(Array.isArray(w?.[key])&&w[key].length===2&&w[key].every(positive)&&w[key][0]<=w[key][1],'PGCAL_BATCH_WORKLOAD_ENVELOPE');
  need(Array.isArray(w.faultCases)&&w.faultCases.every(x=>typeof x==='string'),'PGCAL_BATCH_FAULT_ENVELOPE');
  const ids=new Set(),names=new Set(),ports=new Set(),subnets=new Set(),hosts=new Set(),addresses=new Set(),nonces=new Set(),clouds=new Set(),files=new Set();let total=0;
  for(const cell of cells){
    need(/^[a-z][a-z0-9-]{2,39}$/.test(cell.id)&&!ids.has(cell.id),'PGCAL_BATCH_CELL_ID');ids.add(cell.id);
    need(/^[a-z][a-z0-9-]{2,63}$/.test(cell.namespace)&&!names.has(cell.namespace),'PGCAL_BATCH_NAMESPACE');names.add(cell.namespace);
    need(Array.isArray(cell.ports)&&cell.ports.length>0&&Array.isArray(cell.subnets)&&cell.subnets.length>0,'PGCAL_BATCH_ISOLATION');
    for(const port of cell.ports){need(positive(port)&&port<=65535&&!ports.has(port),'PGCAL_BATCH_PORT_COLLISION');ports.add(port);}
    for(const subnet of cell.subnets){need(privateSubnet(subnet)&&!subnets.has(subnet),'PGCAL_BATCH_SUBNET_COLLISION');subnets.add(subnet);}
    const s=cell.config;executionScope(s,now);
    need(equal(p.source,{core:s.pins.core,deploy:s.pins.deploy})&&p.image===s.pins.app&&p.helper===s.extensionSha256,'PGCAL_BATCH_SOURCE_CHANGED');
    need(!clouds.has(s.cloudId)&&!nonces.has(s.nonce),'PGCAL_BATCH_CUSTODY_COLLISION');clouds.add(s.cloudId);nonces.add(s.nonce);
    need(positive(cell.workSeconds)&&positive(cell.cleanupSeconds)&&s.lastNewPointAt<=s.paidT0+cell.workSeconds&&s.expiresAt<=s.paidT0+cell.workSeconds+cell.cleanupSeconds&&s.expiresAt<=e.cleanupAt,'PGCAL_BATCH_DEADLINE');
    need(cell.offeredRps===s.cadence.offeredRps&&positive(cell.offeredRps)&&cell.offeredRps<=e.maxOfferedRps,'PGCAL_BATCH_RATE');
    for(const [key,value]of Object.entries({tenants:s.tenants,offeredRps:cell.offeredRps,durationSeconds:s.cadence.loadSeconds,probeEveryMs:s.cadence.probeEveryMs,hotFactor:s.cadence.hotFactor}))need(value>=w[key][0]&&value<=w[key][1],'PGCAL_BATCH_WORKLOAD_BOUND');
    const faults=s.componentCases?.cases?.map(c=>c.kind)??[];
    need(faults.every(c=>w.faultCases.includes(c)),'PGCAL_BATCH_FAULT_BOUND');
    need((s.componentCases?.cases??[]).every(c=>c.rate<=cell.offeredRps&&c.seconds<=cell.workSeconds),'PGCAL_BATCH_COMPONENT_ENVELOPE');
    const t=cell.target;
    need(t?.kind==='remote'&&['provider','region','size','namePrefix'].every(k=>typeof t[k]==='string'&&/^[a-zA-Z0-9-]{1,64}$/.test(t[k]))&&t.maxResources===2,'PGCAL_BATCH_DESTINATIONS');
    need(equal(Object.keys(s.hosts).sort(),['driver','sut']),'PGCAL_BATCH_PAIR');
    need(cell.ports.includes(s.port),'PGCAL_BATCH_PORT_BINDING');
    for(const h of Object.values(s.hosts)){
      for(const ip of [h.publicIPv4,h.privateIPv4]){need(!addresses.has(ip),'PGCAL_BATCH_ADDRESS_COLLISION');addresses.add(ip);}
      need(cell.subnets.some(subnet=>subnet.split('.').slice(0,3).join('.')===h.privateIPv4.split('.').slice(0,3).join('.')),'PGCAL_BATCH_SUBNET_BINDING');
      need(!hosts.has(h.providerId)&&h.provider===t.provider&&h.region===t.region&&h.size===t.size&&typeof h.name==='string'&&h.name.startsWith(t.namePrefix+'-'),'PGCAL_BATCH_HOST_DESTINATION');hosts.add(h.providerId);
    }
    for(const key of BATCH_RESOURCES)need(positive(cell.resources?.[key])&&cell.resources[key]<=(key==='liveResources'?e.maxLiveResources:e[key]),'PGCAL_BATCH_CELL_OVERCOMMIT');
    need(Object.values(s.hosts).every(h=>positive(h.hourlyMicrousd))&&cell.resources.hourlyMicrousd>=Object.values(s.hosts).reduce((n,h)=>n+h.hourlyMicrousd,0),'PGCAL_BATCH_HOURLY_BOUND');
    need(cell.resources.liveResources===2&&cell.resources.totalMicrousd>=Math.ceil(s.budget.totalUsd*1000000),'PGCAL_BATCH_COST_BOUND');
    need(cell.resources.millicpus>=Object.values(s.hosts).reduce((n,h)=>n+h.cpuCores*1000,0)&&cell.resources.memoryBytes>=Object.values(s.hosts).reduce((n,h)=>n+h.ramBytes,0),'PGCAL_BATCH_HOST_RESOURCE_BOUND');
    total+=cell.resources.totalMicrousd;need(Number.isSafeInteger(total)&&total<=e.totalMicrousd,'PGCAL_BATCH_TOTAL_OVERCOMMIT');
    for(const name of sourceFiles('sut'))files.add(cell.id+'/'+name);
  }
  // All pairs have already been inventoried/paid before this controller runs.
  // Pending pairs consume allocation and money too; execution slots are not
  // permission to hide their resources from the batch envelope.
  for(const key of ['millicpus','memoryBytes','hourlyMicrousd','liveResources'])need(cells.reduce((sum,c)=>sum+c.resources[key],0)<=(key==='liveResources'?e.maxLiveResources:e[key]),'PGCAL_BATCH_PAID_INVENTORY_OVERCOMMIT');
  need(Array.isArray(p.files)&&p.files.length===files.size,'PGCAL_BATCH_PAYLOAD_ALLOWLIST');
  const seen=new Set();for(const f of p.files){need(files.has(f.path)&&!seen.has(f.path)&&/^[a-f0-9]{64}$/.test(f.sha256),'PGCAL_BATCH_PAYLOAD_ALLOWLIST');seen.add(f.path);}
  return {version:1,id:batch.id,sha256:batchHash(batch),specSha256:batchHash(batch),payload:p,envelope:e,cells:cells.map(c=>({id:c.id,cellSha256:batchDigest(c),target:c.target,namespace:c.namespace,ports:c.ports,subnets:c.subnets,resources:c.resources,offeredRps:c.offeredRps,allocationBreakdown:Object.fromEntries(Object.entries(c.config.hosts).map(([role,h])=>[role,{providerId:h.providerId,millicpus:h.cpuCores*1000,memoryBytes:h.ramBytes,hourlyMicrousd:h.hourlyMicrousd,hostRss:'UNMEASURED',headroom:h.headroom??{measurement:'UNMEASURED'}}])),cloudId:c.config.cloudId,nonce:c.config.nonce,hosts:c.config.hosts,expiresAt:c.config.expiresAt})),capacityAcceptance:'NOT_GRANTED'};
}
export async function verifyBatchPayload(batch,root){
  need(path.isAbsolute(root),'PGCAL_BATCH_ROOT');
  for(const file of batch.payload.files){
    const candidate=path.join(root,file.path),stat=await fs.lstat(candidate);
    need(stat.isFile()&&!stat.isSymbolicLink()&&await fs.realpath(candidate)===candidate&&await hashFile(candidate)===file.sha256,'PGCAL_BATCH_PAYLOAD_CHANGED');
  }
  for(const cell of batch.cells){
    const read=async name=>JSON.parse(await fs.readFile(path.join(root,cell.id,name)));
    const actual=await read('spec.json'),expected={...cell.config};delete actual.archives;delete expected.archives;
    need(equal(actual,expected)&&equal(await read('receipt.json'),cell.config.receipt)&&equal(await read('binding.json'),runtimeBinding(cell.config)),'PGCAL_BATCH_TRANSPORT_BINDING');
    const manifest=await read('manifest.json');
    for(const name of sourceFiles('sut').filter(n=>n!=='manifest.json'))need(manifest.files[name]===batch.payload.files.find(f=>f.path===cell.id+'/'+name).sha256,'PGCAL_BATCH_MANIFEST_BINDING');
  }
}
export async function runBatch(batch,root,{hooks,executeCell,signal,now=()=>Date.now()/1000}={}){
  // Root hooks must atomically reserve the authoritative cross-batch budget.
  // No local scheduler promise substitutes for that admission or tool review.
  need(typeof executeCell==='function','PGCAL_BATCH_EXECUTOR_REQUIRED');
  const frozen=freeze(JSON.parse(JSON.stringify(batch))),plan=freeze(planBatch(frozen,now()));await verifyBatchPayload(frozen,root);
  need(['admitBatch','reserveCell','releaseCell'].every(k=>typeof hooks?.[k]==='function'),'PGCAL_BATCH_ROOT_HOOKS');
  const lock=await fs.open(path.join(root,'.batch-'+frozen.id+'.lock'),'wx',0o600);
  const result={version:1,id:frozen.id,planSha256:plan.sha256,status:'PARTIAL',capacityAcceptance:'NOT_GRANTED',cells:[]};
  const used=Object.fromEntries(BATCH_RESOURCES.map(k=>[k,0]));let rate=0,active=0,stopped=false;
  const pending=[...frozen.cells],running=new Set();
  const fits=c=>active<frozen.envelope.maxConcurrent&&rate+c.offeredRps<=frozen.envelope.maxOfferedRps&&BATCH_RESOURCES.every(k=>used[k]+c.resources[k]<=(k==='liveResources'?frozen.envelope.maxLiveResources:frozen.envelope[k]));
  let revision=0;
  const persist=async()=>{const temp=path.join(root,'.batch-result-'+process.pid+'-'+revision++);await fs.writeFile(temp,JSON.stringify(result,null,2)+'\n',{mode:0o600});await fs.rename(temp,path.join(root,'batch-result.json'));};
  try{
    const admission=await hooks.admitBatch(plan);need(admission?.status==='ADMITTED'&&admission.planSha256===plan.sha256,'PGCAL_BATCH_ROOT_REFUSAL');
    const guard=admission.cleanupGuard,providerIds=frozen.cells.flatMap(c=>Object.values(c.config.hosts).map(h=>h.providerId));
    need(guard?.status==='ARMED'&&guard.cleanupAt<=frozen.envelope.cleanupAt&&guard.cleanupAt>now()&&/^[a-f0-9]{64}$/.test(guard.authoritySha256)&&Array.isArray(guard.providerIds)&&equal([...guard.providerIds].sort(),providerIds.sort()),'PGCAL_BATCH_ROOT_CLEANUP_GUARD');
    result.pendingPairCustody={status:'ROOT_GUARD_ARMED',...guard};
    while(pending.length||running.size){
      while(!stopped&&!signal?.aborted&&pending.length){
        const index=pending.findIndex(cell=>now()>=cell.config.lastNewPointAt||now()>=Math.min(cell.config.expiresAt,frozen.envelope.cleanupAt)-cell.cleanupSeconds||fits(cell));
        if(index<0)break;
        const cell=pending.splice(index,1)[0];
        if(now()>=cell.config.lastNewPointAt||now()>=Math.min(cell.config.expiresAt,frozen.envelope.cleanupAt)-cell.cleanupSeconds){result.cells.push({id:cell.id,status:'NOT_STARTED',reason:'CELL_DEADLINE'});continue;}
        active++;rate+=cell.offeredRps;for(const k of BATCH_RESOURCES)used[k]+=cell.resources[k];
        const task=(async()=>{
          const row={id:cell.id,status:'FAILED',cleanup:'UNCONFIRMED'};result.cells.push(row);let reservation;
          try{
            await verifyBatchPayload(frozen,root);
            executionScope(cell.config,now());
            row.reservationAttempted=true;
            reservation=await hooks.reserveCell({batchId:frozen.id,planSha256:plan.sha256,cell});
            need(reservation?.status==='RESERVED'&&typeof reservation.token==='string'&&reservation.token.length>0,'PGCAL_BATCH_RESERVATION_REFUSED');
            row.result=await executeCell(cell,path.join(root,cell.id));row.status=row.result.status;
          }catch(error){row.error=error.message;if(error.result)row.result=error.result;}
          finally{
            // Never free a reservation merely because its worker returned/threw.
            const deletion=row.result?.providerDeletion;
            if(reservation&&deletion?.status==='DELETED'&&equal([...deletion.providerIds].sort(),Object.values(cell.config.hosts).map(h=>h.providerId).sort())){
              try{const release=await hooks.releaseCell({batchId:frozen.id,planSha256:plan.sha256,cellId:cell.id,token:reservation.token,providerIds:deletion.providerIds});need(release?.status==='RELEASED','PGCAL_BATCH_RELEASE_REFUSED');row.cleanup='ABSENT';}catch(error){row.cleanupError=error.message;}
            }else if(reservation){row.cleanupError='PGCAL_BATCH_DELETION_UNCONFIRMED';}
            else if(row.reservationAttempted){stopped=true;row.cleanupError='PGCAL_BATCH_RESERVATION_UNCONFIRMED';}
            else row.cleanup='NOT_ENTERED';
            if(row.cleanup==='ABSENT'||row.cleanup==='NOT_ENTERED'){active--;rate-=cell.offeredRps;for(const k of BATCH_RESOURCES)used[k]-=cell.resources[k];}
            try{await persist();}catch(error){stopped=true;row.recordingError=error.message;}
          }
        })();running.add(task);task.then(()=>running.delete(task),()=>running.delete(task));
      }
      if(running.size)await Promise.race(running);
      else if(pending.length){stopped=true;break;}
    }
    for(const cell of pending)result.cells.push({id:cell.id,status:'NOT_STARTED',reason:signal?.aborted?'CANCELLED':stopped?'ADMISSION_OR_CLEANUP_STOP':'ENVELOPE'});
    result.status=result.cells.every(c=>c.status==='PASS'&&c.cleanup==='ABSENT')?'PASS':'PARTIAL';await persist();return result;
  }finally{await lock.close();/* No stale lock stealing: retained custody requires explicit reconciliation. */}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [mode,input,directory]=process.argv.slice(2);const config=JSON.parse(await fs.readFile(input));
  if(mode==='batch-plan'){const planned=planBatch(config);await verifyBatchPayload(config,directory);process.stdout.write(JSON.stringify(planned,null,2)+'\n');}
  else {
  await verifyProviderHook(config.providerHook.path,config.providerHook.sha256);
  if(mode==='bundle')await bundle(config.spec,config.roots,config.archives,directory);
  else if(mode==='batch-run'){
    const batch=config.batch;need(process.env.PGCAL_EXECUTE===batch.id,'PGCAL_ROOT_EXECUTE_REQUIRED');
    const hook=providerHook(config.providerHook.path,config.providerHook.sha256);
    const controller=new AbortController(),cancel=()=>controller.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
    try{await runBatch(batch,path.resolve(directory),{signal:controller.signal,hooks:{admitBatch:p=>hook('admit-batch',p),reserveCell:c=>hook('reserve-cell',c),releaseCell:c=>hook('release-cell',c)},executeCell:async(cell,folder)=>{
      const spec=cell.config;
      try{verifyKnownHosts(spec,await fs.readFile(spec.knownHostsFile,'utf8'));return await campaign(spec,folder,remoteIO(spec,folder),{admit:s=>hook('admit',s),delete:s=>hook('delete',s)});}catch(error){
        if(error.result)throw error;
        // A scope refusal before campaign entered its finally still owns this
        // admitted exact pair. Delete it; never extend its paid lifetime.
        const providerDeletion=await hook('delete',{cloudId:spec.cloudId,hosts:spec.hosts,expiresAt:spec.expiresAt});
        throw Object.assign(error,{result:{status:'FAIL',providerDeletion}});
      }
    }});}finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
  }
  else if(mode==='run'){
    executionScope(config.spec);need(process.env.PGCAL_EXECUTE===config.spec.cloudId,'PGCAL_ROOT_EXECUTE_REQUIRED');
    const hook=providerHook(config.providerHook.path,config.providerHook.sha256);
    verifyKnownHosts(config.spec,await fs.readFile(config.spec.knownHostsFile,'utf8'));
    await campaign(config.spec,directory,remoteIO(config.spec,directory),{admit:s=>hook('admit',s),delete:s=>hook('delete',s)});
  }else throw Error('PGCAL_USAGE_BUNDLE_RUN_BATCH_PLAN_OR_BATCH_RUN_CONFIG_DIRECTORY');
  }
}
