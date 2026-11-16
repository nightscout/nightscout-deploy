import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {run,Session,coordinate,inventoryNodes,collectAll,checkMessage,trafficTransfer,collectNode,deployPayload,boundedExec} from '../external-runner.mjs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{validate,nodes}=require('../spec'),{baseSpec,extensionIdentity,checkSourceDescriptor,TRAFFIC_FILES}=require('../external-bundle.cjs');
const b={runId:'external-test',nonce:'b'.repeat(32),cell:1,expiresAt:Date.now()/1000+3600};
const message=(node,sequence,kind,payload={})=>({version:1,runId:b.runId,nonce:b.nonce,cell:1,node,sequence,kind,payload});
function peer(node){
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=false;child.kill=()=>{child.killed=true;};
  const sent=[];child.stdin=new Writable({write(chunk,_encoding,callback){sent.push(JSON.parse(chunk));callback();}});
  const session=new Session(child,b,node,new PassThrough());
  return {child,session,sent,emit:row=>child.stdout.write(JSON.stringify(row)+'\n')};
}
test('registered one-generator profile rejects a second generator, DB split or workload drift',()=>{
  const spec={...require('../examples/separated.json'),profile:'joined-external-generator-v1',topology:'colocated',appNodes:1,generatorNodes:1,appSize:'c-16',apiReplicas:1,tenants:2,capacityLevels:[2],hotFactor:10,warmSeconds:120,loadSeconds:300,diagnostics:'off',diagnosticsIntervalMs:5000,k6Image:'grafana/k6@sha256:'+'a'.repeat(64),maxEstimatedUSD:20};
  assert.equal(validate(spec),spec);assert.deepEqual(Object.keys(nodes(spec)),['app-0','generator-0']);
  for(const change of [{generatorNodes:2},{topology:'separated'},{hotFactor:1},{capacityLevels:[2,2]},{apiReplicas:2}])assert.throws(()=>validate({...spec,...change}));
  assert.equal(baseSpec(spec).profile,'joined-pilot-v1');assert.equal(baseSpec(spec).generatorNodes,0);
});
test('phase channel rejects wrong nonce, node, duplicate and malformed pending event',async()=>{
  const p=peer('app-0');const waiting=p.session.next('app-ready',1000);p.emit({...message('app-0',1,'app-ready'),nonce:'c'.repeat(32)});
  await assert.rejects(waiting,/BINDING_OR_ORDER/);assert.equal(p.child.killed,true);
  const q=peer('generator-0');q.emit(message('generator-0',1,'client-primed'));await q.session.next('client-primed');
  q.emit(message('generator-0',1,'client-primed'));await assert.rejects(q.session.next('load-complete'),/BINDING_OR_ORDER/);
  assert.throws(()=>checkMessage(message('app-0',1,'app-ready'),b,'generator-0',1,'app-ready'));
});
test('partial line cannot extend deadline; oversized line and lost stream refuse',async()=>{
  const p=peer('app-0'),waiting=p.session.next('app-ready',20);p.child.stdout.write('{');await assert.rejects(waiting,/TIMEOUT/);
  const q=peer('app-0'),next=q.session.next('app-ready',1000);q.child.stdout.write('x'.repeat(65536));await assert.rejects(next,/BOUND/);
  const r=peer('app-0'),missing=r.session.next('app-ready',1000);r.child.emit('close',0);await assert.rejects(missing,/EOF/);
});
test('public traffic stages and private server recovery join before any cell completion',async()=>{
  const trace=[];
  const app={async next(kind){trace.push('app:'+kind);return kind==='restart-done'?{status:'PASS',commandMs:4}:kind==='cell-complete'?{verdict:'PASS'}:{};},send(kind,payload){trace.push('app<'+kind);if(kind==='client-primed')assert.deepEqual(payload,{primed:4});},async finish(){trace.push('app:exit0');}};
  const gen={async next(kind){trace.push('gen:'+kind);return kind==='client-primed'?{primed:4}:{};},send(kind,payload){trace.push('gen<'+kind);if(kind==='restart-done')assert.deepEqual(payload,{status:'PASS',commandMs:4});},async finish(){trace.push('gen:exit0');}};
  await coordinate(app,async()=>{trace.push('start-generator');return gen;},async()=>trace.push('transfer-results'));
  assert.ok(trace.indexOf('start-generator')>trace.indexOf('app:app-ready'));
  assert.ok(trace.indexOf('app<finish')>trace.indexOf('app:server-recovery-complete'));
  assert.ok(trace.indexOf('app<finish')>trace.indexOf('gen:client-complete'));
  assert.ok(trace.indexOf('transfer-results')>trace.indexOf('gen:client-complete'));
  assert.ok(trace.indexOf('gen<finish')>trace.indexOf('app:cell-complete'));
  const failure={...app,async next(kind){if(kind==='restart-done')throw Error('actual-restart-failed');return app.next(kind);}};
  await assert.rejects(coordinate(failure,async()=>gen,async()=>{}),/actual-restart-failed/);
});
test('partial collection still attempts every inventoried node',async()=>{
  const seen=[];await assert.rejects(collectAll({'app-0':{},'generator-0':{}},async node=>{seen.push(node);if(node==='app-0')throw Error('collection-failed');}),/PARTIAL_COLLECTION/);
  assert.deepEqual(seen,['app-0','generator-0']);
  assert.throws(()=>inventoryNodes({nodes:{'app-0':{}},run_id:'owned-run'}),/NODE_ROSTER/);
});
test('extension descriptor is stable and separate from the base source instrument',()=>{
  assert.deepEqual(extensionIdentity({'b.py':'b','a.py':'a'}),extensionIdentity({'a.py':'a','b.py':'b'}));
  assert.notEqual(extensionIdentity({'a.py':'a'}).sha256,extensionIdentity({'a.py':'b'}).sha256);
});

test('finished sessions reject extra final acknowledgements and trailing partial data',async()=>{
  for(const data of [JSON.stringify(message('app-0',2,'cell-complete'))+'\n','{']){
    const p=peer('app-0');p.emit(message('app-0',1,'cell-complete',{verdict:'PASS'}));await p.session.next('cell-complete');
    p.child.stdout.write(data);await assert.rejects(p.session.finish(),/TRAILING/);
  }
});
test('producer-declared traffic interface must exactly match the actual transfer allowlist',()=>{
  const descriptor={binding:b,files:Object.fromEntries(TRAFFIC_FILES.map(name=>[name,'a'.repeat(64)]))};
  assert.deepEqual(trafficTransfer(descriptor,b),TRAFFIC_FILES);
  const missing=structuredClone(descriptor);delete missing.files['recovery.cjs'];assert.throws(()=>trafficTransfer(missing,b),/TRANSFER_INTERFACE/);
  const extra=structuredClone(descriptor);extra.files['env.json']='b'.repeat(64);assert.throws(()=>trafficTransfer(extra,b),/TRANSFER_INTERFACE/);
  assert.throws(()=>trafficTransfer({...descriptor,binding:{...b,nonce:'c'.repeat(32)}},b),/TRANSFER_INTERFACE/);
  const expected=extensionIdentity({'app.py':'a'});assert.deepEqual(checkSourceDescriptor(expected,expected),expected);
  assert.throws(()=>checkSourceDescriptor({...expected,trafficFiles:TRAFFIC_FILES.filter(name=>name!=='recovery.cjs')},expected),/SOURCE_INTERFACE/);
});

test('collection starts both hosts together and copies partial evidence after command failure',async()=>{
  const trace=[];let release;const gate=new Promise(resolve=>release=resolve);
  const collecting=collectAll({'app-0':{},'generator-0':{}},async node=>{
    trace.push(node);if(node==='generator-0')release();await gate;
    await collectNode(async ms=>{assert.ok(ms<=20000);throw Error('remote-tar-failed');},async ms=>{assert.ok(ms<=50000);trace.push(node+':copy');});
  });
  await assert.rejects(collecting,/PARTIAL_COLLECTION/);
  assert.deepEqual(trace.slice(0,2),['app-0','generator-0']);
  assert.ok(trace.includes('app-0:copy'));assert.ok(trace.includes('generator-0:copy'));
  let now=0;await collectNode(async()=>{now=20000;},async ms=>assert.equal(ms,30000),()=>now);
});
test('new collection scripts and metadata precede every large payload on both hosts',()=>{
  const manifest={files:Object.fromEntries(['core.pack','pilot-qualified-image.tar','alignment.pack','remote-external-app.sh','remote-external-generator.sh','external-setup.py','pilot-ledger.py','pilot-docker-store.py','pilot-native-identity.json'].map(name=>[name,'digest']))};
  for(const node of ['app-0','generator-0']){
    const names=deployPayload(manifest,node),firstLarge=names.findIndex(name=>/\.(pack|tar)$/.test(name));
    for(const name of names.filter(name=>!/\.(pack|tar)$/.test(name)))assert.ok(names.indexOf(name)<firstLarge);
    assert.ok(names.includes(node==='app-0'?'remote-external-app.sh':'remote-external-generator.sh'));
  }
});
test('collection subprocess timeout is bounded even when SIGTERM is ignored',async()=>{
  const start=Date.now();await assert.rejects(boundedExec(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{timeoutMs:100}),/TIMEOUT/);assert.ok(Date.now()-start<2500);
});

test('actual deploy installs both collectors before an interrupted large transfer',async t=>{
  const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'external-deploy-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bin=path.join(root,'bin'),bundle=path.join(root,'bundle');await fs.mkdir(bin);await fs.mkdir(bundle);
  const trace=path.join(root,'trace');
  await fs.writeFile(path.join(bin,'ssh'),'#!/bin/sh\nprintf "ssh %s\\n" "$*" >> "$TRACE"\n',{mode:0o700});
  await fs.writeFile(path.join(bin,'scp'),'#!/bin/sh\nprintf "scp %s\\n" "$*" >> "$TRACE"\ncase "$*" in *.pack*) exit 1;; esac\n',{mode:0o700});
  for(const name of ['external-runner.mjs','external-contract.cjs','smoke-runner.mjs'])await fs.copyFile(new URL('../'+name,import.meta.url),path.join(bundle,name));
  const files=['core.pack','remote-external-app.sh','remote-external-generator.sh','external-setup.py','pilot-ledger.py','pilot-docker-store.py','alignment.pack'];
  await fs.writeFile(path.join(bundle,'manifest.json'),JSON.stringify({files:Object.fromEntries(files.map(name=>[name,'synthetic']))}));
  const spec=path.join(root,'spec.json'),inventory=path.join(root,'inventory.json');
  await fs.writeFile(spec,JSON.stringify({profile:'joined-external-generator-v1',sshIdentityFile:'/synthetic',sshUser:'nsperf'}));
  await fs.writeFile(inventory,JSON.stringify({run_id:'synthetic-run',nodes:{'app-0':{role:'app',public_ipv4:'192.0.2.1',private_ipv4:'10.1.1.1'},'generator-0':{role:'generator',public_ipv4:'192.0.2.2',private_ipv4:'10.1.1.2'}}}));
  const {command}=require('../drivers');
  await assert.rejects(command(process.execPath,['--input-type=module','-e',"const {run}=await import(process.argv[1]);await run('deploy');",path.join(bundle,'external-runner.mjs')],{env:{PATH:bin+':'+process.env.PATH,TRACE:trace,PERF_SPEC:spec,PERF_INVENTORY:inventory,PERF_RUN_DIR:root}}));
  const rows=(await fs.readFile(trace,'utf8')).trim().split('\n'),large=rows.findIndex(row=>row.includes('core.pack'));
  assert.ok(large>0);
  for(const [host,script]of [['192.0.2.1','remote-external-app.sh'],['192.0.2.2','remote-external-generator.sh']]){
    assert.ok(rows.slice(0,large).some(row=>row.includes(host)&&row.includes(script)));
    assert.ok(rows.slice(0,large).some(row=>row.includes(host)&&row.includes('spec.json')));
  }
});

test('collection kills pipe-holding descendants and refuses oversized stdout',async()=>{
  const child="process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const parent="require('child_process').spawn(process.execPath,['-e',"+JSON.stringify(child)+"],{stdio:['ignore',process.stdout,process.stderr]});process.on('SIGTERM',()=>process.exit());setInterval(()=>{},1000)";
  const start=Date.now();await assert.rejects(boundedExec(process.execPath,['-e',parent],{timeoutMs:100}),/TIMEOUT/);assert.ok(Date.now()-start<2500);
  await assert.rejects(boundedExec(process.execPath,['-e',"process.stdout.write('x'.repeat(65537));setInterval(()=>{},1000)"],{timeoutMs:1000}),/OUTPUT_BOUND/);
});

test('both actual collectors preserve bootstrap evidence when spec upload is missing',async t=>{
  const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
  const {command}=require('../drivers'),root=await fs.mkdtemp(path.join(os.tmpdir(),'external-collect-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bin=path.join(root,'bin');await fs.mkdir(bin);await fs.writeFile(path.join(bin,'chown'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  for(const name of ['remote-external-app.sh','remote-external-generator.sh']){
    const host=path.join(root,name);await fs.mkdir(host);const script=path.join(root,name+'.run');
    await fs.writeFile(script,(await fs.readFile(new URL('../'+name,import.meta.url),'utf8')).replace('root=/opt/nsperf','root='+host));
    await command('bash',[script,'collect'],{env:{PATH:bin+':/usr/bin:/bin'}});
    const listing=(await command('tar',['-tzf',path.join(host,'evidence.tar.gz')])).stdout;
    assert.match(listing,/work\/collection-missing-inputs.txt/);
    assert.match(await fs.readFile(path.join(host,'work/collection-missing-inputs.txt'),'utf8'),/spec.json/);
  }
});
