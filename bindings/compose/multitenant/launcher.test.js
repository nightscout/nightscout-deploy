'use strict';
// Launcher argument model only: no service-health or native composition claim.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const workers=require('./realtime-workers');
test('selected launcher applies the same two fixed-roster overlays and starts every worker plus socket edge',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rt-launch-'));
  try {
    const state=path.join(dir,'state');fs.mkdirSync(state);const bin=path.join(dir,'bin');fs.mkdirSync(bin);
    for(const file of ['demo.sh','realtime-workers.js','evaluator-workers.js'])fs.copyFileSync(path.join(__dirname,file),path.join(dir,file));
    fs.writeFileSync(path.join(dir,'.env'),'NS_DEMO_STATE='+state+'\nNS_API_REPLICAS=2\nNS_REALTIME_WORKERS=2\nNS_REALTIME_SHARDS=2\nNS_EVALUATOR_WORKERS=3\n');
    for(const file of ['compose.replicas.yaml','compose.realtime.yaml','compose.evaluator.yaml'])fs.writeFileSync(path.join(state,file),'');
    const record=path.join(dir,'argv.jsonl');
    fs.writeFileSync(path.join(bin,'docker'),'#!/bin/sh\nexec '+process.execPath+' '+JSON.stringify(path.join(dir,'record.js'))+' "$@"\n',{mode:0o700});
    fs.writeFileSync(path.join(dir,'record.js'),'require("node:fs").appendFileSync('+JSON.stringify(record)+',JSON.stringify(process.argv.slice(2))+"\\n");');
    fs.writeFileSync(path.join(bin,'node'),'#!/bin/sh\ncase "$1" in build.js|publish-primer.js) exit 0;; esac\nexec '+process.execPath+' "$@"\n',{mode:0o700});
    const options={cwd:dir,env:{...process.env,PATH:bin+':'+process.env.PATH},stdio:'pipe'};
    execFileSync('bash',['demo.sh','up'],options);
    const calls=fs.readFileSync(record,'utf8').trim().split('\n').map(JSON.parse);
    for(const call of calls){assert.ok(call.includes(path.join(state,'compose.replicas.yaml')));assert.ok(call.includes(path.join(state,'compose.realtime.yaml')));assert.ok(call.includes(path.join(state,'compose.evaluator.yaml')));}
    const final=calls.at(-1);for(const service of ['realtime','realtime-2','socket-edge','evaluator','evaluator-2','evaluator-3','tenant-admin','ui','nginx'])assert.ok(final.includes(service),service);
    assert.ok(calls.find(call=>call.includes('api')&&call.includes('api-2')),'both API instances start before final roles');
    fs.unlinkSync(path.join(state,'compose.realtime.yaml'));
    assert.throws(()=>execFileSync('bash',['demo.sh','config'],options),error=>error.status===1&&error.stderr.toString().includes('overlay missing'));
    assert.deepEqual(workers.services(null),['realtime']);
    assert.deepEqual(workers.services({workers:1,shards:2}),['realtime','socket-edge']);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
