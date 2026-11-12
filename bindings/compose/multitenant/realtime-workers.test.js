'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const workers = require('./realtime-workers');
test('sharding is opt-in with an explicit logical shard count independent of worker count', () => {
  assert.equal(workers.selection({}), null);
  for (const source of [{ NS_REALTIME_WORKERS: '2' }, { NS_REALTIME_SHARDS: '8' }, { NS_REALTIME_WORKERS: '17', NS_REALTIME_SHARDS: '8' }, { NS_REALTIME_WORKERS: '2', NS_REALTIME_SHARDS: '65537' }]) assert.throws(() => workers.selection(source));
  assert.deepEqual(workers.selection({ NS_REALTIME_WORKERS: '2', NS_REALTIME_SHARDS: '8' }), { workers: 2, shards: 8 });
  const one = workers.initial({ workers: 1, shards: 8 }), two = workers.initial({ workers: 2, shards: 8 });
  assert.equal(one.shardCount, two.shardCount);
  assert.equal(two.owners.length, 8);
  assert.equal(new Set(two.workers.map(worker => worker.incarnation)).size, 2);
});
test('all fixed participants include idle workers and use exact private instances', () => {
  const peer = { id: 'realtime', roles: ['realtime'], namespaces: ['clinical'], maxMessageBytes: 1024, timeoutMs: 1000 };
  const other = { id: 'api', roles: ['api'], namespaces: ['clinical'], maxMessageBytes: 1024, timeoutMs: 1000 };
  const map = workers.initial({ workers: 2, shards: 1 });
  const configs = { api: {}, realtime: { consumer: 'stable-durable-consumer' } };
  const docs = workers.expand({ configs, environments: { api: {}, realtime: {} }, operations: {
    api: { participantId: 'api', participants: [other, peer] }, realtime: { participantId: 'realtime', participants: [other, peer] }
  }, remote: [{ ...other, endpoint: {} }, { ...peer, endpoint: {} }] }, map);
  assert.equal(docs.configs['realtime-2'].consumer, configs.realtime.consumer);
  assert.deepEqual(docs.operations.api.participants.filter(row => row.worker).map(row => row.worker), ['realtime-1','realtime-2']);
  assert.equal(docs.operations.realtime.participantId, 'realtime-1');
  assert.equal(docs.environments['realtime-2'].REALTIME_WORKER_INCARNATION, map.workers[1].incarnation);
  assert.equal(docs.remote.find(row => row.id === 'realtime-2').endpoint.socketPath, '/run/ns-ipc/realtime-2.sock');
  assert.equal(docs.environments.api.MULTITENANT_REALTIME_PLACEMENT, '/run/ns-placement/backend.json');
  assert.equal(docs.environments.api.MULTITENANT_REALTIME_ROUTES, '/run/ns-placement/routes.json');
});
test('Compose wiring covers every API instance and routes public sockets through the registry edge', () => {
  const yaml = workers.compose({ workers: 2, shards: 8 }, '/synthetic/compose.yaml', ['api','api-2']);
  for (const service of ['bootstrap','api','api-2','realtime','realtime-2','evaluator','tenant-admin','demo','socket-edge','nginx']) assert.ok(yaml.includes('  ' + service + ':\n'), service);
  const fs = require('node:fs'), edge = require('./edge');
  const template = fs.readFileSync(__dirname + '/nginx.compose.conf', 'utf8');
  assert.ok(edge.render(template, { realtime: true }).includes('server socket-edge:1343 resolve;'));
  assert.ok(edge.render(template).includes('server realtime:1339 resolve;'));
});
