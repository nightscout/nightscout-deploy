'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),path=require('node:path');
test('actual Compose publisher has no broad environment, IPC, artifact or restore-custody mount',{skip:process.env.NS_COMPOSE_CUSTODY_TEST!=='1'},()=>{
 const output=execFileSync('docker',['compose','--env-file','/dev/null','-f',path.join(__dirname,'compose.yaml'),'--profile','ops','config','--format','json'],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME,NS_SOURCE_COMMIT:'a'.repeat(40),NS_DEPLOY_COMMIT:'b'.repeat(40),NS_DEMO_STATE:'/tmp/synthetic-publisher-state',NS_DEMO_PORT:'18080',NS_DEMO_BIND:'127.0.0.1'}});
 const config=JSON.parse(output),check=require('./check-compose').checkPublisher;assert.equal(check(config),true);
 for(const volume of [{source:'/tmp/synthetic-publisher-state/ops',target:'/run/ns-config',read_only:true},{source:'/tmp/synthetic-publisher-state/ipc',target:'/run/ns-ipc'},{source:'/tmp/synthetic-publisher-state/realtime',target:'/run/ns-warm-config',read_only:true}]){
  const broken=structuredClone(config);broken.services['placement-operator'].volumes.push(volume);assert.throws(()=>check(broken));
 }
 const absent=structuredClone(config);delete absent.services['placement-operator'];assert.throws(()=>check(absent));
});
