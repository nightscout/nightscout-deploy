#!/usr/bin/env node
'use strict';
// Independent process, not a host-loss guarantee. Never provisions resources.
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {validate,nodes,digest}=require('./spec');
const {checkBundle,command}=require('./drivers');
const execute=(exe,args,{env,cwd,timeout}={})=>command(exe,args,{env,cwd,timeoutMs:timeout});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const save=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
function environment(cloud) {
  const env={PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',SSH_AUTH_SOCK:process.env.SSH_AUTH_SOCK};
  if(cloud && process.env.DIGITALOCEAN_TOKEN) env.DIGITALOCEAN_ACCESS_TOKEN=process.env.DIGITALOCEAN_TOKEN;
  else if(cloud && process.env.DIGITALOCEAN_ACCESS_TOKEN) env.DIGITALOCEAN_ACCESS_TOKEN=process.env.DIGITALOCEAN_ACCESS_TOKEN;
  return env;
}
async function context(dir) {
  const spec=validate(await read(path.join(dir,'spec.json'))),meta=await read(path.join(dir,'run.json'));
  if(meta.mode!=='live' || meta.specSha256!==digest(JSON.stringify(spec)) || meta.runId!==spec.runId ||
      !new RegExp('^'+spec.runId+'-[0-9a-f]{12}$').test(meta.cloudId) || meta.tag!=='nsperf-'+meta.cloudId ||
      !Number.isFinite(meta.expiresAt) || !Number.isFinite(meta.startedAt) ||
      meta.expiresAt-meta.startedAt!==spec.maxMinutes*60000) throw new Error('WATCHDOG_MANIFEST_MISMATCH');
  return {dir,spec,meta,names:new Set(Object.keys(nodes(spec)).map(k=>meta.tag+'-'+k))};
}
async function cloudInventory(ctx,exec) {
  const call=async args=>JSON.parse((await exec('doctl',args,{env:environment(true),timeout:30000,maxBuffer:8*1024*1024})).stdout);
  const droplets=await call(['compute','droplet','list','--tag-name',ctx.meta.tag,'--output','json']);
  if(!Array.isArray(droplets) || droplets.some(r=>!r.tags?.includes(ctx.meta.tag) || !ctx.names.has(r.name) || !/^\d+$/.test(String(r.id)))) throw new Error('WATCHDOG_OWNERSHIP_MISMATCH');
  const firewallRows=await call(['compute','firewall','list','--output','json']);
  const tags=await call(['compute','tag','list','--output','json']);
  if(!Array.isArray(firewallRows) || !Array.isArray(tags)) throw new Error('WATCHDOG_INVENTORY_INVALID');
  const firewalls=firewallRows.filter(r=>r.name===ctx.meta.tag);
  if(firewalls.some(r=>!/^[0-9a-f-]{36}$/.test(r.id))) throw new Error('WATCHDOG_OWNERSHIP_MISMATCH');
  return {droplets,firewalls,tag:tags.some(r=>r.name===ctx.meta.tag)};
}
async function collect(ctx,bundle,exec) {
  if(!bundle) return 'not-configured';
  const root=await checkBundle(bundle,ctx.spec.bundleSha256);
  const env={...environment(false),PERF_RUN_DIR:ctx.dir,PERF_SPEC:path.join(ctx.dir,'spec.json'),
    PERF_INVENTORY:path.join(ctx.dir,'inventory.json'),PERF_EVIDENCE:path.join(ctx.dir,'evidence')};
  const result=await exec(process.execPath,[path.join(root,'collect.mjs')],{cwd:root,env,timeout:60000,maxBuffer:8*1024*1024});
  await fs.writeFile(path.join(ctx.dir,'evidence','watchdog-collect.log'),result.stdout+'\n'+result.stderr,{mode:0o600});
  return 'completed';
}
async function runWatchdog(dir,{exec=execute,bundle,pollMs=1000,maxAttempts=3,retryMs=2000,settleMs=2000,now=Date.now,wait=sleep}={}) {
  dir=path.resolve(dir);
  const ctx=await context(dir);
  const lock=await fs.open(path.join(dir,'watchdog.lock'),'wx',0o600);
  const result={runId:ctx.spec.runId,cleanup:'FAILED_RESOURCES_MAY_REMAIN',errors:[],events:[]};
  try {
    await lock.writeFile(JSON.stringify({pid:process.pid}));
    await save(path.join(dir,'watchdog.ready'),{pid:process.pid,expiresAt:ctx.meta.expiresAt});
    let controllerClean=false;
    for(;;) {
      const prior=await read(path.join(dir,'result.json')).catch(()=>null);
      controllerClean=prior?.cleanup==='verified';
      if(controllerClean || now()>=ctx.meta.expiresAt || await fs.access(path.join(dir,'watchdog.cleanup-request')).then(()=>true,()=>false)) break;
      await wait(pollMs);
    }
    // Revalidate exact ownership immediately before any cloud mutation.
    const current=await context(dir);
    if(current.meta.cloudId!==ctx.meta.cloudId) throw new Error('WATCHDOG_MANIFEST_MISMATCH');
    if(!controllerClean) {
      result.events.push('collect-started');
      try { result.collection=await collect(ctx,bundle,exec); }
      catch(e) { result.collection='failed';result.errors.push({phase:'collect',message:e.message}); }
      result.events.push('collect-finished');
    } else result.collection='controller-finalized';
    for(let attempt=1;attempt<=maxAttempts;attempt++) {
      try {
        const inventory=await cloudInventory(ctx,exec);
        const invoke=args=>exec('doctl',args,{env:environment(true),timeout:30000,maxBuffer:8*1024*1024});
        result.events.push('destroy-started');
        for(const row of inventory.firewalls) await invoke(['compute','firewall','delete',row.id,'--force']);
        for(const row of inventory.droplets) await invoke(['compute','droplet','delete',String(row.id),'--force']);
        if(inventory.tag) await invoke(['compute','tag','delete',ctx.meta.tag,'--force']);
        const remaining=await cloudInventory(ctx,exec);
        if(remaining.droplets.length || remaining.firewalls.length || remaining.tag) throw new Error('WATCHDOG_RESOURCES_REMAIN');
        // Do not exit on a single empty response during asynchronous cloud deletion.
        await wait(settleMs);
        const settled=await cloudInventory(ctx,exec);
        if(settled.droplets.length || settled.firewalls.length || settled.tag) throw new Error('WATCHDOG_RESOURCES_REMAIN');
        result.cleanup='verified';result.events.push('destroy-verified');break;
      } catch(e) {
        result.errors.push({phase:'destroy',attempt,message:e.message});
        // An ownership mismatch cannot be fixed by retrying deletion.
        if(/OWNERSHIP|MANIFEST/.test(e.message)) break;
        if(attempt<maxAttempts) await wait(retryMs);
      }
    }
  } catch(e) { result.errors.push({phase:'watchdog',message:e.message}); }
  finally {
    result.finishedAt=new Date().toISOString();
    await save(path.join(dir,'watchdog-result.json'),result);
    await lock.close();
    await fs.unlink(path.join(dir,'watchdog.lock'));
  }
  return result;
}
async function startWatchdog(dir,{bundle,confirmSpend,startupMs=10000}={}) {
  dir=path.resolve(dir);
  const ctx=await context(dir);
  if(confirmSpend!==ctx.spec.runId) throw new Error('WATCHDOG_REQUIRES_RUN_ID_CONFIRMATION');
  if(bundle) await checkBundle(bundle,ctx.spec.bundleSha256);
  // Refuse duplicate launches. Stale launch markers need explicit operator review.
  const marker=await fs.open(path.join(dir,'watchdog-launch.json'),'wx',0o600);
  await marker.writeFile(JSON.stringify({at:new Date().toISOString()}));await marker.close();
  const child=spawn(process.execPath,[__filename,dir,...(bundle?[path.resolve(bundle)]:[])],{
    env:{...environment(true),DIGITALOCEAN_TOKEN:process.env.DIGITALOCEAN_TOKEN},detached:true,stdio:'ignore'
  });
  let spawnError;child.on('error',e=>{spawnError=e;});child.unref();
  const end=Date.now()+startupMs;
  while(Date.now()<end) {
    if(spawnError) throw spawnError;
    const ready=await read(path.join(dir,'watchdog.ready')).catch(()=>null);
    if(ready?.pid===child.pid) return {pid:child.pid,directory:dir};
    await sleep(25);
  }
  throw new Error('WATCHDOG_STARTUP_TIMEOUT');
}
async function requestCleanup(dir,{timeoutMs=180000,pollMs=100}={}) {
  await fs.writeFile(path.join(dir,'watchdog.cleanup-request'),'cleanup\n',{mode:0o600});
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    const result=await read(path.join(dir,'watchdog-result.json')).catch(()=>null);
    if(result) return result;
    await sleep(pollMs);
  }
  throw new Error('WATCHDOG_COMPLETION_TIMEOUT');
}
if(require.main===module) runWatchdog(process.argv[2],{bundle:process.argv[3]}).then(r=>{if(r.cleanup!=='verified')process.exitCode=1;}).catch(()=>{process.exitCode=1;});
module.exports={runWatchdog,startWatchdog,requestCleanup,cloudInventory,context};
