'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {createReadStream}=require('node:fs');
const crypto=require('node:crypto');
const { nodes, digest, SIZES } = require('./spec');
const {hourlyBudget,withFleetLock}=require('./fleet-budget.cjs');
const STAGES = ['deploy','seed','warm','load','recovery'];
const stages=spec=>['colocated-capacity-v1','joined-diagnostic-v1','joined-pilot-v1','joined-baseline-diagnostic-v1','cache-diagnostic-v1','core-acceptance-v1','joined-external-generator-v1'].includes(spec.profile)?['deploy','campaign']:STAGES;
const json = async file => JSON.parse(await fs.readFile(file,'utf8'));
const save = (file,value) => fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});

// Kill the process group: an interrupted hook must not leave an SSH/load child running.
function command(exe,args,{cwd,env={PATH:process.env.PATH,LANG:'C.UTF-8'},timeoutMs=60000,signal}={}) {
  return new Promise((resolve,reject) => {
    let stdout='',stderr='',reason;
    const child=spawn(process.execPath,[path.join(__dirname,'supervise.js'),String(timeoutMs),exe,...args],{cwd,env,detached:true,stdio:['pipe','pipe','pipe']});
    let hardKill;
    const stop = why => {
      if (reason) return;
      reason=why;
      try { process.kill(-child.pid,'SIGTERM'); } catch { /* already exited */ }
      hardKill=setTimeout(()=>{ try { process.kill(-child.pid,'SIGKILL'); } catch { /* already exited */ } },500);
    };
    const abort=()=>stop('CANCELLED');
    const timer=setTimeout(()=>stop('COMMAND_TIMEOUT'),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    if (signal?.aborted) abort();
    const append=(name,chunk)=>{
      if (name==='stdout') stdout+=chunk; else stderr+=chunk;
      if (stdout.length+stderr.length > 8*1024*1024) stop('COMMAND_OUTPUT_LIMIT');
    };
    child.stdout.on('data',chunk=>append('stdout',chunk));
    child.stderr.on('data',chunk=>append('stderr',chunk));
    const finish=()=>{clearTimeout(timer);clearTimeout(hardKill);signal?.removeEventListener('abort',abort);};
    child.on('error',e=>{finish();reject(e);});
    child.on('close',code=>{finish();
      if (reason || code!==0) reject(Object.assign(new Error(reason || 'COMMAND_FAILED'),{code,stdout,stderr}));
      else resolve({stdout,stderr});
    });
  });
}

async function checkBundle(directory,expected) {
  const root=await fs.realpath(directory);
  const raw=await fs.readFile(path.join(root,'manifest.json'));
  if (digest(raw)!==expected) throw new Error('BUNDLE_MANIFEST_DIGEST_MISMATCH');
  const manifest=JSON.parse(raw);
  if (manifest.adapter!=='controller-bundle-v1' || manifest.version!==1 || !manifest.files) throw new Error('BUNDLE_CONTRACT_INVALID');
  const required=['colocated-capacity-v1','joined-diagnostic-v1','joined-pilot-v1','joined-baseline-diagnostic-v1','cache-diagnostic-v1','core-acceptance-v1','joined-external-generator-v1'].includes(manifest.profile)?['deploy','campaign','collect']:[...STAGES,'collect'];
  for(const stage of required) if(!manifest.files[stage+'.mjs'])throw new Error('BUNDLE_STAGE_MISSING');
  for (const [name,expectedHash] of Object.entries(manifest.files)) {
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || !/^[0-9a-f]{64}$/.test(expectedHash))throw new Error('BUNDLE_STAGE_MISSING');
    const file=await fs.realpath(path.join(root,name));
    if(!file.startsWith(root+path.sep))throw new Error('BUNDLE_STAGE_DIGEST_MISMATCH');
    const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
    if(hash.digest('hex')!==expectedHash)throw new Error('BUNDLE_STAGE_DIGEST_MISMATCH');
  }
  return root;
}

class Simulated {
  constructor({dir,spec,meta,failAt,failDestroy=0,failCollect=false,stuck=false}) {
    Object.assign(this,{dir,spec,meta,failAt,failDestroy,failCollect,stuck});
    this.resources=path.join(dir,'simulated-resources.json');
  }
  async provision() {
    await save(this.resources,Object.keys(nodes(this.spec)));
    await save(path.join(this.dir,'inventory.json'),{run_id:this.meta.cloudId,nodes:nodes(this.spec)});
    if (this.failAt==='provision') throw new Error('SIMULATED_PARTIAL_PROVISION_FAILURE');
  }
  async stage(stage,{signal}={}) {
    if (signal?.aborted) throw new Error('CANCELLED');
    await fs.writeFile(path.join(this.dir,'evidence',stage+'.txt'),'SIMULATED '+stage+'; no application measurement\n',{mode:0o600});
    if (this.failAt===stage) throw new Error('SIMULATED_'+stage.toUpperCase()+'_FAILURE');
  }
  async collect() {
    await save(path.join(this.dir,'evidence','partial-inventory.json'),await json(this.resources).catch(()=>[]));
    if (this.failCollect) throw new Error('SIMULATED_COLLECTION_FAILURE');
  }
  async destroy() {
    if (this.failDestroy-- > 0) throw new Error('SIMULATED_DESTROY_FAILURE');
    if (!this.stuck) await save(this.resources,[]);
  }
  async verify() { if ((await json(this.resources).catch(()=>[])).length) throw new Error('RESOURCES_REMAIN'); }
}

class DigitalOcean {
  constructor({dir,spec,meta,bundle,exec=command,networkPollMs=2000,fleetLockDirectory}) { Object.assign(this,{dir,spec,meta,bundle,exec,networkPollMs,fleetLockDirectory}); }
  async invoke(exe,args,{signal,timeoutMs=60000,cloud=false}={}) {
    // Do not pass the controller's API token or arbitrary environment to workload hooks.
    const env={PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',SSH_AUTH_SOCK:process.env.SSH_AUTH_SOCK};
    if (cloud) {
      env.DIGITALOCEAN_TOKEN=process.env.DIGITALOCEAN_TOKEN;
      env.DIGITALOCEAN_ACCESS_TOKEN=process.env.DIGITALOCEAN_TOKEN;
    }
    try {
      const result=await this.exec(exe,args,{cwd:path.join(this.dir,'infra'),env,signal,timeoutMs});
      return result.stdout;
    } catch(e) {
      // Infrastructure may contain addresses; these private artifacts are never published automatically.
      const file=path.join(this.dir,'evidence',`command-error-${Date.now()}.log`);
      await fs.writeFile(file,(e.stdout || '')+'\n'+(e.stderr || ''),{mode:0o600});
      throw new Error(e.message);
    }
  }
  async provision({signal}={}) {
    return withFleetLock(()=>this.provisionUnderFleetLock({signal}),{directory:this.fleetLockDirectory});
  }
  async provisionUnderFleetLock({signal}={}) {
    const sizes=JSON.parse(await this.invoke('doctl',['compute','size','list','--output','json'],{cloud:true,signal}));
    if(!Array.isArray(sizes)) throw new Error('SIZE_CATALOG_INVALID');
    let estimated=0;
    const selected=[];
    for(const node of Object.values(nodes(this.spec))) {
      const row=sizes.find(s=>s.slug===node.size);
      if(!row || row.available!==true || !row.regions?.includes(this.spec.region) ||
          row.vcpus!==SIZES[node.size].vcpus || row.memory!==SIZES[node.size].memoryGiB*1024 ||
          !Number.isFinite(row.price_hourly) || row.price_hourly<=0) throw new Error('SIZE_UNAVAILABLE_OR_CHANGED');
      estimated+=Math.max(0.01,row.price_hourly*this.spec.maxMinutes/60);
      selected.push({slug:row.slug,priceHourlyUSD:row.price_hourly});
    }
    await save(path.join(this.dir,'evidence','pricing.json'),{checkedAt:new Date().toISOString(),selected,estimatedRuntimeUSD:estimated});
    if(estimated>this.spec.maxEstimatedUSD) throw new Error('LIVE_PRICE_EXCEEDS_ESTIMATE_CEILING');
    const existing=JSON.parse(await this.invoke('doctl',['compute','droplet','list','--output','json'],{cloud:true,signal}));
    const fleet=hourlyBudget(sizes,existing,Object.values(nodes(this.spec)));
    await save(path.join(this.dir,'evidence','fleet-budget.json'),{checkedAt:new Date().toISOString(),...fleet});
    await this.invoke('tofu',['init','-input=false','-lockfile=readonly','-no-color'],{cloud:true,signal,timeoutMs:180000});
    const plan=await this.invoke('tofu',['plan','-out=run.tfplan','-input=false','-no-color'],{cloud:true,signal,timeoutMs:180000});
    await fs.writeFile(path.join(this.dir,'evidence','plan.txt'),plan,{mode:0o600});
    const planned=JSON.parse(await this.invoke('tofu',['show','-json','run.tfplan'],{cloud:true,signal}));
    const allowed=new Set(['digitalocean_tag','digitalocean_droplet','digitalocean_firewall']);
    if(!planned.resource_changes?.length || planned.resource_changes.some(r=>!allowed.has(r.type) || r.change.actions.join(',')!=='create'))throw new Error('PLAN_OUTSIDE_EPHEMERAL_CREATE_SCOPE');
    const applied=await this.invoke('tofu',['apply','-input=false','-no-color','run.tfplan'],{cloud:true,signal,timeoutMs:600000});
    await fs.writeFile(path.join(this.dir,'evidence','apply.txt'),applied,{mode:0o600});
    const inventory=JSON.parse(await this.invoke('tofu',['output','-json','inventory'],{cloud:true,signal}));
    if (inventory.run_id!==this.meta.cloudId || Object.keys(inventory.nodes).length!==Object.keys(nodes(this.spec)).length) throw new Error('INVENTORY_MISMATCH');
    await save(path.join(this.dir,'evidence','provider-inventory.json'),inventory);
    await this.resolveInventory(inventory,{signal});
    await save(path.join(this.dir,'inventory.json'),inventory);
  }
  async resolveInventory(inventory,{signal}={}) {
    const ipv4=v=>typeof v==='string' && /^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every(n=>Number(n)<=255);
    for(let attempt=0;attempt<90;attempt++) {
      if(signal?.aborted)throw new Error('CANCELLED');
      const rows=JSON.parse(await this.invoke('doctl',['compute','droplet','list','--tag-name',this.meta.tag,'--output','json'],{cloud:true,signal}));
      if(!Array.isArray(rows))throw new Error('NETWORK_INVENTORY_INVALID');
      let ready=true;
      for(const [name,node] of Object.entries(inventory.nodes)) {
        const row=rows.find(r=>String(r.id)===String(node.id));
        if(!row){ready=false;continue;}
        if(row.name!==this.meta.tag+'-'+name || !row.tags?.includes(this.meta.tag) || row.size_slug!==nodes(this.spec)[name]?.size)throw new Error('NETWORK_INVENTORY_OWNERSHIP_MISMATCH');
        const addresses=row.networks?.v4 || [];
        const publicIP=addresses.find(n=>n.type==='public')?.ip_address;
        const privateIP=addresses.find(n=>n.type==='private')?.ip_address;
        if(row.status!=='active' || !ipv4(publicIP) || !ipv4(privateIP)){ready=false;continue;}
        node.public_ipv4=publicIP;node.private_ipv4=privateIP;
      }
      if(ready)return inventory;
      await new Promise(resolve=>setTimeout(resolve,this.networkPollMs));
    }
    throw new Error('ACTIVE_NETWORK_INVENTORY_TIMEOUT');
  }
  async stage(stage,{signal,timeoutMs}={}) {
    if (![...stages(this.spec),'collect'].includes(stage)) throw new Error('UNKNOWN_STAGE');
    // Recheck the immutable manifest and every entrypoint before each execution.
    await checkBundle(this.bundle,this.spec.bundleSha256);
    const env={PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',SSH_AUTH_SOCK:process.env.SSH_AUTH_SOCK,
      PERF_RUN_DIR:this.dir,PERF_SPEC:path.join(this.dir,'spec.json'),PERF_INVENTORY:path.join(this.dir,'inventory.json'),
      PERF_EVIDENCE:path.join(this.dir,'evidence')};
    try {
      const result=await this.exec(process.execPath,[path.join(this.bundle,stage+'.mjs')],{cwd:this.bundle,env,signal,timeoutMs});
      await fs.writeFile(path.join(this.dir,'evidence',stage+'.log'),result.stdout+'\n'+result.stderr,{mode:0o600});
    } catch(e) {
      await fs.writeFile(path.join(this.dir,'evidence',stage+'.log'),(e.stdout || '')+'\n'+(e.stderr || ''),{mode:0o600});
      throw new Error(e.message);
    }
  }
  async collect() {
    // Preserve state/inventory even when apply failed before outputs were available.
    for (const name of ['terraform.tfstate','terraform.tfstate.backup']) {
      await fs.copyFile(path.join(this.dir,'infra',name),path.join(this.dir,'evidence',name)).catch(e=>{if(e.code!=='ENOENT')throw e;});
    }
    await this.stage('collect',{timeoutMs:60000});
  }
  async ownedDroplets() {
    const text=await this.invoke('doctl',['compute','droplet','list','--tag-name',this.meta.tag,'--output','json'],{cloud:true});
    const rows=JSON.parse(text);
    if (!Array.isArray(rows) || rows.some(r=>!r.tags?.includes(this.meta.tag) || !r.name?.startsWith(this.meta.tag+'-'))) throw new Error('CLEANUP_OWNERSHIP_MISMATCH');
    return rows;
  }
  async ownedFirewalls() {
    const rows=JSON.parse(await this.invoke('doctl',['compute','firewall','list','--output','json'],{cloud:true}));
    if (!Array.isArray(rows)) throw new Error('FIREWALL_INVENTORY_INVALID');
    return rows.filter(r=>r.name===this.meta.tag);
  }
  async destroy() {
    // Try stateful destroy first. Tag/name recovery covers interrupted apply with unrecorded resources.
    let tofuFailure;
    try { await this.invoke('tofu',['destroy','-auto-approve','-input=false','-no-color'],{cloud:true,timeoutMs:180000}); }
    catch(e) { tofuFailure=e; }
    for (const row of await this.ownedFirewalls()) await this.invoke('doctl',['compute','firewall','delete',String(row.id),'--force'],{cloud:true});
    for (const row of await this.ownedDroplets()) await this.invoke('doctl',['compute','droplet','delete',String(row.id),'--force'],{cloud:true});
    // Terraform owns the run tag; an interrupted apply may leave it after other resources are gone.
    const tags=JSON.parse(await this.invoke('doctl',['compute','tag','list','--output','json'],{cloud:true}));
    if (tags.some(t=>t.name===this.meta.tag)) await this.invoke('doctl',['compute','tag','delete',this.meta.tag,'--force'],{cloud:true});
    if (tofuFailure) await fs.writeFile(path.join(this.dir,'evidence','destroy-fallback.txt'),'Stateful destroy failed; exact run ownership fallback attempted.\n',{mode:0o600});
  }
  async verify() {
    const droplets=await this.ownedDroplets(),firewalls=await this.ownedFirewalls();
    if (droplets.length || firewalls.length) throw new Error('RESOURCES_REMAIN');
  }
}
module.exports={Simulated,DigitalOcean,command,checkBundle,STAGES,stages,save,json};
