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
  operationPlacement(env);
  const registryTarget = value?.version === 3;
  if (!exact(value, ['version', ...(registryTarget ? [] : ['tenants']), 'apiOrigin', 'control', 'namespaces', 'catalogues', 'drainTimeoutMs', ...(Object.hasOwn(value || {}, 'intakeProfile') ? ['intakeProfile'] : []), ...(Object.hasOwn(value || {}, 'nativeSelection') ? ['nativeSelection'] : [])]) || ![1,2,3].includes(value.version) || value.version===2&&(value.nativeSelection===undefined||value.intakeProfile!==undefined) ||
      !Number.isSafeInteger(value.drainTimeoutMs) || value.drainTimeoutMs < 1 || value.drainTimeoutMs > 2147483647 ||
      !registryTarget && (!Array.isArray(value.tenants) || value.tenants.length !== 2 ||
      !value.tenants.every(t => exact(t, ['id', 'host', 'tokenEnv']) && UUID.test(t.id) && /^[a-z0-9.-]+$/.test(t.host) &&
        /^[A-Z][A-Z0-9_]*$/.test(t.tokenEnv) && (!requireTokens || typeof env[t.tokenEnv] === 'string' && env[t.tokenEnv].length > 0)) ||
      new Set(value.tenants.map(t => t.id)).size !== 2 || new Set(value.tenants.map(t => t.host)).size !== 2) ||
      !exact(value.control, ['namespace', ...(registryTarget ? [] : ['locks']), ...(Object.hasOwn(value.control || {}, 'registry') ? ['registry'] : [])]) || !validName(value.control.namespace) ||
      value.control.registry !== undefined && (!exact(value.control.registry, ['namespace']) || !validName(value.control.registry.namespace)) ||
      registryTarget && (!value.control.registry || value.intakeProfile !== undefined) ||
      !registryTarget && (!Array.isArray(value.control.locks) || value.control.locks.length !== 2 ||
      !value.control.locks.every(row => exact(row, ['tenant', 'key']) && value.tenants.some(t => t.id === row.tenant) &&
        typeof row.key === 'string' && /^[1-9][0-9]{0,18}$/.test(row.key) && BigInt(row.key) <= 9223372036854775807n) ||
      new Set(value.control.locks.map(row => row.tenant)).size !== 2 || new Set(value.control.locks.map(row => row.key)).size !== 2) ||
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
  let intakeProfile,nativeSelection;
  try {
    if(value.intakeProfile!==undefined&&value.nativeSelection!==undefined)throw fail('COMPOSE_OPERATOR_CONFIG_REFUSED');
    if(value.nativeSelection!==undefined){
      const native=require('../../lib/tenant-lifecycle/native-selection');nativeSelection=native.bind(native.create(value.nativeSelection),value.control.namespace);
      if(nativeSelection.binding.namespace!==value.namespaces.evaluator_checkpoint)throw fail('COMPOSE_OPERATOR_CONFIG_REFUSED');
    }
    intakeProfile = require('../../lib/tenant-lifecycle/generation-domain').bind(value.intakeProfile, value.control.namespace, value.tenants?.map(row => row.id));
  }
  catch { throw fail('COMPOSE_OPERATOR_CONFIG_REFUSED'); }
  const plain = { ...value }; delete plain.intakeProfile; delete plain.nativeSelection;
  return { ...structuredClone(plain), ...(intakeProfile ? { intakeProfile } : {}),...(nativeSelection?{nativeSelection}:{}) };
}

function loadConfig (file = process.env.NS_OPERATOR_CONFIG || '/run/ns-config/config.json', env = process.env) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024 || (stat.mode & 0o077)) throw fail('COMPOSE_OPERATOR_CONFIG_PERMISSIONS');
  return validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')), env);
}

// The lab demonstration addresses its two synthetic clients. Operator commands
// resolve the requested tenant and check its current grant in PostgreSQL.
function loadDemoConfig(file = process.env.NS_OPERATOR_CONFIG || '/run/ns-config/config.json', env = process.env) {
  const config = loadConfig(file, env);
  if (config.version !== 3) return config;
  const { tenantIds, tenantAlias } = require('./demo-tenants');
  const tenants = tenantIds(2).map((id, index) => ({ id, host: tenantAlias(index),
    tokenEnv: index === 0 ? 'NS_DEMO_TOKEN_A' : 'NS_DEMO_TOKEN_B' }));
  if (tenants.some(row => !env[row.tokenEnv])) throw fail('COMPOSE_DEMO_TARGETS_INVALID');
  return { ...config, tenants };
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
  return require('../../lib/tenant-lifecycle').createLifecycle({ catalogues: config.catalogues,...(config.nativeSelection?{nativeSelection:config.nativeSelection}:{}),...(config.nativeSelection?{currentConfiguration:async()=>({nativeSource:{source:config.nativeSelection.binding.source,generation:config.nativeSelection.binding.generation}})}:{}) });
}

function tenantFor (config, tenant) {
  if (!UUID.test(tenant) || (config.version !== 3 && !config.tenants.some(t => t.id === tenant))) throw fail('COMPOSE_OPERATOR_TENANT_REFUSED');
  return tenant;
}

// Caller holds a transaction scoped to this tenant. The restore operator's
// grant is tenant- and role-specific; its revocation also prevents export.
async function registeredLock(config, tenant, query) {
  const quote = require('./config').quote;
  const registry = quote(config.control.registry.namespace);
  const control = quote(config.control.namespace);
  const { rows } = await query(`SELECT w.lock_key::text AS key
    FROM ${registry}.tenant_registry r
    JOIN ${control}.tenant_lifecycle_windows w USING(tenant_id)
    JOIN ${control}.tenant_lifecycle_restore_authority a USING(tenant_id)
    WHERE r.tenant_id=$1 AND r.state='active' AND a.active AND a.role_oid=CURRENT_USER::regrole::oid`, [tenant]);
  if (rows.length !== 1) throw fail('COMPOSE_OPERATOR_TENANT_REFUSED');
  return { tenant, key: rows[0].key };
}

async function targetLocks(config, tenant, pool) {
  if (config.version !== 3) return config.control.locks;
  const client = await pool.connect();
  let error;
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
    const lock = await registeredLock(config, tenant, client.query.bind(client));
    await client.query('COMMIT');
    return [lock];
  } catch (cause) {
    error = cause;
    throw cause;
  } finally { client.release(error); }
}

async function capture (config, tenant, env = process.env) {
  operationPlacement(env);
  tenantFor(config, tenant);
  const lifecycle = lifecycleFor(config);
  const connection = await require('../../lib/storage/postgres-connection')({ connectionString: env.NS_OPERATOR_PG, max: 1,
    connectionTimeoutMillis: 5000, statement_timeout: 10000, options: '-c search_path=pg_catalog' });
  try { return await exportTenant(lifecycle, connection, config, tenant, env.NS_SOURCE_COMMIT); }
  finally { await connection.end(); }
}

function operationPlacement(env = process.env) {
  if(env.MULTITENANT_REALTIME_PLACEMENT!==undefined)throw fail('COMPOSE_LEGACY_PLACEMENT_RETIRED');
  return null;
}
function selectionOptions (config) {
  return config.nativeSelection ? { nativeSelection: config.nativeSelection } : config.intakeProfile ? { intakeProfile: config.intakeProfile } : {};
}

function exportTenant (lifecycle, connection, config, tenant, sourceCommit) {
  const snapshot = config.version === 3 ? { ...connection, snapshotTransaction: body => connection.snapshotTransaction(async () => {
    await registeredLock(config, tenant, connection.query.bind(connection));
    return body();
  }) } : connection;
  return lifecycle.exportTenant(snapshot, { tenant, namespaces: config.namespaces, sourceCommit });
}

async function restore (config, artifact, env = process.env, hooks = {}) {
  const tenant = tenantFor(config, artifact?.manifest?.tenant);
  const lifecycle = lifecycleFor(config);
  operationPlacement(env);
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: env.NS_OPERATOR_PG, max: 1, connectionTimeoutMillis: 5000,
    statement_timeout: 10000, options: '-c search_path=pg_catalog' });
  try {
    const controller = require('../../lib/tenant-lifecycle/maintenance-window').create({ namespace: config.control.namespace,
      locks: await targetLocks(config, tenant, pool), pool, drainTimeoutMs: config.drainTimeoutMs, ...selectionOptions(config) });
    let committed = false;
    const result = await controller.withRestore(tenant, { artifactDigest: artifact.digest }, async ({ connection, maintenanceClaim }) => {
      // The lifecycle control namespace holds the key-retention ledger (BF-230).
      return lifecycle.restoreLogical(connection, artifact, { tenant, namespaces: config.namespaces, ledgerNamespace: config.control.namespace, maintenanceClaim,
        ...(hooks.onRow ? { onRow: hooks.onRow } : {}), onCommitted: async summary => {
          committed = true; if (hooks.onCommitted) await hooks.onCommitted(summary);
        } });
    });
    if (!committed) throw fail('COMPOSE_RESTORE_COMMIT_NOT_OBSERVED');
    return result;
  } finally { await pool.end(); }
}

// Interrupted-restore recovery on the operator's plain private pool (max 1).
// `inspect` changes nothing; `resume` reopens a tenant held closed by a restore
// whose operator has ended, under the claim that `inspect` reported.
async function recover (config, command, tenant, claimId, env = process.env) {
  operationPlacement(env);
  tenantFor(config, tenant);
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: env.NS_OPERATOR_PG, max: 1, connectionTimeoutMillis: 5000,
    statement_timeout: 10000, options: '-c search_path=pg_catalog' });
  let controller;
  try {
    controller = recoveryController(config, pool, await targetLocks(config, tenant, pool));
    return command === 'inspect' ? await controller.inspect(tenant) : await controller.resume(tenant, { claimId });
  } finally { await controller?.close(); await pool.end(); }
}
function recoveryController (config, pool, locks = config.control.locks) {
  return require('../../lib/tenant-lifecycle/restore-resume').create({ namespace: config.control.namespace, locks, pool,
    statementTimeoutMs: 10000, lockWaitMs: 2000, ...selectionOptions(config) });
}

function argumentsFor (args) {
  const command = args.shift();
  if (!['export', 'restore', 'inspect', 'resume'].includes(command)) throw fail('COMPOSE_OPERATOR_USAGE');
  const options = {};
  while (args.length) {
    const name = args.shift(), value = args.shift();
    if (!['--tenant', '--directory', '--digest', '--claim'].includes(name) || !value || Object.hasOwn(options, name)) throw fail('COMPOSE_OPERATOR_USAGE');
    options[name] = value;
  }
  const recovering = command === 'inspect' || command === 'resume';
  if (!UUID.test(options['--tenant'] || '') ||
      (recovering ? options['--directory'] || options['--digest'] || (command === 'resume') !== Object.hasOwn(options, '--claim') || (command === 'resume' && !UUID.test(options['--claim']))
        : !path.isAbsolute(options['--directory'] || '') || options['--claim'] ||
          (command === 'restore' && !/^[a-f0-9]{64}$/.test(options['--digest'] || '')) ||
          (command === 'export' && options['--digest']))) throw fail('COMPOSE_OPERATOR_USAGE');
  return { command, tenant: options['--tenant'], directory: options['--directory'], digest: options['--digest'], claimId: options['--claim'] };
}

async function main (args = process.argv.slice(2)) {
  const options = argumentsFor(args), config = loadConfig(), artifacts = require('../../lib/tenant-lifecycle/filesystem-artifact');
  tenantFor(config, options.tenant);
  if (options.command === 'inspect' || options.command === 'resume') return await recover(config, options.command, options.tenant, options.claimId);
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
module.exports = { targetLocks, selectionOptions, validateConfig, loadConfig, loadDemoConfig, lifecycleFor, tenantFor, capture, restore, recover, recoveryController, argumentsFor, main };
