'use strict';

// Protect clinical delivery from REST saturation in this synthetic binding.
//
// 1. Bounded REST admission in each api process (core lib/server/serve/rest-admission.js),
//    opt-in: excess REST requests receive a fast 503 with Retry-After before any
//    handler runs, instead of queueing on PostgreSQL pool waits. serve.internal
//    (socket authority for realtime, lifecycle status) is not counted. Unset or
//    empty renders no NS_API_REST_* value, so the api is unbounded as in core;
//    only values an operator sets are rendered, and core supplies the rest.
// 2. Reserved PostgreSQL connection slots for clinical roles: the server keeps
//    reserved_connections slots that only members of pg_use_reserved_connections
//    may use (PostgreSQL 16). Bootstrap grants that membership to the roles that
//    produce and deliver clinical output and to nothing that serves REST, so API,
//    admin and UI pools cannot take the slots evaluator and realtime need.
//
// Each value is selected at preparation, recorded in .env and applied by Compose
// (PostgreSQL command) and bootstrap (api environment, grants). The connection
// defaults are synthetic reference values, not measured capacity limits.
const NAMES = Object.freeze({
  restConcurrency: 'NS_API_REST_CONCURRENCY', restQueue: 'NS_API_REST_QUEUE',
  restQueueTimeoutMs: 'NS_API_REST_QUEUE_TIMEOUT_MS', restRetryAfterSeconds: 'NS_API_REST_RETRY_AFTER_SECONDS',
  maxConnections: 'NS_POSTGRES_MAX_CONNECTIONS', clinicalReserved: 'NS_POSTGRES_CLINICAL_RESERVED_CONNECTIONS'
});
// PostgreSQL's default max_connections is 100 with 3 superuser slots; 140 with 40
// reserved keeps the same 97 general slots and adds the clinical reservation.
// REST admission has no binding default: a fixed per-process bound sheds normal
// traffic (at 180 req/s and p95 0.4 s about 70 requests are in flight).
const REST_KEYS = Object.freeze(['restConcurrency', 'restQueue', 'restQueueTimeoutMs', 'restRetryAfterSeconds']);
const DEFAULTS = Object.freeze({ restConcurrency: null, restQueue: null, restQueueTimeoutMs: null, restRetryAfterSeconds: null,
  maxConnections: 140, clinicalReserved: 40 });
const RANGES = Object.freeze({ restConcurrency: [1, 100000], restQueue: [0, 100000], restQueueTimeoutMs: [1, 60000],
  restRetryAfterSeconds: [1, 3600], maxConnections: [20, 10000], clinicalReserved: [1, 10000] });
// PostgreSQL's superuser_reserved_connections default; this binding does not change it.
const SUPERUSER_RESERVED = 3;
// Roles whose connections produce or deliver clinical output. layout() role kinds.
// display_reader and activity_reader are shared with the api role and are not
// reserved; the api's own roles (api, readiness, root_writer, alarm, lifetime_api)
// are never members.
const CLINICAL_ROLE_KINDS = Object.freeze(['evaluator', 'realtime', 'outbox', 'suppression', 'lifetime_evaluator', 'lifetime_realtime']);

// Declared PostgreSQL connection budget (decision pg-connection-budget): each
// role process's pools (core lib/server/serve/pool-config.js, NS_POOL_<ROLE>_MAX,
// defaults below) times its process count, plus about three transient health and
// readiness clients per process, as the Kubernetes plan counts them
// (bindings/kubernetes/lib/ns/connection-budget.libsonnet). An evaluator process
// opens the evaluation pool, its read-statement pool (NS_POOL_READ_MAX), fixed
// registry 2, outbox 2 and suppression 2 pools, and the operation pool: 4 + 2 + 6
// + 8 + 3 = 23 at the defaults, the Kubernetes figure. The stream-receipt pool
// (RECEIVER) is retired in core and no longer counted. Measured 2026-11-22 (core
// 458539d99, Compose, 120 tenants, one evaluator, sampled pg_stat_activity every
// 0.5 s): peaks evaluation 4, read 2, registry 2, outbox 2, suppression 2,
// operation 5; 16 at once. An api process opens its data and display-settings
// pools (NS_POOL_API_MAX each), fixed secrets 4, registry 2 and socket alarm 4
// pools, and the operation pool: 2 x 4 + 10 + 8 + 3 = 29 at the defaults. A
// realtime process opens its data pool, fixed read 2, registry 2 and owner 1
// pools, and the operation pool: 4 + 5 + 8 + 3 = 20. Same terms as the
// Kubernetes perPod (connection-budget.libsonnet); before 2026-11-23 the api and
// realtime terms counted only their data pools (4 each).
const POOL_DEFAULTS = Object.freeze({ API: 4, REALTIME: 4, EVALUATOR: 4, READ: 2, OPERATION: 8 });
const API_FIXED = 10;
const REALTIME_FIXED = 5;
const EVALUATOR_FIXED = 6;
const TRANSIENT_PER_PROCESS = 3;
function poolMax (source, role) {
  const raw = source['NS_POOL_' + role + '_MAX'];
  if (raw === undefined || raw === '') return POOL_DEFAULTS[role];
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,3}$/.test(raw)) fail('NS_POOL_' + role + '_MAX must be a whole number 1..9999');
  return Number(raw);
}
function connectionBudget ({ apiReplicas = 1, realtimeWorkers = 1, evaluatorWorkers = 1 } = {}, source = process.env) {
  const pool = role => poolMax(source, role);
  return apiReplicas * (2 * pool('API') + API_FIXED + pool('OPERATION') + TRANSIENT_PER_PROCESS) +
    realtimeWorkers * (pool('REALTIME') + REALTIME_FIXED + pool('OPERATION') + TRANSIENT_PER_PROCESS) +
    evaluatorWorkers * (pool('EVALUATOR') + pool('READ') + EVALUATOR_FIXED + pool('OPERATION') + TRANSIENT_PER_PROCESS);
}
function fail (message) { throw new TypeError(message); }
// With a declared budget, an unset NS_POSTGRES_MAX_CONNECTIONS is sized to hold
// it beside the superuser and clinical reservations, never below the default.
function selection (source = process.env, { budget } = {}) {
  const selected = {};
  for (const [key, name] of Object.entries(NAMES)) {
    const raw = source[name];
    if (raw === undefined || raw === '') {
      selected[key] = DEFAULTS[key];
      continue;
    }
    const [lower, upper] = RANGES[key];
    if (typeof raw !== 'string' || !/^[0-9]{1,6}$/.test(raw) || Number(raw) < lower || Number(raw) > upper) fail(name + ' must be ' + lower + '..' + upper);
    selected[key] = Number(raw);
  }
  // As core does at boot: a queue/timeout/Retry-After value without a concurrency is refused, never ignored.
  const stray = REST_KEYS.slice(1).find(key => selected[key] !== null);
  if (selected.restConcurrency === null && stray) fail(NAMES[stray] + ' requires ' + NAMES.restConcurrency);
  if (budget !== undefined && (source[NAMES.maxConnections] === undefined || source[NAMES.maxConnections] === '')) {
    selected.maxConnections = Math.max(DEFAULTS.maxConnections, SUPERUSER_RESERVED + selected.clinicalReserved + budget);
  }
  if (selected.maxConnections - SUPERUSER_RESERVED - selected.clinicalReserved < 1) {
    fail(NAMES.clinicalReserved + ' must leave general connection slots below ' + NAMES.maxConnections);
  }
  return Object.freeze(selected);
}
// The api role's process environment (written to its private env.json): only
// the REST admission values an operator selected.
function apiEnvironment (selected = selection()) {
  return Object.fromEntries(REST_KEYS.filter(key => selected[key] !== null).map(key => [NAMES[key], String(selected[key])]));
}
// The PostgreSQL server arguments Compose passes (compose.yaml uses the same names).
function postgresArguments (selected = selection()) {
  return ['-c', 'max_connections=' + selected.maxConnections, '-c', 'reserved_connections=' + selected.clinicalReserved];
}
function clinicalRoles (layout) {
  return CLINICAL_ROLE_KINDS.filter(kind => Object.hasOwn(layout.roles, kind)).map(kind => layout.roles[kind]);
}
function grants (layout, quote = require('./config').quote) {
  const roles = clinicalRoles(layout);
  if (!roles.includes(layout.roles.evaluator) || !roles.includes(layout.roles.realtime)) fail('Clinical roles missing from layout');
  for (const kind of ['api', 'readiness', 'root_writer', 'alarm', 'display_reader', 'activity_reader']) {
    if (roles.includes(layout.roles[kind])) fail('A REST-serving role cannot use reserved connections');
  }
  return roles.map(role => 'GRANT pg_use_reserved_connections TO ' + quote(role));
}
// .env lines recorded at preparation.
function envLines (selected = selection()) {
  return Object.entries(NAMES).filter(([key]) => selected[key] !== null).map(([key, name]) => name + '=' + selected[key] + '\n').join('');
}
module.exports = { NAMES, DEFAULTS, REST_KEYS, SUPERUSER_RESERVED, CLINICAL_ROLE_KINDS, POOL_DEFAULTS, connectionBudget, selection, apiEnvironment, postgresArguments, clinicalRoles, grants, envLines };
