'use strict';
// Source-only checks of the clinical isolation selection: REST admission values
// reach every api process environment, and the reserved-connection grants name
// clinical roles only. The native reserve itself is measured by
// clinical-reserved-connections.integration.test.js.
const test = require('node:test'), assert = require('node:assert/strict');
const isolation = require('../clinical-isolation'), plan = require('../config');

test('selection defaults, explicit values and refusals', () => {
  assert.deepEqual({...isolation.selection({})}, {restConcurrency: 8, restQueue: 8, restQueueTimeoutMs: 1000, restRetryAfterSeconds: 2, maxConnections: 140, clinicalReserved: 40});
  assert.deepEqual({...isolation.selection({NS_API_REST_CONCURRENCY: '16', NS_API_REST_QUEUE: '0', NS_POSTGRES_MAX_CONNECTIONS: '200', NS_POSTGRES_CLINICAL_RESERVED_CONNECTIONS: '60'})},
    {restConcurrency: 16, restQueue: 0, restQueueTimeoutMs: 1000, restRetryAfterSeconds: 2, maxConnections: 200, clinicalReserved: 60});
  for (const bad of [{NS_API_REST_CONCURRENCY: '0'}, {NS_API_REST_QUEUE: '-1'}, {NS_POSTGRES_CLINICAL_RESERVED_CONNECTIONS: '0'},
    {NS_POSTGRES_MAX_CONNECTIONS: '40', NS_POSTGRES_CLINICAL_RESERVED_CONNECTIONS: '37'}, {NS_API_REST_RETRY_AFTER_SECONDS: 'soon'}]) {
    assert.throws(() => isolation.selection(bad), TypeError, JSON.stringify(bad));
  }
  assert.equal(isolation.envLines(isolation.selection({})),
    'NS_API_REST_CONCURRENCY=8\nNS_API_REST_QUEUE=8\nNS_API_REST_QUEUE_TIMEOUT_MS=1000\nNS_API_REST_RETRY_AFTER_SECONDS=2\nNS_POSTGRES_MAX_CONNECTIONS=140\nNS_POSTGRES_CLINICAL_RESERVED_CONNECTIONS=40\n');
  assert.deepEqual(isolation.postgresArguments(isolation.selection({})), ['-c', 'max_connections=140', '-c', 'reserved_connections=40']);
});

test('every api process environment selects REST admission that the core parser accepts', () => {
  const layout = plan.layout(), urls = Object.fromEntries(Object.keys(layout.roles).map(key => [key, 'postgres://' + layout.roles[key] + ':synthetic@postgres:5432/synthetic']));
  const previous = process.env.NS_API_REPLICAS;
  try {
    for (const replicas of ['1', '3']) {
      process.env.NS_API_REPLICAS = replicas;
      const docs = plan.documents({layout, urls, tokens: [], publicKeys: [], managementKeys: [], vaultAddress: 'https://vault:8200'});
      const apis = Object.keys(docs.environments).filter(name => name === 'api' || /^api-\d+$/.test(name));
      assert(apis.length >= Number(replicas));
      for (const name of apis) {
        assert.deepEqual({...require('../../../lib/server/serve/rest-admission').settings(docs.environments[name])},
          {concurrency: 8, queue: 8, queueTimeoutMs: 1000, retryAfterSeconds: 2}, name);
      }
      for (const name of ['realtime', 'evaluator', 'tenant-admin']) {
        assert(!Object.keys(docs.environments[name]).some(key => key.startsWith('NS_API_REST_')), name + ' is not REST-admission limited');
      }
    }
  } finally { if (previous === undefined) delete process.env.NS_API_REPLICAS; else process.env.NS_API_REPLICAS = previous; }
});

test('reserved-connection grants name clinical roles and never a REST-serving or shared role', () => {
  const layout = plan.layout(), grants = isolation.grants(layout);
  const named = grants.map(sql => /^GRANT pg_use_reserved_connections TO "([a-z_]+)"$/.exec(sql)?.[1]);
  assert(named.every(Boolean), 'one fixed statement shape');
  assert.deepEqual(named.sort(), ['evaluator', 'lifetime_evaluator', 'lifetime_realtime', 'outbox', 'pgstream', 'realtime', 'suppression'].map(kind => layout.roles[kind]).sort());
  for (const kind of ['api', 'readiness', 'root_writer', 'alarm', 'display_reader', 'activity_reader', 'owner_writer', 'owner_reader', 'operator', 'provisioner', 'ui_registry', 'lifetime_api', 'lifetime_tenant_admin']) {
    assert(!named.includes(layout.roles[kind]), kind + ' must not use the clinical reserve');
  }
  // Control: a layout that maps a clinical kind onto the api role is refused.
  const merged = {...layout, roles: {...layout.roles, outbox: layout.roles.api}};
  assert.throws(() => isolation.grants(merged), /REST-serving role cannot use reserved connections/);
});
