'use strict';
// Real Docker config/image/instance reads, scratch custody/journal, deliberate
// stop-before-platform publisher callback. No mock health or movement verdict.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const enabled=process.env.NS_COMPOSE_SHARDING_STATE;
test('actual merged publisher custody is admitted by the host helper before journal/child/platform effects',{skip:!enabled,timeout:30000},async()=>{
 const state=path.resolve(enabled),project=process.env.NS_COMPOSE_SHARDING_PROJECT,core=process.env.NS_UI_TEST_CORE;assert.match(project||'',/^ns-rt-binding(?:-clean|-final|-proof)?-[0-9]{8}$/);
 const folder=path.join(core,'deploy/multitenant'),files=[path.join(folder,'compose.yaml'),path.join(state,'compose.replicas.yaml'),path.join(state,'compose.realtime.yaml')];
 const base=['compose','-p',project,'--profile','ops','--env-file',path.join(folder,'.env'),...files.flatMap(file=>['-f',file])],actual=args=>execFileSync('docker',args,{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}).trim(),configuration=JSON.parse(actual([...base,'config','--format','json']));
 for(const mutation of ['none','ops','ipc','environment']){
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'ns-publisher-admit-'));let called=false;
  try{
   for(const name of ['bootstrap','placement','realtime-2','placement-operator'])fs.mkdirSync(path.join(scratch,name),{mode:0o700});
   for(const file of ['bootstrap/complete.json','placement/backend.json','placement/routes.json','realtime-2/env.json','placement-operator/env.json'])fs.copyFileSync(path.join(state,file),path.join(scratch,file));
   const selected=structuredClone(configuration),publisher=selected.services['placement-operator'];
   if(mutation==='ops')publisher.volumes.push({source:path.join(state,'ops'),target:'/run/unused-ops',read_only:true});
   if(mutation==='ipc')publisher.volumes.push({source:path.join(state,'ipc'),target:'/run/ns-ipc'});
   if(mutation==='environment')publisher.environment={...publisher.environment,NS_OPERATOR_PG:'unused-forbidden-custody'};
   const docker=args=>args.includes('config')?JSON.stringify(selected):actual(args);
   const promise=require('./replace-realtime').replace({state:scratch,project,compose:files,worker:'realtime-2',timeout:1000},{docker,publisher:async()=>{called=true;throw Object.assign(new Error('STOP_BEFORE_PLATFORM'),{code:'STOP_BEFORE_PLATFORM'});}});
   await assert.rejects(promise,{code:mutation==='none'?'STOP_BEFORE_PLATFORM':'PLACEMENT_PUBLISHER_CUSTODY_REFUSED'});
   assert.equal(called,mutation==='none');assert.equal(fs.existsSync(path.join(scratch,'placement/operation.json')),mutation==='none');
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
 }
 console.log('ACTUAL_PUBLISHER_ADMISSION baselineAccepted unusedOpsIPCandPGenvRefusedBeforeEffects');
});
