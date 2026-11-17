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
//    admin and UI pools cannot take the slots evaluator, realtime and pgstream need.
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
const CLINICAL_ROLE_KINDS = Object.freeze(['pgstream', 'evaluator', 'realtime', 'outbox', 'suppression', 'lifetime_evaluator', 'lifetime_realtime']);

function fail (message) { throw new TypeError(message); }
function selection (source = process.env) {
  const selected = {};
  for (const [key, name] of Object.entries(NAMES)) {
    const raw = source[name];
    if (raw === undefined || raw === '') { selected[key] = DEFAULTS[key]; continue; }
    const [lower, upper] = RANGES[key];
    if (typeof raw !== 'string' || !/^[0-9]{1,6}$/.test(raw) || Number(raw) < lower || Number(raw) > upper) fail(name + ' must be ' + lower + '..' + upper);
    selected[key] = Number(raw);
  }
  // As core does at boot: a queue/timeout/Retry-After value without a concurrency is refused, never ignored.
  const stray = REST_KEYS.slice(1).find(key => selected[key] !== null);
  if (selected.restConcurrency === null && stray) fail(NAMES[stray] + ' requires ' + NAMES.restConcurrency);
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
module.exports = { NAMES, DEFAULTS, REST_KEYS, SUPERUSER_RESERVED, CLINICAL_ROLE_KINDS, selection, apiEnvironment, postgresArguments, clinicalRoles, grants, envLines };
