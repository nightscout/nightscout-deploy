'use strict';

// Explicit private-plane demonstration, using the same controller and lifecycle
// as the selected application tree. It never provisions roles or reopens a
// tenant after a refused/uncertain restore. Artifacts include ciphertext.
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const fail = code => Object.assign(new Error(code), { code });
const validName = value => typeof value === 'string' && NAME.test(value) && value !== 'public' && value !== 'information_schema' && !value.startsWith('pg_');
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k)) && keys.every(k => Object.hasOwn(v, k));

function validateConfig (value, env = process.env, requireTokens = true) {
  if (!exact(value, ['version', 'tenants', 'apiOrigin', 'control', 'namespaces', 'catalogues', 'drainTimeoutMs', ...(Object.hasOwn(value || {}, 'intakeProfile') ? ['intakeProfile'] : [])]) || value.version !== 1 ||
      !Number.isSafeInteger(value.drainTimeoutMs) || value.drainTimeoutMs < 1 || value.drainTimeoutMs > 2147483647 ||
      !Array.isArray(value.tenants) || value.tenants.length !== 2 ||
      !value.tenants.every(t => exact(t, ['id', 'host', 'tokenEnv']) && UUID.test(t.id) && /^[a-z0-9.-]+$/.test(t.host) &&
        /^[A-Z][A-Z0-9_]*$/.test(t.tokenEnv) && (!requireTokens || typeof env[t.tokenEnv] === 'string' && env[t.tokenEnv].length > 0)) ||
      new Set(value.tenants.map(t => t.id)).size !== 2 || new Set(value.tenants.map(t => t.host)).size !== 2 ||
      !exact(value.control, ['namespace', 'locks', 'participants', ...(Object.hasOwn(value.control || {}, 'registry') ? ['registry'] : [])]) || !validName(value.control.namespace) ||
      value.control.registry !== undefined && (!exact(value.control.registry, ['namespace']) || !validName(value.control.registry.namespace)) ||
      !Array.isArray(value.control.locks) || value.control.locks.length !== 2 ||
      !value.control.locks.every(row => exact(row, ['tenant', 'key']) && value.tenants.some(t => t.id === row.tenant) &&
        typeof row.key === 'string' && /^[1-9][0-9]{0,18}$/.test(row.key) && BigInt(row.key) <= 9223372036854775807n) ||
      new Set(value.control.locks.map(row => row.tenant)).size !== 2 || new Set(value.control.locks.map(row => row.key)).size !== 2 ||
      !Array.isArray(value.control.participants) || !value.control.participants.length ||
      !value.namespaces || typeof value.namespaces !== 'object' || Array.isArray(value.namespaces) ||
      !Object.entries(value.namespaces).every(([key, namespace]) => validName(key) && validName(namespace)) ||
      new Set(Object.values(value.namespaces)).size !== Object.keys(value.namespaces).length ||
      !Array.isArray(value.catalogues) || !value.catalogues.length ||
      !value.catalogues.every(row => validName(row.kind) && Object.hasOwn(value.namespaces, row.kind)) ||
      new Set(value.catalogues.map(row => row.kind)).size !== value.catalogues.length ||
      typeof env.NS_OPERATOR_PG !== 'string' || !env.NS_OPERATOR_PG || !/^[0-9a-f]{40}$/.test(env.NS_SOURCE_COMMIT || '')) {
    throw fail('COMPOSE_OPERATOR_CONFIG_REFUSED');
  }
  let origin, pg;
  try { origin = new URL(value.apiOrigin); pg = new URL(env.NS_OPERATOR_PG); } catch { throw fail('COMPOSE_OPERATOR_CONFIG_REFUSED'); }
  // The demo uses the Compose private service, not a user-provided public site.
  if (origin.origin !== value.apiOrigin || !['api', 'api-internal'].includes(origin.hostname) || origin.protocol !== 'http:' || origin.username || origin.password ||
      !['postgres:', 'postgresql:'].includes(pg.protocol) || !pg.username || !pg.password || !pg.pathname.slice(1) || pg.hash ||
      [...pg.searchParams.keys()].some(k => k !== 'sslmode')) throw fail('COMPOSE_OPERATOR_CONFIG_REFUSED');
  let intakeProfile;
  try { intakeProfile = require('../../lib/tenant-lifecycle/generation-domain').bind(value.intakeProfile, value.control.namespace, value.tenants.map(row => row.id)); }
  catch { throw fail('COMPOSE_OPERATOR_CONFIG_REFUSED'); }
  const plain = { ...value }; delete plain.intakeProfile;
  return { ...structuredClone(plain), ...(intakeProfile ? { intakeProfile } : {}) };
}

function loadConfig (file = process.env.NS_OPERATOR_CONFIG || '/run/ns-config/config.json', env = process.env) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024 || (stat.mode & 0o077)) throw fail('COMPOSE_OPERATOR_CONFIG_PERMISSIONS');
  return validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')), env);
}

function expectedCandidates () {
  const plan = require('./config');
  return Object.fromEntries(plan.lifecycle(plan.layout()).catalogues.map(row => [row.kind, row.candidate]));
}

function lifecycleFor (config) {
  const expected = expectedCandidates();
  if (!isDeepStrictEqual(Object.keys(expected).sort(), config.catalogues.map(row => row.kind).sort()) ||
      config.catalogues.some(row => !isDeepStrictEqual(row.candidate, expected[row.kind]))) throw fail('COMPOSE_OPERATOR_CATALOGUE_REFUSED');
  require('../../lib/storage/tenant-scope').setTenancyMode('multi');
  return require('../../lib/tenant-lifecycle').createLifecycle({ catalogues: config.catalogues });
}

function tenantFor (config, tenant) {
  if (!config.tenants.some(t => t.id === tenant)) throw fail('COMPOSE_OPERATOR_TENANT_REFUSED');
  return tenant;
}

async function capture (config, tenant, env = process.env) {
  tenantFor(config, tenant);
  const lifecycle = lifecycleFor(config);
  const connection = await require('../../lib/storage/postgres-connection')({ connectionString: env.NS_OPERATOR_PG, max: 1,
    connectionTimeoutMillis: 5000, statement_timeout: 10000, options: '-c search_path=pg_catalog' });
  try { return await lifecycle.exportTenant(connection, { tenant, namespaces: config.namespaces, sourceCommit: env.NS_SOURCE_COMMIT }); }
  finally { await connection.end(); }
}

function operationPlacement(env = process.env) {
  if (!env.MULTITENANT_REALTIME_PLACEMENT) return null;
  const internal = require('../../lib/server/internal-api/listener-config').observer(env);
  return require('../../lib/realtime-placement').load(env, { internal });
}

function cohortTenants(config) { return config.control.registry ? ['registry:' + config.control.registry.namespace] : config.tenants.map(t => t.id); }

async function ready (config) {
  const placement = operationPlacement();
  const cohort = await require('../../lib/server/serve/operation-cohort').createRemote({namespace: config.control.namespace,
    tenants: cohortTenants(config), participants: config.control.participants, placement, ...(config.intakeProfile ? { intakeProfile: config.intakeProfile } : {})});
  await cohort.close();
}

async function restore (config, artifact, env = process.env, hooks = {}) {
  const tenant = tenantFor(config, artifact?.manifest?.tenant);
  const lifecycle = lifecycleFor(config);
  // createRemote reads actual participants. Missing peers fail before suspension.
  const cohort = await require('../../lib/server/serve/operation-cohort').createRemote({ namespace: config.control.namespace,
    tenants: cohortTenants(config), participants: config.control.participants, placement: operationPlacement(env), ...(config.intakeProfile ? { intakeProfile: config.intakeProfile } : {}) });
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: env.NS_OPERATOR_PG, max: 1, connectionTimeoutMillis: 5000,
    statement_timeout: 10000, options: '-c search_path=pg_catalog' });
  try {
    const controller = require('../../lib/tenant-lifecycle/maintenance-window').create({ namespace: config.control.namespace,
      locks: config.control.locks, pool, cohort, drainTimeoutMs: config.drainTimeoutMs, intakeProfile: config.intakeProfile });
    let committed = false;
    const result = await controller.withRestore(tenant, { artifactDigest: artifact.digest }, async ({ connection, maintenanceClaim }) => {
      // The lifecycle control namespace holds the key-retention ledger (BF-230).
      return lifecycle.restoreLogical(connection, artifact, { tenant, namespaces: config.namespaces, ledgerNamespace: config.control.namespace, maintenanceClaim,
        ...(hooks.onRow ? { onRow: hooks.onRow } : {}), onCommitted: async summary => { committed = true; if (hooks.onCommitted) await hooks.onCommitted(summary); } });
    });
    if (!committed) throw fail('COMPOSE_RESTORE_COMMIT_NOT_OBSERVED');
    return result;
  } finally { try { await cohort.close(); } finally { await pool.end(); } }
}

// The admitted entry owns construction; this adapter accepts only its branded
// context. Preserve registry scope and the selected private placement manifest.
function validateRecoveryConfig(value,env){return validateConfig(value,env,false);}
async function recoveryCohort(config,env){return require('../../lib/server/serve/operation-cohort').createRemote({namespace:config.control.namespace,tenants:cohortTenants(config),participants:config.control.participants,placement:operationPlacement(env),...(config.intakeProfile?{intakeProfile:config.intakeProfile}:{})});}
function recoveryController(config,cohort,context){
 if(!require('./lifecycle-operator-entry').isContext(context))throw fail('LIFECYCLE_OPERATOR_CONTEXT');
 context.check();return require('../../lib/tenant-lifecycle/restore-resume').create({namespace:config.control.namespace,locks:config.control.locks,pool:context.pool,cohort,statementTimeoutMs:10000,lockWaitMs:2000});
}
// SOURCE-only admitted capture/restore boundary. The fixed entry owns the
// branded pool; no constructor or startup acquisition is invented here.
function admittedContext(context) {
  if (!require('./lifecycle-operator-entry').isContext(context)) throw fail('LIFECYCLE_OPERATOR_CONTEXT');
  context.check();
}
async function admittedCapture(config, tenant, context, env = process.env) {
  admittedContext(context); tenantFor(config, tenant);
  const lifecycle = lifecycleFor(config);
  const snapshot = require('./lifecycle-snapshot').create(context,{catalogues:lifecycle.admittedCatalogue(),namespaces:config.namespaces,sourceCommit:env.NS_SOURCE_COMMIT});
  const artifact = await lifecycle.exportTenant(snapshot, { tenant, namespaces: config.namespaces, sourceCommit: env.NS_SOURCE_COMMIT });
  context.check(); return artifact;
}
async function admittedRestore(config, artifact, context, env = process.env, hooks = {}) {
  admittedContext(context);
  const tenant = tenantFor(config, artifact?.manifest?.tenant), lifecycle = lifecycleFor(config);
  let cohort, controller;
  try {
    cohort = await recoveryCohort(config, env); context.check();
    controller = require('../../lib/tenant-lifecycle/maintenance-window').create({ namespace: config.control.namespace,
      locks: config.control.locks, pool: context.pool, cohort, drainTimeoutMs: config.drainTimeoutMs, intakeProfile: config.intakeProfile });
    let committed = false;
    const result = await controller.withRestore(tenant, { artifactDigest: artifact.digest }, async ({ connection, maintenanceClaim }) => {
      context.check();
      if (hooks.beforeData) await hooks.beforeData();
      context.check();
      return lifecycle.restoreLogical(connection, artifact, { tenant, namespaces: config.namespaces, ledgerNamespace: config.control.namespace, maintenanceClaim,
        ...(hooks.onRow ? { onRow: hooks.onRow } : {}), onCommitted: async summary => {
          context.check(); committed = true; if (hooks.onCommitted) await hooks.onCommitted(summary); context.check();
        } });
    });
    context.check(); if (!committed) throw fail('COMPOSE_RESTORE_COMMIT_NOT_OBSERVED');
    return result;
  } finally { try { await controller?.close(); } finally { await cohort?.close(); } }
}

function argumentsFor (args) {
  const command = args.shift();
  if (!['export', 'restore'].includes(command)) throw fail('COMPOSE_OPERATOR_USAGE');
  const options = {};
  while (args.length) {
    const name = args.shift(), value = args.shift();
    if (!['--tenant', '--directory', '--digest'].includes(name) || !value || Object.hasOwn(options, name)) throw fail('COMPOSE_OPERATOR_USAGE');
    options[name] = value;
  }
  if (!UUID.test(options['--tenant'] || '') || !path.isAbsolute(options['--directory'] || '') ||
      (command === 'restore' && !/^[a-f0-9]{64}$/.test(options['--digest'] || '')) ||
      (command === 'export' && options['--digest'])) throw fail('COMPOSE_OPERATOR_USAGE');
  return { command, tenant: options['--tenant'], directory: options['--directory'], digest: options['--digest'] };
}

async function main (args = process.argv.slice(2)) {
  const options = argumentsFor(args), config = loadConfig(), artifacts = require('../../lib/tenant-lifecycle/filesystem-artifact');
  tenantFor(config, options.tenant);
  if (options.command === 'export') {
    const artifact = await capture(config, options.tenant);
    await artifacts.saveTenantArtifact(artifact, { directory: options.directory });
    return { operation: 'export', tenant: options.tenant, digest: artifact.digest };
  }
  const artifact = await artifacts.loadTenantArtifact({ directory: options.directory, digest: options.digest });
  if (artifact.manifest.tenant !== options.tenant) throw fail('COMPOSE_OPERATOR_TENANT_REFUSED');
  await restore(config, artifact);
  return { operation: 'restore', tenant: options.tenant, digest: artifact.digest, state: 'restored-and-active' };
}

if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result) + '\n'), error => {
  // Never print inherited HTTP/PG errors, connection strings or artifact content.
  process.stderr.write(JSON.stringify({ error: /^[A-Z][A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'COMPOSE_OPERATOR_FAILED',
    recovery: 'Inspect persisted operation state. Do not automatically replay or reopen the tenant.' }) + '\n');
  process.exitCode = 1;
});
module.exports = { admittedCapture, admittedRestore, validateRecoveryConfig, recoveryCohort, recoveryController, validateConfig, loadConfig, lifecycleFor, tenantFor, cohortTenants, ready, capture, restore, argumentsFor, main };
