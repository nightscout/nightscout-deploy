#!/usr/bin/env node
'use strict';

// Renders every role's private documents before apply, from seeded credentials (decision
// provisioning-secrets-in). No database, Vault or network access: the documents depend only on
// the plan, the selected roster and the seeded values, so a Kubernetes seed step can turn them
// into Secrets and Compose can mount them. Interim until the role documents retire
// (config-few-dozen-env).
//
//   NS_CREDENTIALS_DIR=<seeded dir> NS_RENDER_OUTPUT=<state dir> node render.js
//
// Rendering again replaces the documents in place, so a changed setting converges on the next up.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const fail = code => Object.assign(new Error(code), { code });

function input (env = process.env) {
  const absolute = value => /^\/[\w/.-]+$/.test(value || '');
  if (!absolute(env.NS_CREDENTIALS_DIR) || !absolute(env.NS_RENDER_OUTPUT)) throw fail('RENDER_PATHS_REQUIRED');
  const vault = new URL(env.VAULT_ADDR || 'https://vault:8200');
  if (vault.protocol !== 'https:' || vault.username || vault.password || vault.pathname !== '/' || vault.search || vault.hash) throw fail('RENDER_VAULT_HTTPS_REQUIRED');
  const port = Number(env.NS_POSTGRES_PORT || 5432);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw fail('RENDER_POSTGRES_ADDRESS_INVALID');
  const postgres = { host: env.NS_POSTGRES_HOST || 'postgres', port, database: env.NS_POSTGRES_DATABASE || 'nightscout_compose_test' };
  if (!/^[a-z0-9.-]{1,253}$/.test(postgres.host) || postgres.database !== 'nightscout_compose_test') throw fail('RENDER_POSTGRES_ADDRESS_INVALID');
  // Off by default. compose.yaml passes the same value to every role as MULTITENANT_CONFIG_MAX_BYTES
  // (core config-file.js, 65,536..67,108,864); rendering validates against it.
  const capRaw = env.NS_BOOTSTRAP_CONFIG_MAX_BYTES || '';
  if (capRaw && (!/^[1-9][0-9]{0,9}$/.test(capRaw) || Number(capRaw) < 65536 || Number(capRaw) > 67108864)) throw fail('BOOTSTRAP_CONFIG_MAX_BYTES_INVALID');
  const sink = env.NS_API_VAULT_TOKEN_FILE || '/run/ns-config/vault-token';
  if (!absolute(sink)) throw fail('RENDER_VAULT_TOKEN_FILE_INVALID');
  if (env.NS_SOURCE_COMMIT !== undefined && !/^[a-f0-9]{40}$/.test(env.NS_SOURCE_COMMIT)) throw fail('RENDER_SOURCE_IDENTITY_INVALID');
  return { credentials: path.resolve(env.NS_CREDENTIALS_DIR), output: path.resolve(env.NS_RENDER_OUTPUT), vault, postgres,
    configMaxBytes: capRaw ? Number(capRaw) : undefined, apiVaultTokenFile: sink, sourceCommit: env.NS_SOURCE_COMMIT };
}

// Replace one private file whole: written beside the target and renamed, 0600 in a 0700 directory.
function write (file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), '.render-' + crypto.randomBytes(8).toString('hex'));
  try { fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
// Role documents are compact (about a third smaller); operator files stay indented.
const json = (file, value, compact = true) => write(file, (compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)) + '\n');
const token = (file, value) => write(file, value + '\n');

function documents ({ credentials, vault, postgres, apiVaultTokenFile }) {
  require('./pgstream').enabled();
  const plan = require('./config'), layout = plan.layout(), seeded = require('./credentials').read(credentials, Object.keys(layout.roles));
  const roleURLs = require('./credentials').urls(layout, seeded.postgres, postgres);
  const workers = require('./evaluator-workers'), evaluatorWorkers = workers.selection();
  if (evaluatorWorkers) workers.assertSeed(evaluatorWorkers);
  const realtimeOwnership = require('./realtime-workers').initial(require('./realtime-workers').selection());
  const docs = plan.documents({ layout, urls: roleURLs, vaultAddress: vault.origin, registryMode: true, realtimeOwnership });
  // Kubernetes points the api at its Vault Agent sink; Compose keeps the seeded token file.
  for (const [role, config] of Object.entries(docs.configs)) if ((role === 'api' || role.startsWith('api-')) && config.vault) config.vault.tokenFile = apiVaultTokenFile;
  return { plan, layout, docs, roleURLs, tokens: seeded.vault };
}

function render (options) {
  const { output, configMaxBytes, sourceCommit } = options;
  const { plan, layout: l, docs, roleURLs, tokens } = documents(options);
  for (const role of Object.keys(docs.configs)) {
    const dir = path.join(output, role);
    json(path.join(dir, 'env.json'), docs.environments[role]);
    json(path.join(dir, 'config.json'), docs.configs[role]);
    json(path.join(dir, 'operation.json'), docs.operations[role]);
    if (role === 'tenant-admin') token(path.join(dir, 'vault-token'), tokens['owner-credentials']);
    if (role === 'evaluator' && docs.configs[role].pgstream) {
      const assignment = docs.environments[role].NS_PGSTREAM_EVALUATOR_SLICE === undefined ? undefined : JSON.parse(docs.environments[role].NS_PGSTREAM_EVALUATOR_SLICE);
      json(path.join(output, 'pgstream', 'pgstream.yaml'), require('./pgstream').wire(docs.configs[role], roleURLs.pgstream, { assignment }));
    }
    if (role === 'api' || role.startsWith('api-')) {
      token(path.join(dir, 'vault-token'), tokens.api);
      json(path.join(dir, 'evaluator-metadata.json'), docs.configs.evaluator);
    }
  }
  json(path.join(output, 'admin', 'env.json'), docs.admin.environment);
  json(path.join(output, 'admin', 'config.json'), docs.admin.config);
  token(path.join(output, 'admin', 'vault-token'), tokens.provisioner);
  token(path.join(output, 'admin', 'management-vault-token'), tokens['management-issuer']);
  json(path.join(output, 'ui', 'config.json'), docs.ui);
  json(path.join(output, 'ui', 'env.json'), docs.uiEnvironment);
  const source = configMaxBytes === undefined ? docs : { ...docs, environments: Object.fromEntries(Object.entries(docs.environments).map(([role, env]) => [role, { ...env, MULTITENANT_CONFIG_MAX_BYTES: String(configMaxBytes) }])) };
  plan.validateFiles(output, source);
  require('../../lib/server/serve/admin-config').parse(docs.admin.config, docs.admin.environment);
  json(path.join(output, 'primer', 'config.json'), { version: 1, adminOrigin: 'http://admin:1342', apiOrigin: docs.apiOrigin || 'http://api:1337', ownerConsumer: docs.configs['tenant-admin'].management.consumer }, false);
  json(path.join(output, 'ops', 'config.json'), { version: 3, drainTimeoutMs: 10000,
    apiOrigin: docs.apiOrigin || 'http://api:1337', control: { namespace: l.namespaces.control, registry: { namespace: l.namespaces.registry } }, ...plan.lifecycle(l) }, false);
  json(path.join(output, 'ops', 'env.json'), { NS_OPERATOR_PG: roleURLs.operator, NS_AUTH_AUDIT_PG: roleURLs.api, ...(sourceCommit ? { NS_SOURCE_COMMIT: sourceCommit } : {}) }, false);
  token(path.join(output, 'ops', 'vault-token'), tokens.api);
  return { state: 'documents-rendered', roles: Object.keys(docs.configs).length, evaluatorWorkers: docs.evaluatorWorkers?.workers };
}

if (require.main === module) {
  try { process.umask(0o077); console.log(JSON.stringify(render(input()))); }
  catch (error) { console.error(JSON.stringify(require('./bootstrap').report(error))); process.exitCode = 1; }
}
module.exports = { input, documents, render };
