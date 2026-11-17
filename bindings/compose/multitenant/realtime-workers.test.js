'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const workers=require('./realtime-workers');
const {census}=require('../../lib/realtime-ownership');
test('static realtime shape uses exactly K ordinals and refuses retired independent shard counts',()=>{
  assert.equal(workers.selection({}),null);
  for(const raw of ['0','9','2x','',2])assert.throws(()=>workers.selection({NS_REALTIME_WORKERS:raw}));
  assert.throws(()=>workers.selection({NS_REALTIME_WORKERS:'2',NS_REALTIME_SHARDS:'16'}),/retired/);
  const shape=workers.initial(workers.selection({NS_REALTIME_WORKERS:'3'}));
  assert.equal(shape.rule,'sha256-modulo-v1');
  assert.deepEqual(shape.realtime.map(row=>[row.service,row.ordinal]),[['realtime',0],['realtime-2',1],['realtime-3',2]]);
});
test('all static participants include idle ordinals and exact private addresses; missing or mixed census refuses',()=>{
  const original={id:'realtime',roles:['realtime'],namespaces:['synthetic'],maxMessageBytes:1048576,timeoutMs:5000};
  const operation={participantId:'realtime',participants:[{id:'api',roles:['api']},original]};
  const docs={configs:{realtime:{}},operations:{realtime:operation},environments:{realtime:{},evaluator:{NS_REALTIME_INTERNAL_SOCKET:'/tmp/old.sock'}},remote:[{...original,endpoint:{socketPath:'/tmp/old.sock'}}]};
  const selected=workers.initial({workers:3}),expanded=workers.expand(docs,selected);
  const rows=expanded.operations.realtime.participants;
  assert.deepEqual(census(rows),{count:3,rule:'sha256-modulo-v1'});
  assert.throws(()=>census(rows.filter(row=>row.slice?.ordinal!==2)),/OWNERSHIP_REFUSED/);
  assert.throws(()=>census(rows.map(row=>row.slice?.ordinal===2?{...row,slice:{count:4,ordinal:2}}:row)),/OWNERSHIP_REFUSED/);
  assert.deepEqual(census(rows),{count:3,rule:'sha256-modulo-v1'});
  assert.deepEqual(JSON.parse(expanded.environments.evaluator.NS_REALTIME_SLICE_PEERS),selected.realtime.map(row=>({socket:row.socketPath})));
  for(const row of selected.realtime){
    assert.deepEqual(JSON.parse(expanded.environments[row.service].NS_REALTIME_SLICE),{count:3,ordinal:row.ordinal});
    assert.equal(expanded.operations[row.service].participantId,row.id);
    assert.equal(expanded.remote.find(peer=>peer.id===row.id).endpoint.socketPath,row.socketPath);
  }
  assert.equal(expanded.environments.evaluator.NS_REALTIME_INTERNAL_SOCKET,undefined);
});
test('ordinary static rendering binds the canonical edge and stable restart identities without a placement mount',()=>{
  const text=workers.compose({workers:2},'compose.yaml',['api','api-2']);
  for(const service of ['realtime','realtime-2','socket-edge'])assert.match(text,new RegExp('  '+service+':'));
  assert.match(text,/restart: unless-stopped/);
  assert.match(text,/NS_REALTIME_STATIC_COUNT: "2"/);
  assert.match(text,/NS_REALTIME_STATIC_ROUTE_MAP/);
  assert.doesNotMatch(text,/NS_REALTIME_SHARDS|MULTITENANT_REALTIME_PLACEMENT|run\/ns-placement/);
});
