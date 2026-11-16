import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createRequire} from 'node:module';
const {TRAFFIC_FILES}=createRequire(import.meta.url)('./external-contract.cjs');
import {exec as execute} from './smoke-runner.mjs';

const quote=v=>"'"+String(v).replaceAll("'","'\\''")+"'";
const fail=code=>{throw new Error(code);};
const allowedEvents=new Set(['app-ready','client-primed','load-ready','load-complete','restart-ready','restart-armed','restart-done','server-recovery-complete','client-complete','cell-complete']);
export function checkMessage(row,b,node,sequence,kind){
  if(!row||JSON.stringify(Object.keys(row).sort())!==JSON.stringify(['version','runId','nonce','cell','node','sequence','kind','payload'].sort())||row.version!==1||row.runId!==b.runId||row.nonce!==b.nonce||row.cell!==b.cell||row.node!==node||row.sequence!==sequence||!Number.isInteger(row.sequence)||row.kind!==kind||!allowedEvents.has(kind)||!row.payload||typeof row.payload!=='object'||Array.isArray(row.payload))fail('EXTERNAL_MESSAGE_BINDING_OR_ORDER');
  return row.payload;
}
const diagnosticCodes=new Set(['EXTERNAL_MESSAGE_BOUND','EXTERNAL_MESSAGE_BINDING_OR_ORDER','EXTERNAL_UNREQUESTED_PHASE','EXTERNAL_TRAILING_PHASE_DATA','EXTERNAL_REMOTE_SESSION_FAILED','EXTERNAL_PHASE_EOF','EXTERNAL_PHASE_WAIT_OVERLAP','EXTERNAL_DEADLINE','EXTERNAL_HANDSHAKE_TIMEOUT']);
export class Session {
  constructor(child,b,node,log,now=Date.now,diagnostics=()=>{}){
    this.child=child;this.binding=b;this.node=node;this.inSequence=0;this.outSequence=0;this.queue=[];this.waiting=null;this.failure=null;this.now=now;
    this.diagnosticsCount=0;this.diagnostics=diagnostics;this.diagnostic('session-start');
    this.finished=new Promise((resolve,reject)=>{this.resolveExit=resolve;this.rejectExit=reject;});
    // A rejection is observed when finishing the session, and also fails any
    // pending phase immediately. It must not become an unhandled rejection.
    this.finished.catch(()=>{});
    child.stderr.on('data',chunk=>{this.diagnostic('stderr-chunk',{bytes:chunk.length});log.write(chunk);});
    this.buffer=Buffer.alloc(0);
    child.stdout.on('data',chunk=>{
      try {
        this.diagnostic('stdout-chunk',{bytes:chunk.length});
        this.buffer=Buffer.concat([this.buffer,chunk]);
        while(this.buffer.includes(10)){
          const at=this.buffer.indexOf(10);if(at>65535)fail('EXTERNAL_MESSAGE_BOUND');
          const row=JSON.parse(this.buffer.subarray(0,at).toString('utf8'));this.buffer=this.buffer.subarray(at+1);
          this.diagnostic('stdout-frame',{bytes:at,kind:allowedEvents.has(row?.kind)?row.kind:'UNRECOGNIZED',sequence:Number.isSafeInteger(row?.sequence)&&row.sequence>0&&row.sequence<=65536?row.sequence:null});
          if(this.waiting){const pending=this.waiting;const payload=checkMessage(row,b,node,++this.inSequence,pending.kind);this.waiting=null;clearTimeout(pending.timer);pending.resolve(payload);}
          else{if(this.queue.length>=2)fail('EXTERNAL_UNREQUESTED_PHASE');this.queue.push(row);}
        }
        if(this.buffer.length>65535)fail('EXTERNAL_MESSAGE_BOUND');
      }catch(e){this.abort(e);}
    });
    child.stdin.on('error',e=>this.abort(e));
    child.on('error',e=>this.abort(e));
    child.on('close',code=>{this.diagnostic('child-close',{exitCode:Number.isInteger(code)?code:null});if(code===0&&(this.queue.length||this.buffer.length))return this.abort(new Error('EXTERNAL_TRAILING_PHASE_DATA'));if(code!==0)this.abort(new Error('EXTERNAL_REMOTE_SESSION_FAILED'));else{this.closed=true;this.resolveExit();if(this.waiting)this.abort(new Error('EXTERNAL_PHASE_EOF'));}});
  }
  diagnostic(event,detail={}){
    if(this.diagnosticsCount>256)return;
    const row={version:1,event:this.diagnosticsCount===256?'diagnostic-bound':event,index:this.diagnosticsCount++,atMs:this.now(),node:['app-0','generator-0'].includes(this.node)?this.node:'UNRECOGNIZED',expectedPhase:allowedEvents.has(this.waiting?.kind)?this.waiting.kind:null,bufferedBytes:this.buffer?.length??0,queuedFrames:this.queue?.length??0,...detail};
    try{this.diagnostics(row);}catch{this.diagnosticsFailure=true;}
  }
  abort(error){if(this.failure)return;this.diagnostic('session-abort',{code:diagnosticCodes.has(error.message)?error.message:'EXTERNAL_SESSION_PARSE_OR_IO_FAILED'});this.failure=error;if(this.waiting){clearTimeout(this.waiting.timer);this.waiting.reject(error);this.waiting=null;}this.rejectExit(error);this.child.stdin.end();this.child.kill('SIGTERM');}
  next(kind,ms=1800000){
    this.diagnostic('phase-wait',{kind:allowedEvents.has(kind)?kind:'UNRECOGNIZED'});
    if(this.failure)return Promise.reject(this.failure);
    if(this.waiting)return Promise.reject(new Error('EXTERNAL_PHASE_WAIT_OVERLAP'));
    if(this.queue.length){try{return Promise.resolve(checkMessage(this.queue.shift(),this.binding,this.node,++this.inSequence,kind));}catch(e){this.abort(e);return Promise.reject(e);}}
    if(this.closed)return Promise.reject(new Error('EXTERNAL_PHASE_EOF'));
    const timeout=Math.min(ms,this.binding.expiresAt*1000-this.now()-540000);
    if(timeout<=0)return Promise.reject(new Error('EXTERNAL_DEADLINE'));
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>this.abort(new Error('EXTERNAL_HANDSHAKE_TIMEOUT')),timeout);this.waiting={kind,resolve,reject,timer};});
  }
  send(kind,payload={}){this.diagnostic('controller-send',{kind:['case-start','client-primed','load-start','load-complete','finish','restart-prepare','restart-done'].includes(kind)?kind:'UNRECOGNIZED'});if(this.failure)throw this.failure;const row={version:1,runId:this.binding.runId,nonce:this.binding.nonce,cell:this.binding.cell,node:'controller',sequence:++this.outSequence,kind,payload};const text=JSON.stringify(row);if(Buffer.byteLength(text)>65536)fail('EXTERNAL_MESSAGE_BOUND');this.child.stdin.write(text+'\n');}
  async finish(){if(this.failure)throw this.failure;if(this.queue.length||this.buffer.length){const error=new Error('EXTERNAL_TRAILING_PHASE_DATA');this.abort(error);throw error;}this.child.stdin.end();await this.finished;if(this.failure)throw this.failure;}
}

export function inventoryNodes(inventory){
  if(!inventory||JSON.stringify(Object.keys(inventory.nodes||{}).sort())!==JSON.stringify(['app-0','generator-0'])||!/^[-a-z0-9]+$/.test(inventory.run_id))fail('EXTERNAL_NODE_ROSTER');
  for(const [key,node]of Object.entries(inventory.nodes))if(node.role!==(key==='app-0'?'app':'generator')||!/^\d{1,3}(\.\d{1,3}){3}$/.test(node.public_ipv4)||!/^\d{1,3}(\.\d{1,3}){3}$/.test(node.private_ipv4))fail('EXTERNAL_NODE_ADDRESS');
  return inventory.nodes;
}
export function trafficTransfer(descriptor,b){if(!descriptor||!isDeepStrictEqual(descriptor.binding,b)||!isDeepStrictEqual(Object.keys(descriptor.files||{}).sort(),TRAFFIC_FILES)||Object.values(descriptor.files).some(value=>typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)))fail('EXTERNAL_TRAFFIC_TRANSFER_INTERFACE');return Object.keys(descriptor.files).sort();}
export async function collectAll(nodes,collect){const results=await Promise.allSettled(Object.keys(nodes).map(node=>collect(node)));const errors=results.flatMap((result,index)=>result.status==='rejected'?[{node:Object.keys(nodes)[index],error:result.reason.message}]:[]);if(errors.length)throw Object.assign(new Error('EXTERNAL_PARTIAL_COLLECTION'),{errors});}
// Leave ten seconds below the generic driver's sixty-second collection ceiling.
// Both attempts share the same host budget; a failed collector can still leave a
// useful partial archive, which must be copied before reporting the failure.
export async function collectNode(collect,copy,now=Date.now,budget=50000){
  const deadline=now()+budget,errors=[];
  try{await collect(Math.min(20000,Math.max(1,deadline-now())));}catch(error){errors.push(error);}
  try{await copy(Math.max(1,deadline-now()));}catch(error){errors.push(error);}
  if(errors.length)throw Object.assign(new Error('EXTERNAL_NODE_COLLECTION_INCOMPLETE'),{errors});
}
export function boundedExec(exe,args,{timeoutMs}){
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{stdio:['ignore','pipe','pipe'],detached:true});let stdout='',failure=null,kill;
    const signal=value=>{try{process.kill(-child.pid,value);}catch(error){if(error.code!=='ESRCH')throw error;}};
    const abort=code=>{if(failure)return;failure=code;signal('SIGTERM');kill=setTimeout(()=>signal('SIGKILL'),500);};
    child.stdout.on('data',chunk=>{if(failure)return;if(Buffer.byteLength(stdout)+chunk.length>65536)abort('EXTERNAL_COLLECTION_OUTPUT_BOUND');else stdout+=chunk;});child.stderr.resume();
    const timer=setTimeout(()=>abort('EXTERNAL_COLLECTION_TIMEOUT'),timeoutMs);
    child.on('error',error=>{clearTimeout(timer);clearTimeout(kill);reject(error);});
    child.on('close',code=>{clearTimeout(timer);clearTimeout(kill);if(failure||code!==0)reject(new Error(failure||'EXTERNAL_COLLECTION_COMMAND_FAILED'));else resolve(stdout);});
  });
}
const isLargePayload=name=>/\.(pack|tar)$/.test(name);
export function deployPayload(manifest,node){
  const allowed=['remote-external-generator.sh','external-setup.py','pilot-ledger.py','pilot-docker-store.py','alignment.pack'];
  const names=Object.keys(manifest.files).filter(name=>node==='app-0'||allowed.includes(name));
  return names.sort((a,b)=>Number(isLargePayload(a))-Number(isLargePayload(b)));
}

export async function coordinate(app,startGenerator,transfer){
  await app.next('app-ready');
  const gen=await startGenerator();
  const prime=await gen.next('client-primed',1800000);app.send('client-primed',prime);
  await app.next('load-ready');gen.send('load-start');
  await gen.next('load-complete',900000);app.send('load-complete');
  await app.next('restart-ready');gen.send('restart-prepare');
  await gen.next('restart-armed',180000);app.send('restart-armed');
  const done=await app.next('restart-done',180000);gen.send('restart-done',done);
  await Promise.all([app.next('server-recovery-complete',1000000),gen.next('client-complete',1500000)]);
  await transfer();app.send('finish');
  const result=await app.next('cell-complete',180000);if(result.verdict!=='PASS')fail('EXTERNAL_CELL_NONPASS');
  gen.send('finish');await Promise.all([app.finish(),gen.finish()]);
  return result;
}

export async function run(stage){
  const spec=JSON.parse(await fs.readFile(process.env.PERF_SPEC));
  if(spec.profile!=='joined-external-generator-v1')fail('EXTERNAL_PROFILE');
  const inventory=JSON.parse(await fs.readFile(process.env.PERF_INVENTORY));
  const nodes=inventoryNodes(inventory),runDirectory=process.env.PERF_RUN_DIR,evidence=process.env.PERF_EVIDENCE;
  const here=path.dirname(new URL(import.meta.url).pathname),opts=['-o','BatchMode=yes','-o','ConnectTimeout=10','-o','StrictHostKeyChecking=accept-new','-o','UserKnownHostsFile='+path.join(runDirectory,'known_hosts'),'-i',spec.sshIdentityFile,'-o','IdentitiesOnly=yes'];
  const host=node=>(spec.sshUser||'root')+'@'+nodes[node].public_ipv4;
  const ssh=(node,cmd,ms=120000)=>execute('ssh',[...opts,host(node),cmd],{timeoutMs:ms});
  const script=node=>node==='app-0'?'remote-external-app.sh':'remote-external-generator.sh';
  const action=(node,verb,index,ms=120000)=>ssh(node,'sudo -n bash /opt/nsperf/input/'+script(node)+' '+quote(verb)+(index?' '+index:''),ms);
  const put=(node,source,target)=>execute('scp',[...opts,source,host(node)+':'+target],{timeoutMs:120000});
  const get=(node,source,target)=>execute('scp',[...opts,host(node)+':'+source,target],{timeoutMs:120000});
  if(stage==='deploy'){
    const manifest=JSON.parse(await fs.readFile(path.join(here,'manifest.json')));
    for(const node of Object.keys(nodes)){
      let ready=false;for(let n=0;n<90;n++){try{await ssh(node,'true',15000);ready=true;break;}catch{await new Promise(r=>setTimeout(r,2000));}}
      if(!ready)fail('EXTERNAL_SSH_NOT_READY');
      await ssh(node,'sudo -n install -d -m 711 -o "$(id -u)" -g "$(id -g)" /opt/nsperf; install -d -m 700 /opt/nsperf/input /opt/nsperf/logs');
      const remote=path.join(runDirectory,node+'-spec.private.json');await fs.writeFile(remote,JSON.stringify({...spec,cloudId:inventory.run_id}),{mode:0o600});await put(node,remote,'/opt/nsperf/input/spec.json');
      const selected=deployPayload(manifest,node).filter(name=>!isLargePayload(name));
      for(const name of selected){if(!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))fail('EXTERNAL_PAYLOAD_NAME');await put(node,path.join(here,name),'/opt/nsperf/input/'+name);}
    }
    // Both collectors are installed before any large transfer or bootstrap.
    for(const node of Object.keys(nodes)){
      for(const name of deployPayload(manifest,node).filter(isLargePayload))await put(node,path.join(here,name),'/opt/nsperf/input/'+name);
      await action(node,'deploy',null,3600000);
    }
    return;
  }
  if(stage==='collect'){
    await collectAll(nodes,node=>collectNode(ms=>boundedExec('ssh',[...opts,host(node),'sudo -n bash /opt/nsperf/input/'+script(node)+' collect'],{timeoutMs:ms}),ms=>boundedExec('scp',[...opts,host(node)+':/opt/nsperf/evidence.tar.gz',path.join(evidence,node+'-evidence.tar.gz')],{timeoutMs:ms})));
    return;
  }
  if(stage!=='campaign')fail('EXTERNAL_STAGE');
  const metadata=JSON.parse(await fs.readFile(path.join(runDirectory,'run.json')));
  const descriptor=JSON.parse(await fs.readFile(path.join(here,'external-source.json')));
  const identity=JSON.parse(await fs.readFile(path.join(here,'pilot-native-identity.json')));
  const cells=[];
  for(let i=1;i<=spec.capacityLevels.length;i++){
    const record={cell:i,tenants:spec.capacityLevels[i-1],status:'FAIL'};let app,gen;const logs=[];
    try{
      await action('app-0','prepare',i,1200000);
      const port=JSON.parse((await action('app-0','port',i)).trim()).port;
      const b={version:1,profile:spec.profile,runId:spec.runId,cloudId:inventory.run_id,nonce:randomBytes(16).toString('hex'),cell:i,tenants:spec.capacityLevels[i-1],appAddress:nodes['app-0'].private_ipv4,generatorAddress:nodes['generator-0'].private_ipv4,port,expiresAt:metadata.expiresAt/1000,pair:{core:spec.coreCommit,deploy:spec.deployCommit},imageId:identity.imageId,k6Image:spec.k6Image,sourceSha256:descriptor.sha256};
      const local=path.join(runDirectory,'external-level'+i);await fs.mkdir(local,{mode:0o700});const binding=path.join(local,'binding.json');await fs.writeFile(binding,JSON.stringify(b),{mode:0o600});for(const node of Object.keys(nodes))await put(node,binding,'/opt/nsperf/input/external-cell.json');
      await action('app-0','deploy-cell',i,2400000);
      const traffic='/opt/nsperf/traffic-level'+i;await ssh('generator-0','install -d -m 700 '+traffic);
      const trafficDescriptor=path.join(local,'traffic.json');await get('app-0','/opt/nsperf/work/level'+i+'-pilot/traffic-export/traffic.json',trafficDescriptor);
      const trafficNames=trafficTransfer(JSON.parse(await fs.readFile(trafficDescriptor)),b);await put('generator-0',trafficDescriptor,traffic+'/traffic.json');
      for(const name of trafficNames){const file=path.join(local,name);await get('app-0','/opt/nsperf/work/level'+i+'-pilot/traffic-export/'+name,file);await put('generator-0',file,traffic+'/'+name);}
      const start=node=>{const logPath=path.join(local,node+'-session.log');const log=fs.open(logPath,'w',0o600).then(handle=>handle.createWriteStream());return log.then(stream=>{logs.push(stream);const child=spawn('ssh',[...opts,host(node),'sudo -n bash /opt/nsperf/input/'+script(node)+' session '+i],{stdio:['pipe','pipe','pipe']});return new Session(child,b,node,stream);});};
      app=await start('app-0');
      await coordinate(app,async()=>{gen=await start('generator-0');return gen;},async()=>{
        await action('generator-0','client-export',i);const archive=path.join(local,'client.tar');
        await get('generator-0','/opt/nsperf/work/client-level'+i+'.tar',archive);
        await put('app-0',archive,'/opt/nsperf/work/client-level'+i+'.tar');await action('app-0','client-import',i);
      });record.status='PASS';
    }catch(error){record.error=error.message;app?.abort(error);gen?.abort(error);throw error;}
    finally{for(const log of logs)log.end();try{await action('app-0','down',i,300000);}catch(e){record.status='FAIL';record.finalization=e.message;}cells.push(record);await fs.writeFile(path.join(evidence,'external-cells.json'),JSON.stringify(cells,null,2)+'\n',{mode:0o600});}
    if(record.status!=='PASS')fail('EXTERNAL_FINALIZATION_FAILED');
  }
}
