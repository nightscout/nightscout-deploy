import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {campaign,sourceFiles,runtimeBinding,executionScope,verifyKnownHosts,hookExec,providerHook,transportVerificationCommand} from './pgstream-caller.mjs';
import {PINS,CADENCE,PROFILE,TRAFFIC_FILES,hashFile} from './pgstream-calibration.mjs';
const sha=text=>createHash('sha256').update(text).digest('hex');
function spec(){const t={interface:'ens7',mac:'02:00:00:00:00:01',approvedAddress:'10.8.0.2',approvalReference:'synthetic-root-approved'};const host=(id,ip,pub,key)=>({providerId:id,privateIPv4:ip,publicIPv4:pub,sshHostKeySha256:sha(key),cpuCores:4,ramBytes:8000000000,networkBitsPerSecond:1000000000,allocationSource:'provider-inventory',headroom:{measurement:'UNMEASURED'}});return {profile:PROFILE,completionContract:'evaluator-work-v2',diagnostics:'on',tenants:1000,logicalPollingClients:2000,pins:PINS,cadence:CADENCE,extensionSha256:'a'.repeat(64),helperCommit:'b'.repeat(40),transport:t,port:18080,controllerIPv4:'192.0.2.1',runId:'remote-test',cloudId:'remote-test-'+'a'.repeat(12),nonce:'b'.repeat(32),paidT0:1000,lastNewPointAt:2800,expiresAt:4600,k6Image:'grafana/k6@sha256:'+'f'.repeat(64),budget:{rootOwned:true,totalUsd:6},hosts:{sut:host('synthetic-sut','10.8.0.2','192.0.2.2','sut-key'),driver:host('synthetic-driver','10.8.0.3','192.0.2.3','driver-key')},receipt:{completionContract:'evaluator-work-v2',kind:'joined-diagnostic',status:'AUTHORIZED_DIAGNOSTIC',functionalAcceptanceAtAuthorization:'PENDING',imageId:PINS.app,pair:{core:PINS.core,deploy:PINS.deploy},instrument:'c'.repeat(64),limits:{tenants:1000,apiReplicas:1,trafficSeconds:310},remoteProfile:PROFILE,remoteExtensionSha256:'a'.repeat(64),remoteTransport:t},sutInbound:[{protocol:'tcp',port:22,sourceIPv4:'192.0.2.1'},{protocol:'tcp',port:18080,sourceIPv4:'10.8.0.3',sourceProviderId:'synthetic-driver'}],driverLimits:{fdSoft:65536,fdHard:65536,k6PreallocatedVUsFormula:'min(400,ceil(rate/300)*2+5)',k6MaxVUsPerScenario:800,measurement:'UNMEASURED'},pgstreamProducer:'canonical-262-with-pool-initialize',providerTokenOnHosts:false};}
test('root budget/deadline and SSH known-host bytes refuse wrong identity',()=>{const s=spec();executionScope(s,1000);for(const change of [s=>s.budget.totalUsd=12,s=>s.expiresAt=1500,s=>s.hosts.driver.sshHostKeySha256='unknown']){const b=structuredClone(s);change(b);assert.throws(()=>executionScope(b,1000));}const known='192.0.2.2 ssh-ed25519 '+Buffer.from('sut-key').toString('base64')+'\n192.0.2.3 ssh-ed25519 '+Buffer.from('driver-key').toString('base64');verifyKnownHosts(s,known);assert.throws(()=>verifyKnownHosts(s,known.replace(Buffer.from('driver-key').toString('base64'),Buffer.from('wrong-key').toString('base64'))),/HOST_KEY/);});
async function simulation(failAt,discovery=false,longWindow=false){const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pgcal-caller-'));const s=spec(),events=[];if(discovery){s.sourceQualification={path:'/synthetic/image-qualification.json',sha256:'e'.repeat(64)};s.reportMode='discovery';s.receipt.remoteReportMode='discovery';s.tenants=271;s.logicalPollingClients=813;s.cadence={...CADENCE,warmupSeconds:2,idleSeconds:5,loadSeconds:45,offeredRps:73,socketsPerTenant:3};s.primerConcurrency=3;s.driverLimits.k6PreallocatedVUsFormula='min(400,ceil(rate*1000/arrivalCycleMs)*2+5)';s.resourcePlan={reference:'synthetic-discovery',tenants:271,logicalPollingClients:813,hosts:Object.fromEntries(Object.entries(s.hosts).map(([k,v])=>[k,{providerId:v.providerId,cpuCores:v.cpuCores,ramBytes:v.ramBytes}]))};s.receipt.limits={tenants:271,apiReplicas:1,trafficSeconds:45};s.receipt.remoteWorkload={cadence:s.cadence,primerConcurrency:3,resourcePlan:s.resourcePlan};}if(longWindow){s.lifecycleSeconds=10800;s.expiresAt=11800;s.lastNewPointAt=10000;s.receipt.remoteLifecycleSeconds=10800;Object.assign(s.budget,{scopeId:'synthetic-window',authoritySha256:'a'.repeat(64),authorizedAt:900,absenceVerifiedBy:12000});s.receipt.remoteBudgetAuthority=Object.fromEntries(['scopeId','authoritySha256','authorizedAt','absenceVerifiedBy'].map(k=>[k,s.budget[k]]));}const startNow=longWindow?5000:1000;let currentNow=startNow;try{
  const files={};for(const name of sourceFiles('sut').filter(n=>n!=='manifest.json')){await fs.writeFile(path.join(folder,name),'synthetic');files[name]=await hashFile(path.join(folder,name));}await fs.writeFile(path.join(folder,'manifest.json'),JSON.stringify({files}));
  const descriptor={binding:runtimeBinding(s,18081),files:Object.fromEntries(TRAFFIC_FILES.map(n=>[n,sha('traffic')]))};
  const io={ssh:async(role,cmd)=>events.push(role+':ssh'),put:async(role,file,target)=>events.push(role+':put:'+path.basename(target)),get:async(role,source,target)=>{events.push(role+':get:'+path.basename(source));await fs.writeFile(target,source.includes('/traffic-export/')?'traffic':'synthetic-output');},action:async(role,verb,timeoutMs)=>{events.push(role+':'+verb);if(verb==='admit'&&failAt==='cold-deadline')currentNow=s.lastNewPointAt;if(verb==='deploy')assert.equal(timeoutMs,discovery?(s.lastNewPointAt-startNow)*1000:2400000);if(verb===failAt)throw Error('SYNTHETIC_'+verb);return verb==='bind-host'?JSON.stringify({status:'PHYSICAL_HOST_ROLE_BOUND',role,providerId:s.hosts[role].providerId,expiryExtended:false}):verb==='port'?JSON.stringify({port:18081}):verb==='export'?JSON.stringify(descriptor):'';},session:async(role,b)=>{assert.equal(b.port,18081);if(discovery){assert.equal(b.reportMode,'discovery');assert.equal(b.tenants,271);assert.equal(b.workload.cadence.offeredRps,73);assert.equal(b.workload.cadence.loadSeconds,45);}return {next:async k=>{events.push(role+':phase:'+k);return k==='cell-complete'?{verdict:discovery?'PARTIAL':'PASS'}:k==='server-recovery-complete'?{measurement:'NOT_RUN'}:{primed:2000};},send:k=>events.push(role+':send:'+k),finish:async()=>events.push(role+':finish'),abort:()=>events.push(role+':abort')};}};
  const hooks={admit:async actual=>{events.push('provider:admit');assert.equal(actual.port,18081);return {status:'APPLIED',effectiveInbound:actual.sutInbound,sutProviderId:s.hosts.sut.providerId};},delete:async actual=>{events.push('provider:delete');return {status:'DELETED',providerIds:Object.values(actual.hosts).map(h=>h.providerId)};}};
  if(failAt)await assert.rejects(campaign(s,folder,io,hooks,()=>currentNow),/CAMPAIGN_INCOMPLETE/);else assert.equal((await campaign(s,folder,io,hooks,()=>currentNow)).status,discovery?'PARTIAL':'PASS');
  if(failAt==='cold-deadline')assert(!events.includes('sut:deploy'));const result=JSON.parse(await fs.readFile(path.join(folder,'campaign-result.json')));assert.equal(result.providerDeletion.status,'DELETED');assert(events.includes('sut:collect'));assert(events.includes('driver:collect'));assert(events.includes('sut:down'));assert(events.includes('driver:down'));assert.equal(events.filter(e=>e==='provider:delete').length,1);return events;
}finally{await fs.rm(folder,{recursive:true,force:true});}}
test('bounded caller wires staging, real port, direct traffic, results and exact cleanup',async()=>{const events=await simulation();assert(events.indexOf('sut:bind-host')<events.indexOf('sut:bootstrap'));assert(events.indexOf('driver:bind-host')<events.indexOf('driver:bootstrap'));assert(events.indexOf('provider:admit')<events.indexOf('sut:deploy'));assert(events.indexOf('sut:client-import')<events.indexOf('sut:send:finish'));assert(events.indexOf('sut:collect')<events.indexOf('sut:down'));assert(events.indexOf('driver:down')<events.indexOf('provider:delete'));});
test('prepare and load/steady failures still collect both hosts and delete exact IDs',async()=>{await simulation('bind-host');await simulation('prepare');await simulation('deploy');await simulation('export');});
test('generator transfer scope excludes application images, source and credentials',()=>{assert.deepEqual(sourceFiles('driver'),['spec.json','receipt.json','binding.json','manifest.json','pgstream-worker.py','alignment.pack']);assert(!sourceFiles('driver').includes('app.tar'));});
test('root hook receives JSON on stdin with bounded output',async()=>{const output=await hookExec(process.execPath,['-e',"let x='';process.stdin.on('data',c=>x+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({received:JSON.parse(x).cloudId})));"],{input:JSON.stringify({cloudId:'synthetic-run'}),timeoutMs:1000});assert.deepEqual(JSON.parse(output),{received:'synthetic-run'});});

test('real POSIX shell and Python preserve verifier literals and reject corrupted payloads',async()=>{
  const {spawnSync}=await import('node:child_process');
  for(const role of ['sut','driver']){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"pgcal shell ' quoted "));
    try{
      const files={};for(const name of sourceFiles(role).filter(n=>n!=='manifest.json')){const data='synthetic '+role+' '+name+'\n';await fs.writeFile(path.join(root,name),data);files[name]=sha(data);}
      await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify({files}));
      const verify=()=>spawnSync('/bin/sh',['-c',transportVerificationCommand(role,root)],{encoding:'utf8'});
      const good=verify();assert.equal(good.status,0,good.stderr);
      await fs.appendFile(path.join(root,'alignment.pack'),'deliberate corruption\n');
      const broken=verify();assert.notEqual(broken.status,0);assert.match(broken.stderr,/AssertionError: PGCAL_TRANSPORT_HASH/);
      await fs.writeFile(path.join(root,'alignment.pack'),'synthetic '+role+' alignment.pack\n');
      const restored=verify();assert.equal(restored.status,0,restored.stderr);
    }finally{await fs.rm(root,{recursive:true,force:true});}
  }
});

test('small-cell binding and finite lifecycle refuse mismatched bounds',async()=>{
 const s=spec();s.tenants=10;s.logicalPollingClients=20;s.receipt.limits.tenants=10;
 assert.equal(runtimeBinding(s).tenants,10);executionScope(s,1000);
 for(const edit of [v=>v.expiresAt=4601,v=>v.lastNewPointAt=2801,v=>v.paidT0=1001]){const b=structuredClone(s);edit(b);assert.throws(()=>executionScope(b,1000),/FINITE_LIFECYCLE/);}
});

test('provider hook permissions refuse before invocation and restored executable passes',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pgcal-hook-mode-'));const file=path.join(folder,'hook.py');const bytes='#!/usr/bin/env python3\nprint("{}")\n';let invoked=0;
 try{
  await fs.writeFile(file,bytes,{mode:0o600});const hook=providerHook(file,sha(bytes),async()=>{invoked++;return '{}';});
  await assert.rejects(hook('delete',{}),/PGCAL_ROOT_HOOK_NOT_EXECUTABLE/);assert.equal(invoked,0);
  await fs.chmod(file,0o700);assert.deepEqual(await hook('delete',{}),{});assert.equal(invoked,1);
  await fs.chmod(file,0o600);await assert.rejects(hook('admit',{}),/PGCAL_ROOT_HOOK_NOT_EXECUTABLE/);assert.equal(invoked,1);
  await fs.chmod(file,0o700);assert.deepEqual(await hook('admit',{}),{});assert.equal(invoked,2);
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});


test('explicit three-hour lifecycle binds fresh root authority and preserves absolute cleanup',()=>{
 const s=spec();s.lifecycleSeconds=10800;s.expiresAt=11800;s.lastNewPointAt=10000;s.receipt.remoteLifecycleSeconds=10800;
 Object.assign(s.budget,{scopeId:'new-five-hour-synthetic',authoritySha256:'a'.repeat(64),authorizedAt:900,absenceVerifiedBy:12000});
 s.receipt.remoteBudgetAuthority=Object.fromEntries(['scopeId','authoritySha256','authorizedAt','absenceVerifiedBy'].map(k=>[k,s.budget[k]]));
 executionScope(s,1000);executionScope(s,5000);
 for(const edit of [v=>v.lifecycleSeconds=10801,v=>v.lifecycleSeconds=10800.5,v=>delete v.receipt.remoteLifecycleSeconds,v=>delete v.budget.rootOwned,v=>delete v.budget,v=>v.budget.totalUsd=6.01,v=>v.budget.authoritySha256='old-unsealed',v=>delete v.receipt.remoteBudgetAuthority,v=>v.budget.scopeId='changed',v=>{v.budget.authorizedAt=1001;v.receipt.remoteBudgetAuthority.authorizedAt=1001;},v=>{v.budget.absenceVerifiedBy=11000;v.receipt.remoteBudgetAuthority.absenceVerifiedBy=11000;},v=>v.paidT0=800,v=>v.paidT0=1001,v=>v.expiresAt=12001,v=>v.lastNewPointAt=v.expiresAt-1199]){
  const bad=structuredClone(s);edit(bad);assert.throws(()=>executionScope(bad,1000));
 }
 assert.throws(()=>executionScope(s,11300),/DEADLINE/);executionScope(s,1000);
 const legacy=spec();legacy.expiresAt=11800;legacy.lastNewPointAt=10000;assert.throws(()=>executionScope(legacy,1000),/FINITE_LIFECYCLE/);executionScope(spec(),1000);
});

test('cold setup failure retains collection, exact down and provider deletion',async()=>{
 const events=await simulation('bootstrap');
 assert(events.includes('sut:collect')&&events.includes('driver:collect'));
 assert(events.includes('sut:down')&&events.includes('driver:down'));
 assert.equal(events.filter(x=>x==='provider:delete').length,1);
 assert(!events.some(x=>x.endsWith(':send:load-start')));
});
test('actual remoteIO clamps cold action and transfer then preserves post-load and cleanup budgets',async()=>{
 const now=Date.now()/1000,s=spec();s.lastNewPointAt=now+2;s.expiresAt=now+4000;s.sshIdentityFile='/synthetic/key';s.knownHostsFile='/synthetic/known';
 const calls=[],io=(await import('./pgstream-caller.mjs')).remoteIO(s,'/synthetic',async(exe,args,opt)=>{calls.push({exe,args,opt});return '';});
 await io.action('sut','bootstrap',3600000);await io.put('driver','/synthetic/source','/synthetic/target');
 assert(calls.slice(0,2).every(c=>c.opt.timeoutMs>0&&c.opt.timeoutMs<=2000));
 io.markLoadStarted();await io.action('driver','client-export',120000);assert.equal(calls.at(-1).opt.timeoutMs,120000);
 await io.action('sut','collect',30000);assert.equal(calls.at(-1).opt.timeoutMs,30000);
 const expired={...s,lastNewPointAt:now-1};let ran=false;
 const blocked=(await import('./pgstream-caller.mjs')).remoteIO(expired,'/synthetic',async()=>{ran=true;});
 await assert.rejects(async()=>blocked.action('sut','prepare'),/COLD_SETUP_CUTOFF/);assert.equal(ran,false);
});

test('explicit discovery reaches changed workload through actual caller binding and retains PARTIAL cleanup',async()=>{
 const events=await simulation(undefined,true);assert(events.includes('sut:client-import'));assert(events.includes('driver:finish'));assert.equal(events.filter(e=>e==='provider:delete').length,1);
});

test('aged three-hour discovery deployment uses remaining original cold cutoff',async()=>{await simulation(undefined,true,true);});

test('expired original discovery cold cutoff refuses before deployment dispatch',async()=>{await simulation('cold-deadline',true);});
