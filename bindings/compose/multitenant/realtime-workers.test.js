'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const workers=require('./realtime-workers');
test('static realtime shape uses exactly K ordinals and refuses retired independent shard counts',()=>{
  assert.equal(workers.selection({}),null);
  for(const raw of ['0','9','2x','',2])assert.throws(()=>workers.selection({NS_REALTIME_WORKERS:raw}));
  assert.throws(()=>workers.selection({NS_REALTIME_WORKERS:'2',NS_REALTIME_SHARDS:'16'}),/retired/);
  const shape=workers.initial(workers.selection({NS_REALTIME_WORKERS:'3'}));
  assert.equal(shape.rule,'sha256-modulo-v1');
  assert.deepEqual(shape.realtime.map(row=>[row.service,row.ordinal]),[['realtime',0],['realtime-2',1],['realtime-3',2]]);
});
test('every realtime ordinal, idle ones included, gets its index and count as environment settings and a private address',()=>{
  const text=workers.compose({workers:3},'compose.yaml',['api']);
  for(const row of workers.initial({workers:3}).realtime){
    assert(text.includes(row.socketPath));assert(text.includes('NS_SLICE_ORDINAL: "'+row.ordinal+'"'));
  }
  assert(text.includes('NS_REALTIME_SLICE_PEERS'));

});
test('ordinary static rendering binds the canonical edge and stable restart identities without a placement mount',()=>{
  const text=workers.compose({workers:2},'compose.yaml',['api','api-2']);
  for(const service of ['realtime','realtime-2','socket-edge'])assert.match(text,new RegExp('  '+service+':'));
  assert.doesNotMatch(text,/restart:/,'workers inherit the role restart policy');
  assert.match(text,/--socket, \/run\/ns-ipc\/realtime-2.sock/);
  assert.match(text,/NS_REALTIME_STATIC_COUNT: "2"/);
  assert.match(text,/NS_REALTIME_STATIC_ROUTE_MAP/);
  assert.doesNotMatch(text,/NS_REALTIME_SHARDS|MULTITENANT_REALTIME_PLACEMENT|run\/ns-placement/);
});
