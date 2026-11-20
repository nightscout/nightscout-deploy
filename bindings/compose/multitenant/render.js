#!/usr/bin/env node
'use strict';

// Materialize only the credentials each role may read. The platform supplies
// the ordinary settings in its container environment. The standalone pgstream,
// UI and lab/operator programs still consume their own configuration formats.
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
  if (env.NS_SOURCE_COMMIT !== undefined && !/^[a-f0-9]{40}$/.test(env.NS_SOURCE_COMMIT)) throw fail('RENDER_SOURCE_IDENTITY_INVALID');
  return { credentials: path.resolve(env.NS_CREDENTIALS_DIR), output: path.resolve(env.NS_RENDER_OUTPUT), vault, postgres,
    useAgent: !!env.NS_API_VAULT_TOKEN_FILE, inputTransport: require('./input-transport').selection(env), sourceCommit: env.NS_SOURCE_COMMIT };
}

// Replace one private file whole: written beside the target and renamed, 0600 in a 0700 directory.
function write (file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), '.render-' + crypto.randomBytes(8).toString('hex'));
  try { fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
// Private inputs for the standalone clients.
const json = (file, value, compact = true) => write(file, (compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)) + '\n');
const token = (file, value) => write(file, value + '\n');

const connections = {
  api: { NS_API_PG: 'api', NS_READINESS_PG: 'readiness', NS_API_ROOT_WRITER_PG: 'root_writer', NS_ALARM_PG: 'alarm', NS_DISPLAY_PG: 'display_reader', NS_LIFETIME_PG: 'lifetime_api' },
  realtime: { NS_REALTIME_PG: 'realtime', NS_DISPLAY_PG: 'display_reader', NS_LIFETIME_PG: 'lifetime_realtime' },
  evaluator: { NS_EVALUATOR_PG: 'evaluator', NS_OUTBOX_PG: 'outbox', NS_SUPPRESSION_PG: 'suppression', NS_ACTIVITY_PG: 'activity_reader', NS_DISPLAY_PG: 'display_reader', NS_STREAM_RECOVERY_PG: 'pgstream', NS_LIFETIME_PG: 'lifetime_evaluator' },
  'tenant-admin': { NS_OWNER_WRITER_PG: 'owner_writer', NS_OWNER_READER_PG: 'owner_reader', NS_OWNER_CREDENTIALS_PG: 'owner_credentials', NS_OWNER_SETTINGS_PG: 'owner_settings', NS_LIFETIME_PG: 'lifetime_tenant_admin' },
  admin: { NS_PROVISIONER_PG: 'provisioner', NS_OWNERSHIP_PG: 'ownership_operator', NS_CONNECTOR_SOURCES_PG: 'connector_writer', NS_MANAGEMENT_SESSIONS_PG: 'management_issuer' },
};

// This is the one incarnation of the physical replication slot. On a binding
// upgrade preserve the generation recorded by the previous evaluator document.
function streamGeneration (output) {
  const dir = path.join(output, 'evaluator'), file = path.join(dir, 'ns_pgstream_generation');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) {
    const prior = path.join(dir, 'config.json');
    const value = fs.existsSync(prior) ? JSON.parse(fs.readFileSync(prior, 'utf8')).pgstream.generation : crypto.randomBytes(16).toString('hex');
    if (!/^[a-f0-9]{32}$/.test(value)) throw fail('STREAM_GENERATION_INVALID');
    try { fs.writeFileSync(file, value + '\n', { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{32}$/.test(value)) throw fail('STREAM_GENERATION_INVALID');
  return value;
}

function render ({ output, credentials, postgres, useAgent, sourceCommit, inputTransport = require('./input-transport').selection() }) {
  const plan = require('./config'), l = plan.layout(undefined, inputTransport);
  const seeded = require('./credentials').read(credentials, Object.keys(l.roles));
  const roleURLs = require('./credentials').urls(l, seeded.postgres, postgres);
  const tokens = seeded.vault;
  const replicas = require('./replicas'), workers = require('./evaluator-workers'), realtime = require('./realtime-workers');
  const apis = replicas.instances(replicas.count()), generation = inputTransport === 'pgstream' ? streamGeneration(output) : null;
  const services = {
    api: apis.map(instance => instance.service), evaluator: workers.services(workers.selection()),
    realtime: realtime.services(realtime.selection()).filter(name => name !== 'socket-edge'), 'tenant-admin': ['tenant-admin'], admin: ['admin']
  };
  for (const [role, instances] of Object.entries(services)) {
    for (const name of instances) {
      const dir = path.join(output, name);
      for (const [setting, login] of Object.entries(connections[role])) if (generation || setting !== 'NS_STREAM_RECOVERY_PG') token(path.join(dir, setting.toLowerCase()), roleURLs[login]);
      if (role === 'api') {
        const file = path.join(dir, 'vault-token');
        if (useAgent) fs.rmSync(file, { force: true });
        else token(file, tokens.api);
      }
      if (generation && role === 'evaluator' && name !== 'evaluator') token(path.join(dir, 'ns_pgstream_generation'), generation);
      if (role === 'tenant-admin') token(path.join(dir, 'vault-token'), tokens['owner-credentials']);
      if (role === 'admin') {
        token(path.join(dir, 'vault-token'), tokens.provisioner);
        token(path.join(dir, 'management-vault-token'), tokens['management-issuer']);
      }
      // A seeded project may have been rendered by the earlier JSON binding.
      for (const retired of ['env.json', 'config.json', 'operation.json', 'evaluator-metadata.json']) fs.rmSync(path.join(dir, retired), { force: true });
    }
  }
  const stream = require('./pgstream');
  if (generation) json(path.join(output, 'pgstream', 'pgstream.yaml'), stream.wire(stream.descriptor(l, workers.selection()), roleURLs.pgstream));
  json(path.join(output, 'ui', 'config.json'), { version: 2, registry: { connectionEnv: 'NS_UI_REGISTRY_PG', namespace: l.namespaces.registry, refreshMs: 2000 }, theme: 'default' });
  json(path.join(output, 'ui', 'env.json'), { NS_UI_REGISTRY_PG: roleURLs.ui_registry });
  const apiOrigin = apis.length > 1 ? 'http://api-internal:1337' : 'http://api:1337';
  json(path.join(output, 'primer', 'config.json'), { version: 1, adminOrigin: 'http://admin:1342', apiOrigin, ownerConsumer: 'compose-owner' }, false);
  json(path.join(output, 'ops', 'config.json'), { version: 3, drainTimeoutMs: 10000,
    apiOrigin, nativeSelection: plan.nativeSelection(l.prefix).binding, control: { namespace: l.namespaces.control, registry: { namespace: l.namespaces.registry } }, ...plan.lifecycle(l) }, false);
  json(path.join(output, 'ops', 'env.json'), { NS_OPERATOR_PG: roleURLs.operator, NS_AUTH_AUDIT_PG: roleURLs.api, ...(sourceCommit ? { NS_SOURCE_COMMIT: sourceCommit } : {}) }, false);
  token(path.join(output, 'ops', 'vault-token'), tokens.api);
  return { state: 'credentials-rendered', roles: Object.values(services).flat().length };
}

if (require.main === module) {
  try { process.umask(0o077); console.log(JSON.stringify(render(input()))); }
  catch (error) { console.error(JSON.stringify(require('./bootstrap').report(error))); process.exitCode = 1; }
}
module.exports = { input, connections, render, write };
