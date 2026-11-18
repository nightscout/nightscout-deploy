'use strict';
// Launcher argument model only: no service-health or native composition claim.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const workers=require('./realtime-workers');
test('selected launcher applies the same two fixed-roster overlays and starts every worker plus socket edge',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rt-launch-'));
  try {
    const state=path.join(dir,'state');fs.mkdirSync(state);const bin=path.join(dir,'bin');fs.mkdirSync(bin);
    for(const file of ['demo.sh','realtime-workers.js','evaluator-workers.js','project.js'])fs.copyFileSync(path.join(__dirname,file),path.join(dir,file));
    fs.writeFileSync(path.join(dir,'.env'),'NS_DEMO_STATE='+state+'\nNS_API_REPLICAS=2\nNS_REALTIME_WORKERS=2\nNS_EVALUATOR_WORKERS=2\n');
    for(const file of ['compose.replicas.yaml','compose.realtime.yaml','compose.evaluator.yaml'])fs.writeFileSync(path.join(state,file),'');
    const record=path.join(dir,'argv.jsonl');
    fs.writeFileSync(path.join(bin,'docker'),'#!/bin/sh\nexec '+process.execPath+' '+JSON.stringify(path.join(dir,'record.js'))+' "$@"\n',{mode:0o700});
    fs.writeFileSync(path.join(dir,'record.js'),'const args=process.argv.slice(2);require("node:fs").appendFileSync('+JSON.stringify(record)+',JSON.stringify(args)+"\\n");if(process.env.NS_CONTROL_REFUSE_PLATFORM==="1"&&args.includes("deploy/multitenant/platform-verify.js"))process.exit(23);');
    fs.writeFileSync(path.join(bin,'node'),'#!/bin/sh\ncase "$1" in build.js|publish-primer.js) exit 0;; esac\nexec '+process.execPath+' "$@"\n',{mode:0o700});
    const options={cwd:dir,env:{...process.env,PATH:bin+':'+process.env.PATH},stdio:'pipe'};
    options.env.COMPOSE_PROJECT_NAME='foreign';options.env.NS_DEMO_PROJECT='foreign';
    execFileSync('bash',['demo.sh','up'],options);
    const calls=fs.readFileSync(record,'utf8').trim().split('\n').map(JSON.parse);
    for(const call of calls){assert.equal(call[call.indexOf('--project-name')+1],'nightscout-multitenant-demo');assert.ok(call.includes(path.join(state,'compose.replicas.yaml')));assert.ok(call.includes(path.join(state,'compose.realtime.yaml')));assert.ok(call.includes(path.join(state,'compose.evaluator.yaml')));}
    const final=calls.at(-1);for(const service of ['realtime','realtime-2','socket-edge','evaluator','evaluator-2','pgstream','tenant-admin','ui','nginx'])assert.ok(final.includes(service),service);
    assert.ok(calls.find(call=>call.includes('api')&&call.includes('api-2')),'both API instances start before final roles');
    assert(!calls.some(call=>call.some(argument=>argument.endsWith('evaluator-pool.js'))),'native launch never configures pool membership');
    const verification=calls.findIndex(call=>call.includes('deploy/multitenant/platform-verify.js'));
    assert(verification>calls.findIndex(call=>call.includes('deploy/multitenant/commission-restore.js')));
    assert(verification<calls.findIndex(call=>call.includes('up')&&call.includes('api')));
    fs.writeFileSync(record,'');options.env.NS_CONTROL_REFUSE_PLATFORM='1';
    assert.throws(()=>execFileSync('bash',['demo.sh','up'],options),error=>error.status===23);
    const refused=fs.readFileSync(record,'utf8').trim().split('\n').map(JSON.parse);
    assert(refused.at(-1).includes('deploy/multitenant/platform-verify.js'));
    assert(!refused.some(call=>call.includes('up')&&call.includes('api')),'verification refusal prevents serving birth');
    assert(!refused.some(call=>call.includes('prime')),'verification refusal prevents lab priming');
    delete options.env.NS_CONTROL_REFUSE_PLATFORM;
    execFileSync('bash',['demo.sh','up'],options);
    assert(JSON.parse(fs.readFileSync(record,'utf8').trim().split('\n').at(-1)).includes('nginx'));
    fs.appendFileSync(path.join(dir,'.env'),'NS_DEMO_PROJECT=ns-admission-0123456789abcdef\n');
    execFileSync('bash',['demo.sh','config'],options);
    const selected=JSON.parse(fs.readFileSync(record,'utf8').trim().split('\n').at(-1));assert.equal(selected[selected.indexOf('--project-name')+1],'ns-admission-0123456789abcdef');
    fs.unlinkSync(path.join(state,'compose.realtime.yaml'));
    assert.throws(()=>execFileSync('bash',['demo.sh','config'],options),error=>error.status===1&&error.stderr.toString().includes('overlay missing'));
    assert.deepEqual(workers.services(null),['realtime']);
    assert.deepEqual(workers.services({workers:1}),['realtime','socket-edge']);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
