'use strict';
// Native filesystem/flock/process proof with an instrumented Docker protocol and
// simulated publisher fence/readiness. Actual Docker/PG publication is a joined
// acceptance responsibility; these tests never assert those mocked boundaries.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const j = require('./replacement-journal'), operator = require('./replace-realtime'), workers = require('./realtime-workers');
const hash = () => crypto.randomBytes(32).toString('hex');
function live(pid) { try { return !['Z','X'].includes(fs.readFileSync('/proc/'+pid+'/stat','utf8').split(')')[1].trim().split(' ')[0]); } catch { return false; } }
function processStart() { const p = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); p.unref(); return p; }
function fixture() {
  const state = fs.mkdtempSync(path.join(os.tmpdir(),'ns-replacement-recovery-')); fs.chmodSync(state,0o700);
  for (const dir of ['bootstrap','placement','realtime']) fs.mkdirSync(path.join(state,dir),{mode:0o700});
  const complete = {sourceCommit:'a'.repeat(40),deployCommit:'b'.repeat(40)}, before=workers.initial({workers:2,shards:8});
  const write = (file,value) => j.atomicJson(path.join(state,file),value,true);
  write('bootstrap/complete.json',complete);write('placement/backend.json',before);write('placement/routes.json',before);
  write('realtime/env.json',{REALTIME_WORKER_ID:'realtime-1',REALTIME_WORKER_INCARNATION:before.workers[0].incarnation});
  const compose=path.join(state,'compose.yaml');fs.writeFileSync(compose,'services: {}\n');fs.writeFileSync(path.join(state,'.env'),'FIXTURE=1\n');
  const options={state,compose:[compose],project:'ns-owned-recovery-test',worker:'realtime-1',timeout:1000};
  const processes=[],image='sha256:'+hash(),rows=new Map();let current,stopWorks=true;
  function row(labels={}) { return {Id:hash(),Image:image,Config:{Labels:{'com.docker.compose.project':options.project,'com.docker.compose.service':'realtime',...labels}},HostConfig:{RestartPolicy:{Name:'no'}},State:{Running:false,Pid:0,StartedAt:'0001-01-01T00:00:00Z'}}; }
  function start(r) { const p=processStart();processes.push(p);r.State={Running:true,Pid:p.pid,StartedAt:new Date().toISOString()}; }
  const original=row();start(original);rows.set(original.Id,original);current=original.Id;
  function inspect(id) { const r=rows.get(id);assert.ok(r,'known simulated container');if(r.State.Running&&!live(r.State.Pid)){r.State.Running=false;r.State.Pid=0;}return structuredClone(r); }
  const docker=args=>{
    if(args[0]==='ps')return '';
    if(args[0]==='inspect')return JSON.stringify([inspect(args[1])]);
    if(args[0]==='image')return JSON.stringify([{Id:image,Config:{Labels:{'org.opencontainers.image.revision':complete.sourceCommit,'org.nightscout.deploy.revision':complete.deployCommit}}}]);
    if(args[0]==='stop') { const r=rows.get(args.at(-1));assert.ok(r);if(stopWorks&&r.State.Running){process.kill(r.State.Pid,'SIGKILL');for(let n=0;n<100&&live(r.State.Pid);n++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);assert.equal(live(r.State.Pid),false,'actual old OS process terminated');r.State.Running=false;r.State.Pid=0;}return r.Id; }
    if(args[0]==='start'){start(rows.get(args[1]));return args[1];}
    if(args.includes('config'))return JSON.stringify({services:{demo:{image},realtime:{image}}});
    if(args.includes('ps'))return current;
    if(args.includes('--no-start')){const file=args[args.lastIndexOf('-f')+1];const labels=j.privateJson(file).services.realtime.labels;const r=row(labels);rows.set(r.Id,r);current=r.Id;return '';}
    throw Error('UNIMPLEMENTED_DOCKER:'+args.join(' '));
  };
  const publisher=async({candidate,action})=>{
    const owner=candidate.transition.stopped[0];
    // Product's actual PostgreSQL fence is deliberately not modeled as proof.
    if(!await action({name:'confirm',owner}))await action({name:'stop',owner});
    if(!await action({name:'confirm',owner}))throw Object.assign(Error('OLD_OWNER_UNCONFIRMED'),{code:'REALTIME_PLACEMENT_OLD_OWNER_UNCONFIRMED'});
    write('placement/backend.json',candidate);
    if(!await action({name:'activate',owner:{}}))throw Error('ACTIVATION_REFUSED');
    assert.equal(inspect(current).State.Running,true);assert.equal(j.privateJson(path.join(state,'realtime/env.json')).REALTIME_WORKER_INCARNATION,candidate.workers[0].incarnation);
    write('placement/routes.json',candidate);return {generation:candidate.generation};
  };
  return {state,options,before,docker,publisher,rows,original,get current(){return rows.get(current)},get journal(){return j.privateJson(path.join(state,'placement/operation.json'))},write,
    stopRefuses(){stopWorks=false},close(){for(const p of processes)try{process.kill(p.pid,'SIGKILL')}catch{}fs.rmSync(state,{recursive:true,force:true});}};
}
for(const fault of ['before-stop','after-stop','after-assignment','after-env','after-create-effect','after-create','after-start-effect','after-start','after-routes'])test('explicit fresh-generation recovery after '+fault,async()=>{
  const f=fixture();try{
    const hooks={docker:f.docker,publisher:async args=>{const result=await f.publisher(args);if(fault==='after-routes')throw Error('SYNTHETIC_CRASH:'+fault);return result},checkpoint:async phase=>{if(phase===fault)throw Error('SYNTHETIC_CRASH:'+fault)}};
    await assert.rejects(operator.replace(f.options,hooks),/SYNTHETIC_CRASH/);
    const interrupted=f.journal,backend=j.privateJson(path.join(f.state,'placement/backend.json'));
    assert.equal(interrupted.phase==='complete',false);
    await assert.rejects(operator.replace(f.options,{docker:f.docker,publisher:f.publisher}),/RECOVERY_REQUIRED/);
    const result=await operator.replace({...f.options,recover:true},{docker:f.docker,publisher:f.publisher});
    const final=j.privateJson(path.join(f.state,'placement/backend.json'));
    assert.equal(result.generation,backend.generation+1);assert.deepEqual(final,j.privateJson(path.join(f.state,'placement/routes.json')));
    assert.notEqual(final.workers[0].incarnation,interrupted.newIncarnation);assert.notEqual(final.workers[0].incarnation,f.before.workers[0].incarnation);
    assert.equal(f.journal.phase,'complete');assert.equal(live(f.current.State.Pid),true);
    assert.equal(fs.statSync(path.join(f.state,'placement/operation.json')).mode&0o777,0o600);
  }finally{f.close();}
});
test('no-stop confirmation refuses before backend generation can advance',async()=>{
  const f=fixture();try{f.stopRefuses();await assert.rejects(operator.replace(f.options,{docker:f.docker,publisher:f.publisher}),/OLD_OWNER_UNCONFIRMED/);assert.equal(j.privateJson(path.join(f.state,'placement/backend.json')).generation,1);assert.equal(live(f.original.State.Pid),true);}finally{f.close();}
});
for(const mutation of ['project','image','startedAt','pid','container','env','backend','compose'])test('recovery refuses mutated '+mutation,async()=>{
  const f=fixture();try{
    await assert.rejects(operator.replace(f.options,{docker:f.docker,publisher:f.publisher,checkpoint:async p=>{if(p==='before-stop')throw Error('CRASH')}}),/CRASH/);
    if(mutation==='project')f.original.Config.Labels['com.docker.compose.project']='foreign';
    if(mutation==='image')f.original.Image='sha256:'+hash();
    if(mutation==='startedAt')f.original.State.StartedAt='2099-01-01T00:00:00Z';
    if(mutation==='pid')f.original.State.Pid=process.pid;
    if(mutation==='container')f.original.Id=hash();
    if(mutation==='env')f.write('realtime/env.json',{REALTIME_WORKER_ID:'realtime-2'});
    if(mutation==='backend')f.write('placement/backend.json',{...f.before,generation:99});
    if(mutation==='compose')fs.appendFileSync(f.options.compose[0],'# mutation');
    await assert.rejects(operator.replace({...f.options,recover:true},{docker:f.docker,publisher:f.publisher}),/PLACEMENT_/);
    assert.equal(j.privateJson(path.join(f.state,'placement/routes.json')).generation,1);
  }finally{f.close();}
});
test('native FD lock rejects concurrent operation and releases after last close',async()=>{
  const f=fixture();try{await j.locked(f.state,async()=>{assert.throws(()=>execFileSync('flock',['-n',path.join(f.state,'placement/operation.lock'),'true']),error=>error.status===1)});execFileSync('flock',['-n',path.join(f.state,'placement/operation.lock'),'true']);}finally{f.close();}
});

test('crashed host leaves creator FD locked until the actual inherited child exits',async()=>{
  const f=fixture();let host,creator;try{
    const helper=path.join(f.state,'lock-host.cjs');
    fs.writeFileSync(helper,`const {locked}=require(${JSON.stringify(path.join(__dirname,'replacement-journal'))});const {spawn}=require('child_process');
locked(process.argv[2],async fd=>{const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore',fd]});console.log(c.pid);await new Promise(()=>{});});setInterval(()=>{},1000);`);
    host=spawn(process.execPath,[helper,f.state],{stdio:['ignore','pipe','ignore']});
    creator=Number(await new Promise((resolve,reject)=>{host.stdout.once('data',bytes=>resolve(bytes.toString().trim()));host.once('error',reject)}));
    assert.ok(creator>0);const died=new Promise(resolve=>host.once('exit',resolve));host.kill('SIGKILL');await died;
    assert.equal(live(creator),true);
    assert.throws(()=>execFileSync('flock',['-n',path.join(f.state,'placement/operation.lock'),'true']),error=>error.status===1);
    process.kill(creator,'SIGKILL');for(let n=0;n<100&&live(creator);n++)await new Promise(resolve=>setTimeout(resolve,5));
    execFileSync('flock',['-n',path.join(f.state,'placement/operation.lock'),'true']);
  }finally{if(host)host.kill('SIGKILL');if(creator)try{process.kill(creator,'SIGKILL')}catch{}f.close();}
});
