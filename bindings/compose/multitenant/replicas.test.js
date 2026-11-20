'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const replicas = require('./replicas');
test('replica count is bounded synthetic deployment input and default placement stays singular', () => {
  assert.equal(replicas.count({}), 1);
  for (const raw of ['0', '17', '2.5', 'x']) assert.throws(() => replicas.count({ NS_API_REPLICAS: raw }));
  assert.equal(replicas.count({ NS_API_REPLICAS: '2' }), 2);
  assert.equal(replicas.compose(1), '# Generated fixed-roster API placement.\nservices:\n  api: {}\n');
  assert.match(replicas.compose(2), /api-2:/);
  assert.match(replicas.compose(2), /aliases: \[api-internal\]/);
});
test('each TCP replica probes the private role readiness path', () => {
  const apiOverlay = replicas.compose(2);
  const probe = 'test: [CMD, node, bin/nightscout.js, healthcheck, --endpoint, ready, --url, http://127.0.0.1:7001/healthz/ready]';
  assert.equal(apiOverlay.split(probe).length - 1, 2);

  const workerCount = { workers: 2 };
  const { services } = JSON.parse(require('./input-transport').compose(2, workerCount, workerCount));
  for (const [role, port] of [['evaluator', 19002], ['realtime', 19003]]) {
    for (const name of [role, role + '-2']) {
      assert.deepEqual(services[name].healthcheck.test, ['CMD', 'node', 'bin/nightscout.js', 'healthcheck',
        '--endpoint', 'ready', '--url', 'http://127.0.0.1:' + port + '/healthz/ready']);
    }
  }
});
