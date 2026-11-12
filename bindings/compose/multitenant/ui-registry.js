'use strict';

// Public presentation admission uses only the registry's fixed host-lookup and
// revision capabilities. Configuration cannot select a module or SQL body.
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const fail = code => Object.assign(new Error(code), { code });
function parse(config) {
  const exact = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value) && required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k));
  if (!exact(config, ['version', 'registry', 'theme']) || config.version !== 2 || !['default', 'modern'].includes(config.theme) ||
      !exact(config.registry, ['connectionEnv', 'namespace'], ['maxTenants', 'refreshMs', 'maxInflight'])) throw fail('UI_REGISTRY_CONFIG_INVALID');
  const r = { maxTenants: 10000, refreshMs: 2000, maxInflight: 32, ...config.registry };
  if (!/^[A-Z][A-Z0-9_]*$/.test(r.connectionEnv) || !NAME.test(r.namespace) || ['public', 'information_schema'].includes(r.namespace) || r.namespace.startsWith('pg_') ||
      !Number.isSafeInteger(r.maxTenants) || r.maxTenants < 1 || r.maxTenants > 100000 || !Number.isSafeInteger(r.refreshMs) || r.refreshMs < 250 || r.refreshMs > 60000 ||
      !Number.isSafeInteger(r.maxInflight) || r.maxInflight < 1 || r.maxInflight > 256) throw fail('UI_REGISTRY_CONFIG_INVALID');
  return Object.freeze({ ...r, theme: config.theme });
}
async function authority(connection, namespace) {
  const rows = (await connection.readOnly(`SELECT r.rolcanlogin,r.rolsuper,r.rolbypassrls,r.rolreplication,r.rolcreatedb,r.rolcreaterole,
    EXISTS(SELECT 1 FROM pg_catalog.pg_roles x WHERE x.oid<>r.oid AND pg_catalog.pg_has_role(r.oid,x.oid,'MEMBER')) AS member,
    EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
      AND c.relkind IN ('r','p','v','m','f') AND (
        pg_catalog.pg_has_role(r.oid,c.relowner,'MEMBER') OR
        pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
        pg_catalog.has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES') OR
        ((n.nspname<>$1 OR c.relname<>'schema_migrations') AND pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT')))) AS data_access,
    EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE')
      AND NOT(n.nspname=$1 AND p.oid IN (pg_catalog.to_regprocedure($1||'.tenant_registry_lookup(text,text)'),pg_catalog.to_regprocedure($1||'.tenant_registry_revision()')))) AS extra_definer,
    EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND CASE WHEN c.relkind='S' THEN pg_catalog.has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE') ELSE false END) AS sequence_access
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`, [namespace])).rows;
  if (rows.length !== 1 || !rows[0].rolcanlogin || ['rolsuper', 'rolbypassrls', 'rolreplication', 'rolcreatedb', 'rolcreaterole', 'member', 'data_access', 'extra_definer', 'sequence_access'].some(key => rows[0][key])) throw fail('UI_REGISTRY_AUTHORITY_UNSAFE');
}
function create({ settings, store, resolverFactory, close = async () => {}, resolverOptions = {} }) {
  let inflight = 0, closed = false, closing;
  const presentation = Object.freeze({ theme: settings.theme });
  const resolver = resolverFactory({ store, mode: 'direct-alias', maxTenants: settings.maxTenants, refreshMs: settings.refreshMs,
    ...resolverOptions, onError: () => {} });
  return Object.freeze({
    async start() { return resolver.start(); },
    async resolve(request) {
      if (closed || inflight >= settings.maxInflight) throw fail('UI_REGISTRY_UNAVAILABLE');
      inflight++;
      try { await resolver.resolve(request); return presentation; }
      finally { inflight--; }
    },
    poll: () => resolver.poll(),
    stats: () => ({ ...resolver.stats(), inflight, closed }),
    close() { if (!closing) { closed = true; resolver.close(); closing = Promise.resolve().then(close); } return closing; }
  });
}
async function open({ config, source = process.env, root = ROOT } = {}) {
  const settings = parse(config), connectionString = source[settings.connectionEnv];
  if (typeof connectionString !== 'string' || !connectionString) throw fail('UI_REGISTRY_CONNECTION_REQUIRED');
  const connection = await require(path.join(root, 'lib/storage/postgres-connection'))({ connectionString, max: 2,
    connectionTimeoutMillis: 2000, statement_timeout: 2000, query_timeout: 2500, application_name: 'nightscout-ui-registry' });
  let reader;
  try {
    await authority(connection, settings.namespace);
    const store = require(path.join(root, 'lib/tenant-registry/postgres')).create({ connection, namespace: settings.namespace });
    reader = create({ settings, store, resolverFactory: require(path.join(root, 'lib/tenant-registry/resolver')).createRegistryResolver, close: () => connection.end() });
    await reader.start();
    return reader;
  } catch (error) { if (reader) await reader.close().catch(() => {}); else await connection.end().catch(() => {}); throw error; }
}
module.exports = { parse, authority, create, open };
