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
