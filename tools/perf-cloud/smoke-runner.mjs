import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
const here=path.dirname(new URL(import.meta.url).pathname);
const quote=v=>"'"+String(v).replaceAll("'","'\\''")+"'";
export function exec(exe,args,{timeoutMs=300000}={}) {
  return new Promise((resolve,reject)=>{
    const p=spawn(exe,args,{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
    const timer=setTimeout(()=>p.kill('SIGTERM'),timeoutMs);
    p.stdout.on('data',c=>stdout+=c);p.stderr.on('data',c=>stderr+=c);
    p.on('error',e=>{clearTimeout(timer);reject(e);});
    p.on('close',code=>{clearTimeout(timer);code===0?resolve(stdout):reject(new Error(`${exe} exit ${code}: ${stderr.slice(-3000)} ${stdout.slice(-3000)}`));});
  });
}
export async function captureCheckpoints({ssh,copy,evidence,seen}) {
  const listing=await ssh('find /opt/nsperf/work -maxdepth 1 -type f -name "checkpoint-level*.tar.gz" -printf "%f\\n" 2>/dev/null || true',15000);
  for(const name of listing.trim().split('\n').filter(Boolean)) {
    if(!/^checkpoint-level[1-5]\.tar\.gz$/.test(name))throw new Error('UNSAFE_CHECKPOINT_NAME');
    if(seen.has(name))continue;
    const target=path.join(evidence,name);
    const remotePath='/opt/nsperf/work/'+name;
    const digestLine=(await ssh('sha256sum '+remotePath,15000)).trim();
    const expected=digestLine.match(/^([a-f0-9]{64})  (\S+)$/);
    if(!expected || expected[2]!==remotePath)throw new Error('CHECKPOINT_DIGEST_INVALID');
    await copy('/opt/nsperf/work/'+name,target+'.partial');
    const digest=createHash('sha256');
    for await(const chunk of createReadStream(target+'.partial'))digest.update(chunk);
    if(digest.digest('hex')!==expected[1])throw new Error('CHECKPOINT_DIGEST_MISMATCH');
    const file=await fs.open(target+'.partial','r+');try{await file.sync();}finally{await file.close();}
    await fs.rename(target+'.partial',target);
    const directory=await fs.open(evidence,'r');try{await directory.sync();}finally{await directory.close();}
    await ssh('sudo -n touch /opt/nsperf/work/'+name.replace('.tar.gz','.ack'),15000);
    seen.add(name);
  }
}
export async function run(stage) {
  const spec=JSON.parse(await fs.readFile(process.env.PERF_SPEC));
  const joined=spec.profile==='joined-diagnostic-v1';
  const pilot=['joined-pilot-v1','joined-baseline-diagnostic-v1'].includes(spec.profile);
  const cacheTests=spec.profile==='cache-diagnostic-v1';
  const coreTests=spec.profile==='core-acceptance-v1';
  const managed=joined||pilot||cacheTests||coreTests;
  const evidence=process.env.PERF_EVIDENCE;
  const inventory=await fs.readFile(process.env.PERF_INVENTORY,'utf8').then(JSON.parse).catch(()=>null);
  if(!inventory) {if(stage==='collect'){await fs.writeFile(path.join(evidence,'remote-collection-unavailable.txt'),'Provisioning did not produce inventory.\n');return;}throw new Error('REMOTE_INVENTORY_MISSING');}
  const node=inventory.nodes['app-0'];
  if(!node || !/^\d{1,3}(\.\d{1,3}){3}$/.test(node.public_ipv4) || !/^[a-z][a-z0-9-]+$/.test(inventory.run_id))throw new Error('REMOTE_INVENTORY_INVALID');
  const host=(spec.sshUser || 'root')+'@'+node.public_ipv4;
  const opts=['-o','BatchMode=yes','-o','ConnectTimeout=10','-o','StrictHostKeyChecking=accept-new','-o','UserKnownHostsFile='+path.join(process.env.PERF_RUN_DIR,'known_hosts')];
  if(spec.sshIdentityFile)opts.push('-i',spec.sshIdentityFile,'-o','IdentitiesOnly=yes');
  const ssh=(cmd,timeoutMs)=>exec('ssh',[...opts,host,cmd],{timeoutMs});
  const privileged=cmd=>spec.sshUser && spec.sshUser!=='root'?'sudo -n bash -c '+quote(cmd):cmd;
  if(stage==='deploy') {
    let ready=false;
    for(let i=0;i<90;i++){try{await ssh('true',15000);ready=true;break;}catch{await new Promise(r=>setTimeout(r,2000));}}
    if(!ready)throw new Error('REMOTE_SSH_NOT_READY');
    await ssh('sudo -n install -d -m 711 -o "$(id -u)" -g "$(id -g)" /opt/nsperf; sudo -n install -d -m 700 -o "$(id -u)" -g "$(id -g)" /opt/nsperf/logs /opt/nsperf/input');
    const config={...spec,cloudId:inventory.run_id};
    const file=path.join(process.env.PERF_RUN_DIR,'remote-spec.json');await fs.writeFile(file,JSON.stringify(config),{mode:0o600});
    const payload=managed?Object.keys(JSON.parse(await fs.readFile(path.join(here,'manifest.json'),'utf8')).files):['core.pack','deploy.pack','alignment.tar','remote-smoke.sh',...(spec.profile==='colocated-capacity-v1'?['remote-capacity.sh','capacity-assess.cjs']:['smoke-assert.cjs'])];
    for(const source of payload){if(!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source))throw new Error('REMOTE_PAYLOAD_NAME_INVALID');await exec('scp',[...opts,path.join(here,source),host+':/opt/nsperf/input/'+source]);}
    await exec('scp',[...opts,file,host+':/opt/nsperf/input/spec.json']);
  }
  if(stage==='collect') {
    const errors=[];
    try{await ssh(privileged('timeout 25 bash /opt/nsperf/input/'+(cacheTests?'remote-cache-tests.sh':coreTests?'remote-core-tests.sh':pilot?'remote-pilot.sh':joined?'remote-joined.sh':'remote-smoke.sh')+' collect > /opt/nsperf/logs/collect.log 2>&1'),30000);
      if(spec.sshUser && spec.sshUser!=='root')await ssh('sudo -n chown "$(id -u):$(id -g)" /opt/nsperf/evidence.tar.gz');
    }catch(e){errors.push(e.message);}
    try{await exec('scp',[...opts,host+':/opt/nsperf/evidence.tar.gz',path.join(evidence,'remote-evidence.tar.gz')],{timeoutMs:25000});}catch(e){errors.push(e.message);}
    if(errors.length){await fs.writeFile(path.join(evidence,'remote-collection-errors.json'),JSON.stringify(errors));throw new Error('REMOTE_COLLECTION_INCOMPLETE');}
    return;
  }
  // Every stage is bounded remotely even if the SSH connection disappears.
  const capacity=['colocated-capacity-v1','joined-diagnostic-v1','joined-pilot-v1','joined-baseline-diagnostic-v1','cache-diagnostic-v1','core-acceptance-v1'].includes(spec.profile) && stage==='campaign';
  const seconds=capacity?spec.maxMinutes*60:3000;
  const script=cacheTests?'remote-cache-tests.sh':coreTests?'remote-core-tests.sh':pilot?'remote-pilot.sh':joined?'remote-joined.sh':capacity?'remote-capacity.sh':'remote-smoke.sh';
  const operation=ssh(privileged(`timeout ${seconds} bash /opt/nsperf/input/${script} ${quote(stage)} > /opt/nsperf/logs/${stage}.log 2>&1; rc=$?; tail -n 12 /opt/nsperf/logs/${stage}.log; exit "$rc"`),(seconds+100)*1000);
  if(!capacity){await operation;return;}
  const seen=new Set(),errors=[];let finished=false;
  const checkpoint=()=>captureCheckpoints({ssh,copy:(source,target)=>exec('scp',[...opts,host+':'+source,target],{timeoutMs:60000}),evidence,seen});
  const monitor=(async()=>{while(!finished){try{await checkpoint();}catch(e){errors.push(e.message);if(errors.length>10)errors.shift();}if(!finished)await new Promise(r=>setTimeout(r,10000));}})();
  try {await operation;} finally {
    finished=true;await monitor;
    try{await checkpoint();}catch(e){errors.push(e.message);}
    await fs.writeFile(path.join(evidence,'checkpoint-status.json'),JSON.stringify({delivered:[...seen],errors},null,2)+'\n',{mode:0o600});
  }
}
