'use strict';
// Source-only checks of the clinical isolation selection: REST admission is opt-in
// and only selected values reach every api process environment, and the
// reserved-connection grants name clinical roles only. The native reserve itself is measured by
// clinical-reserved-connections.integration.test.js.
const test = require('node:test'), assert = require('node:assert/strict');
const isolation = require('../clinical-isolation'), plan = require('../config');

test('REST admission is opt-in: unset or empty selects no limit; connection defaults, explicit values and refusals', () => {
  const unset = {restConcurrency: null, restQueue: null, restQueueTimeoutMs: null, restRetryAfterSeconds: null, maxConnections: 140, clinicalReserved: 40};
  assert.deepEqual({...isolation.selection({})}, unset);
  assert.deepEqual({...isolation.selection({NS_API_REST_CONCURRENCY: '', NS_API_REST_QUEUE: '', NS_API_REST_QUEUE_TIMEOUT_MS: '', NS_API_REST_RETRY_AFTER_SECONDS: ''})}, unset);
  assert.deepEqual({...isolation.selection({NS_API_REST_CONCURRENCY: '16', NS_API_REST_QUEUE: '0', NS_POSTGRES_MAX_CONNECTIONS: '200', NS_POSTGRES_CLINICAL_RESERVED_CONNECTIONS: '60'})},
    {restConcurrency: 16, restQueue: 0, restQueueTimeoutMs: null, restRetryAfterSeconds: null, maxConnections: 200, clinicalReserved: 60});
  for (const bad of [{NS_API_REST_CONCURRENCY: '0'}, {NS_API_REST_CONCURRENCY: '4', NS_API_REST_QUEUE: '-1'}, {NS_POSTGRES_CLINICAL_RESERVED_CONNECTIONS: '0'},
    {NS_POSTGRES_MAX_CONNECTIONS: '40', NS_POSTGRES_CLINICAL_RESERVED_CONNECTIONS: '37'}, {NS_API_REST_CONCURRENCY: '4', NS_API_REST_RETRY_AFTER_SECONDS: 'soon'}]) {
    assert.throws(() => isolation.selection(bad), TypeError, JSON.stringify(bad));
  }
  // A partial REST selection is refused at preparation, as core refuses it at boot.
  for (const stray of ['NS_API_REST_QUEUE', 'NS_API_REST_QUEUE_TIMEOUT_MS', 'NS_API_REST_RETRY_AFTER_SECONDS']) {
    assert.throws(() => isolation.selection({[stray]: '5'}), new RegExp(stray + ' requires NS_API_REST_CONCURRENCY'));
  }
  // The default .env records the connection reserve and no REST admission value.
  assert.equal(isolation.envLines(isolation.selection({})), 'NS_POSTGRES_MAX_CONNECTIONS=140\nNS_POSTGRES_CLINICAL_RESERVED_CONNECTIONS=40\n');
  assert.equal(isolation.envLines(isolation.selection({NS_API_REST_CONCURRENCY: '64', NS_API_REST_QUEUE: '32', NS_API_REST_QUEUE_TIMEOUT_MS: '500', NS_API_REST_RETRY_AFTER_SECONDS: '3'})),
    'NS_API_REST_CONCURRENCY=64\nNS_API_REST_QUEUE=32\nNS_API_REST_QUEUE_TIMEOUT_MS=500\nNS_API_REST_RETRY_AFTER_SECONDS=3\nNS_POSTGRES_MAX_CONNECTIONS=140\nNS_POSTGRES_CLINICAL_RESERVED_CONNECTIONS=40\n');
  assert.deepEqual(isolation.apiEnvironment(isolation.selection({})), {});
  assert.deepEqual(isolation.postgresArguments(isolation.selection({})), ['-c', 'max_connections=140', '-c', 'reserved_connections=40']);
});

test('reserved-connection grants name clinical roles and never a REST-serving or shared role', () => {
  const layout = plan.layout(), grants = isolation.grants(layout);
  const named = grants.map(sql => /^GRANT pg_use_reserved_connections TO "([a-z_]+)"$/.exec(sql)?.[1]);
  assert(named.every(Boolean), 'one fixed statement shape');
  assert.deepEqual(named.sort(), ['evaluator', 'lifetime_evaluator', 'lifetime_realtime', 'outbox', 'realtime', 'suppression'].map(kind => layout.roles[kind]).sort());
  for (const kind of ['api', 'readiness', 'root_writer', 'alarm', 'display_reader', 'activity_reader', 'owner_writer', 'owner_reader', 'operator', 'provisioner', 'ui_registry', 'lifetime_api', 'lifetime_tenant_admin']) {
    assert(!named.includes(layout.roles[kind]), kind + ' must not use the clinical reserve');
  }
  // Control: a layout that maps a clinical kind onto the api role is refused.
  const merged = {...layout, roles: {...layout.roles, outbox: layout.roles.api}};
  assert.throws(() => isolation.grants(merged), /REST-serving role cannot use reserved connections/);
});

test('max_connections is sized from the declared role pools; api 29, realtime 20 and evaluator 23 at the defaults, as on Kubernetes', () => {
  const shape = {apiReplicas: 16, realtimeWorkers: 8, evaluatorWorkers: 8};
  // 16 x (api data 4 + display 4 + secrets/registry/alarm 10 + operation 8 + transient 3)
  // + 8 x (realtime 4 + read/registry/owner 5 + operation 8 + transient 3)
  // + 8 x (evaluator 4 + read 2 + registry/outbox/suppression 6 + operation 8 + transient 3)
  assert.equal(isolation.connectionBudget(shape, {}), 16 * 29 + 8 * 20 + 8 * 23);
  assert.equal(isolation.connectionBudget({apiReplicas: 0, realtimeWorkers: 0, evaluatorWorkers: 1}, {}), 23);
  assert.equal(isolation.connectionBudget({apiReplicas: 1, realtimeWorkers: 0, evaluatorWorkers: 0}, {}), 29);
  assert.equal(isolation.connectionBudget({apiReplicas: 0, realtimeWorkers: 1, evaluatorWorkers: 0}, {}), 20);
  // NS_POOL_API_MAX sizes two api pools (data and display settings); NS_POOL_OPERATION_MAX one pool in every role.
  assert.equal(isolation.connectionBudget(shape, {NS_POOL_API_MAX: '8'}) - isolation.connectionBudget(shape, {}), 16 * 2 * 4);
  assert.equal(isolation.connectionBudget(shape, {NS_POOL_OPERATION_MAX: '9'}) - isolation.connectionBudget(shape, {}), 16 + 8 + 8);
  assert.equal(isolation.connectionBudget(shape, {NS_POOL_READ_MAX: '6'}) - isolation.connectionBudget(shape, {}), 8 * 4);
  // The retired stream-receipt pool is not counted.
  assert.equal(isolation.connectionBudget(shape, {NS_POOL_RECEIVER_MAX: '6'}), isolation.connectionBudget(shape, {}));
  assert.equal(isolation.selection({}, {budget: 280}).maxConnections, 3 + 40 + 280);
  assert.equal(isolation.selection({}, {budget: 22}).maxConnections, 140);
  assert.equal(isolation.selection({NS_POSTGRES_MAX_CONNECTIONS: '200'}, {budget: 280}).maxConnections, 200);
  assert.throws(() => isolation.connectionBudget(shape, {NS_POOL_READ_MAX: 'x'}), /NS_POOL_READ_MAX/);
});
