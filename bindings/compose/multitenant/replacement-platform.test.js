'use strict';
// Opt-in native Docker platform discriminator. One tiny owned project with at
// most two idle Node containers; product PostgreSQL publication/readiness is simulated, not accepted.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFileSync,spawn}=require('node:child_process');
const j=require('./replacement-journal'),operator=require('./replace-realtime'),workers=require('./realtime-workers');
const image=process.env.NS_REPLACEMENT_IMAGE,enabled=process.env.NS_REPLACEMENT_PLATFORM_NATIVE==='1';
const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}).trim();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const inspect=id=>JSON.parse(docker(['inspect',id]))[0];
function fixture(){
  assert.match(image||'',/^sha256:[a-f0-9]{64}$/,'immutable existing local image required');
  const spec=JSON.parse(docker(['image','inspect',image]))[0],pair=spec.Config.Labels;
  assert.match(pair['org.opencontainers.image.revision'],/^[a-f0-9]{40}$/);assert.match(pair['org.nightscout.deploy.revision'],/^[a-f0-9]{40}$/);
  const state=fs.mkdtempSync(path.join(os.tmpdir(),'ns-native-replacement-'));fs.chmodSync(state,0o700);
  for(const dir of ['bootstrap','placement','realtime'])fs.mkdirSync(path.join(state,dir),{mode:0o700});
  const write=(file,value)=>j.atomicJson(path.join(state,file),value,true),before=workers.initial({workers:2,shards:8});
  write('bootstrap/complete.json',{sourceCommit:pair['org.opencontainers.image.revision'],deployCommit:pair['org.nightscout.deploy.revision']});
  write('placement/backend.json',before);write('placement/routes.json',before);write('realtime/env.json',{REALTIME_WORKER_ID:'realtime-1',REALTIME_WORKER_INCARNATION:before.workers[0].incarnation});
  const project='ns-recovery-native-'+crypto.randomBytes(6).toString('hex'),compose=path.join(state,'compose.json');
  const service={image,restart:'no',command:['node','-e','process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)'],labels:{'org.nightscout.recovery.fixture':project}};
  fs.writeFileSync(compose,JSON.stringify({services:{demo:service,realtime:service}}));fs.writeFileSync(path.join(state,'.env'),'');
  const options={state,project,compose:[compose],worker:'realtime-1',timeout:1000},args=['compose','-p',project,'--env-file',path.join(state,'.env'),'-f',compose];
  const current=()=>docker([...args,'ps','--all','--quiet','realtime']);
  docker([...args,'up','-d','--no-build','--pull','never','--no-deps','realtime']);
  const publisher=async({candidate,action})=>{
    const owner=candidate.transition.stopped[0];if(!await action({name:'confirm',owner}))await action({name:'stop',owner});
    assert.equal(await action({name:'confirm',owner}),true);write('placement/backend.json',candidate);
    assert.equal(await action({name:'activate',owner:{}}),true);const row=inspect(current());assert.equal(row.State.Running,true);assert.ok(row.State.Pid>0);
    // This is only a platform process, not the product's eligible-ready oracle.
    write('placement/routes.json',candidate);return{generation:candidate.generation};
  };
  return{state,project,options,args,before,write,current,publisher,close(){
    const ids=docker(['ps','--all','--quiet','--filter','label=org.nightscout.recovery.fixture='+project]).split(/\s+/).filter(Boolean);
    for(const id of ids){assert.equal(inspect(id).Config.Labels['org.nightscout.recovery.fixture'],project);docker(['rm','--force',id]);}
    docker([...args,'down','--volumes','--remove-orphans']);fs.rmSync(state,{recursive:true,force:true});
  }};
}
for(const fault of ['before-stop','after-stop','after-assignment','after-env','after-create-effect','after-create','after-start-effect','after-start','after-routes'])test('actual Docker recovery after '+fault,{skip:!enabled,timeout:30000},async()=>{
  const f=fixture();try{
    const initial=inspect(f.current());
    await assert.rejects(operator.replace(f.options,{publisher:async args=>{const result=await f.publisher(args);if(fault==='after-routes')throw Error('OWNED_CRASH:'+fault);return result},checkpoint:async phase=>{if(phase===fault)throw Error('OWNED_CRASH:'+fault)}}),/OWNED_CRASH/);
    const interrupted=j.privateJson(path.join(f.state,'placement/operation.json')),generation=j.privateJson(path.join(f.state,'placement/backend.json')).generation;
    if(fault==='after-routes'){assert.equal(interrupted.phase,'started');assert.deepEqual(j.privateJson(path.join(f.state,'placement/backend.json')),j.privateJson(path.join(f.state,'placement/routes.json')));assert.equal(inspect(f.current()).State.Running,true);await assert.rejects(operator.replace(f.options,{publisher:f.publisher}),/RECOVERY_REQUIRED/);}
    if(fault==='after-assignment'){
      // A creator may already have exited while its one-shot container survives.
      const orphan=docker(['run','-d','--name',interrupted.publisherName,'--label','org.nightscout.recovery.fixture='+f.project,'--label','com.docker.compose.project='+f.project,'--label','com.docker.compose.service=demo','--label','org.nightscout.replacement.operation='+interrupted.operation,image,'node','-e','process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)']);
      assert.equal(inspect(orphan).State.Running,true);
      await operator.replace({...f.options,recover:true},{publisher:f.publisher});assert.equal(inspect(orphan).State.Running,false,'exact orphan publisher stopped before recovered publication');
    }else await operator.replace({...f.options,recover:true},{publisher:f.publisher});
    const final=j.privateJson(path.join(f.state,'placement/backend.json'));
    assert.equal(final.generation,generation+1);assert.deepEqual(final,j.privateJson(path.join(f.state,'placement/routes.json')));assert.notEqual(final.workers[0].incarnation,interrupted.newIncarnation);
    const actual=inspect(f.current());assert.notEqual(actual.Id,initial.Id);assert.equal(actual.State.Running,true);assert.equal(actual.Config.Labels['org.nightscout.replacement.incarnation'],final.workers[0].incarnation);
    assert.equal(j.privateJson(path.join(f.state,'placement/operation.json')).phase,'complete');
  }finally{f.close();}
});
test('actual attached Docker CLI retains inherited lock across creator host crash',{skip:!enabled,timeout:15000},async()=>{
  const f=fixture();let host,cli;const name=f.project+'-creator';try{
    const file=path.join(f.state,'creator.cjs');
    fs.writeFileSync(file,`const {locked}=require(${JSON.stringify(path.join(__dirname,'replacement-journal'))});const{spawn}=require('child_process');\nlocked(process.argv[2],async fd=>{const c=spawn('docker',['run','--name',process.argv[3],'--label',process.argv[4],process.argv[5],'node','-e','process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore',fd]});console.log(c.pid);await new Promise(()=>{});});process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);`);
    host=spawn(process.execPath,[file,f.state,name,'org.nightscout.recovery.fixture='+f.project,image],{stdio:['ignore','pipe','pipe']});
    cli=Number(await new Promise((resolve,reject)=>{host.stdout.once('data',bytes=>resolve(bytes.toString().trim()));host.once('error',reject)}));assert.ok(cli>0);
    const deadline=Date.now()+5000;while(Date.now()<deadline){try{if(inspect(name).State.Running)break}catch{}await sleep(20);}
    assert.equal(inspect(name).State.Running,true);assert.equal(fs.readlinkSync('/proc/'+cli+'/fd/3'),path.join(f.state,'placement/operation.lock'));
    const dead=new Promise(resolve=>host.once('exit',resolve));host.kill('SIGKILL');await dead;
    assert.throws(()=>execFileSync('flock',['-n',path.join(f.state,'placement/operation.lock'),'true']),error=>error.status===1);
    docker(['stop','--time','1',name]);for(let n=0;n<100;n++){try{execFileSync('flock',['-n',path.join(f.state,'placement/operation.lock'),'true']);break}catch{await sleep(10)}}
    execFileSync('flock',['-n',path.join(f.state,'placement/operation.lock'),'true']);
  }finally{host?.kill('SIGKILL');if(cli)try{process.kill(cli,'SIGTERM')}catch{}f.close();}
});
for(const mutation of ['restart','recreate'])test('actual changed container/process refuses recovery: '+mutation,{skip:!enabled,timeout:15000},async()=>{
  const f=fixture();try{
    await assert.rejects(operator.replace(f.options,{publisher:f.publisher,checkpoint:async p=>{if(p==='before-stop')throw Error('OWNED_CRASH')}}),/OWNED_CRASH/);
    const original=inspect(f.current());
    if(mutation==='restart')docker(['restart',original.Id]);
    else docker([...f.args,'up','-d','--no-build','--pull','never','--no-deps','--force-recreate','realtime']);
    const changed=inspect(f.current());assert.ok(changed.Id!==original.Id||changed.State.StartedAt!==original.State.StartedAt);
    await assert.rejects(operator.replace({...f.options,recover:true},{publisher:f.publisher}),/PLACEMENT_(PLATFORM_IDENTITY_CHANGED|RECOVERY_PROCESS_AMBIGUOUS)/);
    assert.equal(j.privateJson(path.join(f.state,'placement/backend.json')).generation,1);assert.equal(changed.State.Running,true);
  }finally{f.close();}
});
test('actual foreign project and wrong paired source refuse before stop',{skip:!enabled,timeout:15000},async()=>{
  const f=fixture();try{
    const id=f.current();await assert.rejects(operator.replace({...f.options,project:f.project+'-foreign'},{publisher:f.publisher}),/FIXED_CONTAINER_REQUIRED/);assert.equal(inspect(id).State.Running,true);
    const complete=j.privateJson(path.join(f.state,'bootstrap/complete.json'));f.write('bootstrap/complete.json',{...complete,sourceCommit:'f'.repeat(40)});
    await assert.rejects(operator.replace(f.options,{publisher:f.publisher}),/SOURCE_IDENTITY_CHANGED/);assert.equal(inspect(id).State.Running,true);
    f.write('bootstrap/complete.json',complete);await operator.replace(f.options,{publisher:f.publisher});assert.equal(j.privateJson(path.join(f.state,'placement/backend.json')).generation,2);
  }finally{f.close();}
});
test('actual still-running owner cannot be confirmed by a successful no-op stop command',{skip:!enabled,timeout:15000},async()=>{
  const f=fixture();try{
    const id=f.current();await assert.rejects(operator.replace(f.options,{publisher:f.publisher,docker:args=>args[0]==='stop'?id:docker(args)}));
    assert.equal(inspect(id).State.Running,true);assert.equal(j.privateJson(path.join(f.state,'placement/backend.json')).generation,1);
    await operator.replace({...f.options,recover:true},{publisher:f.publisher});assert.equal(j.privateJson(path.join(f.state,'placement/backend.json')).generation,2);
  }finally{f.close();}
});
