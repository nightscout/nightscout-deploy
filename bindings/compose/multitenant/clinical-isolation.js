'use strict';

// Protect clinical delivery from REST saturation in this synthetic binding.
//
// 1. Bounded REST admission in each api process (core lib/server/serve/rest-admission.js):
//    excess REST requests receive a fast 503 with Retry-After before any handler
//    runs, instead of queueing on PostgreSQL pool waits. serve.internal (socket
//    authority for realtime, lifecycle status) is not counted.
// 2. Reserved PostgreSQL connection slots for clinical roles: the server keeps
//    reserved_connections slots that only members of pg_use_reserved_connections
//    may use (PostgreSQL 16). Bootstrap grants that membership to the roles that
//    produce and deliver clinical output and to nothing that serves REST, so API,
//    admin and UI pools cannot take the slots evaluator, realtime and pgstream need.
//
// Each value is selected at preparation, recorded in .env and applied by Compose
// (PostgreSQL command) and bootstrap (api environment, grants). Defaults are
// synthetic reference values, not measured capacity limits.
const NAMES = Object.freeze({
  restConcurrency: 'NS_API_REST_CONCURRENCY', restQueue: 'NS_API_REST_QUEUE',
  restQueueTimeoutMs: 'NS_API_REST_QUEUE_TIMEOUT_MS', restRetryAfterSeconds: 'NS_API_REST_RETRY_AFTER_SECONDS',
  maxConnections: 'NS_POSTGRES_MAX_CONNECTIONS', clinicalReserved: 'NS_POSTGRES_CLINICAL_RESERVED_CONNECTIONS'
});
// PostgreSQL's default max_connections is 100 with 3 superuser slots; 140 with 40
// reserved keeps the same 97 general slots and adds the clinical reservation.
const DEFAULTS = Object.freeze({ restConcurrency: 8, restQueue: 8, restQueueTimeoutMs: 1000, restRetryAfterSeconds: 2,
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
  if (selected.maxConnections - SUPERUSER_RESERVED - selected.clinicalReserved < 1) {
    fail(NAMES.clinicalReserved + ' must leave general connection slots below ' + NAMES.maxConnections);
  }
  return Object.freeze(selected);
}
// The api role's process environment (written to its private env.json).
function apiEnvironment (selected = selection()) {
  return { NS_API_REST_CONCURRENCY: String(selected.restConcurrency), NS_API_REST_QUEUE: String(selected.restQueue),
    NS_API_REST_QUEUE_TIMEOUT_MS: String(selected.restQueueTimeoutMs), NS_API_REST_RETRY_AFTER_SECONDS: String(selected.restRetryAfterSeconds) };
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
  return Object.entries(NAMES).map(([key, name]) => name + '=' + selected[key] + '\n').join('');
}
module.exports = { NAMES, DEFAULTS, SUPERUSER_RESERVED, CLINICAL_ROLE_KINDS, selection, apiEnvironment, postgresArguments, clinicalRoles, grants, envLines };
