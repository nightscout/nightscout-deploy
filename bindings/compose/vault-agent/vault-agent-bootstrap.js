#!/usr/bin/env node
'use strict';

// Private deployment provisioning only. Serving renewal/login belong to Vault
// Agent. No tenant policy, key or lease enumeration occurs here.
const fs = require('node:fs'), path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const fail = code => Object.assign(new Error(code), { code });
const HASH = /^[a-f0-9]{40}$/, SINK = '/run/ns-vault/token';
const FILE_BOUND = 67108864, RESPONSE_BOUND = 262144;
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const digest = v => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(canonical(v))).digest('hex');
function duration (value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,5}[smh]$/.test(value)) throw fail('VAULT_AGENT_TTL_INVALID');
  return Number(value.slice(0, -1)) * ({ s: 1, m: 60, h: 3600 }[value.at(-1)]);
}
function input (env = process.env) {
  if (env.NS_VAULT_AGENT_BOOTSTRAP !== '1' || !/^\/[\w/.-]+$/.test(env.NS_BOOTSTRAP_OUTPUT || '') ||
      !HASH.test(env.NS_SOURCE_COMMIT || '') || !HASH.test(env.NS_DEPLOY_COMMIT || '')) throw fail('EXPLICIT_VAULT_AGENT_BOOTSTRAP_REQUIRED');
  let vault; try { vault = new URL(env.VAULT_ADDR); } catch { throw fail('BOOTSTRAP_VAULT_HTTPS_REQUIRED'); }
  if (vault.protocol !== 'https:' || vault.username || vault.password || vault.pathname !== '/' || vault.search || vault.hash) throw fail('BOOTSTRAP_VAULT_HTTPS_REQUIRED');
  const ttl = env.NS_VAULT_AGENT_TOKEN_TTL || '1h', maxTtl = env.NS_VAULT_AGENT_TOKEN_MAX_TTL || '24h';
  if (duration(ttl) > duration(maxTtl) || duration(maxTtl) > 86400 * 32) throw fail('VAULT_AGENT_TTL_INVALID');
  if (env.NS_VAULT_AGENT_KEEP_ENV_TOKENS !== undefined && !['0', '1'].includes(env.NS_VAULT_AGENT_KEEP_ENV_TOKENS)) throw fail('VAULT_AGENT_CONTROL_INVALID');
  const replicas = env.NS_API_REPLICAS || '1'; apiNames(Number(replicas));
  if (!/^[1-9][0-9]?$/.test(replicas)) throw fail('VAULT_AGENT_API_ROSTER_INVALID');
  return { vault, output: path.resolve(env.NS_BOOTSTRAP_OUTPUT), ttl, maxTtl, replicas: Number(replicas),
    sourceCommit: env.NS_SOURCE_COMMIT, deployCommit: env.NS_DEPLOY_COMMIT, project: env.NS_VAULT_AGENT_PROJECT, keepEnvTokens: env.NS_VAULT_AGENT_KEEP_ENV_TOKENS === '1' };
}
function directory (file) {
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid() || fs.realpathSync(file) !== file) throw fail('VAULT_AGENT_PRIVATE_DIRECTORY_REQUIRED');
}
function privateBytes (file, maximum = FILE_BOUND) {
  directory(path.dirname(file));
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.mode & 0o077 || before.uid !== process.getuid()) throw fail('VAULT_AGENT_PRIVATE_FILE_REQUIRED');
  if (before.size > maximum) throw fail('VAULT_AGENT_PRIVATE_FILE_TOO_LARGE');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.mode & 0o077 || stat.uid !== process.getuid()) throw fail('VAULT_AGENT_PRIVATE_FILE_REQUIRED');
    const chunks = []; let total = 0;
    while (total <= maximum) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, maximum + 1 - total)), n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break; chunks.push(chunk.subarray(0, n)); total += n;
    }
    if (total > maximum) throw fail('VAULT_AGENT_PRIVATE_FILE_TOO_LARGE');
    return Buffer.concat(chunks, total);
  } finally { fs.closeSync(fd); }
}
function json (file) { try { return JSON.parse(privateBytes(file).toString('utf8')); } catch (error) { if (error.code) throw error; throw fail('VAULT_AGENT_PRIVATE_JSON_INVALID'); } }
function exists (file) { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function createDirectory (file) { directory(path.dirname(file)); if (!exists(file)) fs.mkdirSync(file, { mode: 0o700 }); directory(file); }
function replacePrivate (file, value, { exclusive = false } = {}) {
  directory(path.dirname(file));
  if (exists(file)) { privateBytes(file); if (exclusive) throw fail('VAULT_AGENT_PARTIAL_STATE'); }
  const temporary = path.join(path.dirname(file), '.vault-agent-' + randomBytes(12).toString('hex'));
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, value); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (exclusive) { fs.linkSync(temporary, file); fs.unlinkSync(temporary); } else fs.renameSync(temporary, file);
    const directoryFd = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } finally { if (fd !== undefined) fs.closeSync(fd); if (exists(temporary)) fs.unlinkSync(temporary); }
}
function policyRules (layout, mode) {
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(layout.mount) || !/^[a-z][a-z0-9_]{0,50}$/.test(layout.prefix) || !['registry', 'static'].includes(mode)) throw fail('VAULT_AGENT_LAYOUT_INVALID');
  const key = purpose => mode === 'registry' ? 'tenant-' + purpose + '-*' : 'tenant-*-' + purpose;
  return [...[['decrypt', 'data'], ['hmac', 'signing'], ['verify', 'signing'], ['sign', 'access']]
    .map(([operation, purpose]) => 'path "' + layout.mount + '/' + operation + '/' + key(purpose) + '" { capabilities = ["update"] }'),
  'path "auth/token/renew-self" { capabilities = ["update"] }', 'path "auth/token/lookup-self" { capabilities = ["read"] }'].join('\n');
}
function apiNames (replicas) {
  if (!Number.isSafeInteger(replicas) || replicas < 1 || replicas > 16) throw fail('VAULT_AGENT_API_ROSTER_INVALID');
  return Array.from({ length: replicas }, (_, i) => i ? 'api-' + (i + 1) : 'api');
}
function selectApi (config, environment, { selected = false } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || !environment || typeof environment !== 'object' || Array.isArray(environment) ||
      Object.values(environment).some(v => typeof v !== 'string')) throw fail('IMPORTED_API_CONFIG_INVALID');
  const next = structuredClone(config), env = { ...environment }, removedEnvironment = [];
  let mode;
  if (next.registry && next.tenants === undefined && next.vault && typeof next.vault.tokenFile === 'string' && next.vault.tokenEnv === undefined) {
    mode = 'registry'; if (next.vault.tokenFile !== (selected ? SINK : '/run/ns-config/vault-token')) throw fail('IMPORTED_API_CONFIG_INVALID'); next.vault.tokenFile = SINK;
  } else if (!next.registry && Array.isArray(next.tenants) && next.tenants.length && next.tenants.length <= 10000) {
    mode = 'static'; const ids = new Set();
    for (const tenant of next.tenants) {
      if (typeof tenant.id !== 'string' || ids.has(tenant.id) || !tenant.vault) throw fail('IMPORTED_API_CONFIG_INVALID'); ids.add(tenant.id);
      if (selected) { if (tenant.vault.tokenFile !== SINK || tenant.vault.tokenEnv !== undefined) throw fail('IMPORTED_API_CONFIG_INVALID'); }
      else {
        if (tenant.vault.tokenFile !== undefined || typeof tenant.vault.tokenEnv !== 'string' || !/^NS_VAULT_[0-9]{1,5}$/.test(tenant.vault.tokenEnv) || !env[tenant.vault.tokenEnv]) throw fail('IMPORTED_API_CONFIG_INVALID');
        removedEnvironment.push(tenant.vault.tokenEnv); delete tenant.vault.tokenEnv; tenant.vault.tokenFile = SINK;
      }
    }
  } else throw fail('IMPORTED_API_CONFIG_INVALID');
  return { config: next, environment: env, removedEnvironment, mode };
}
// Use the shipping parser before authoritative state/Vault mutation. Its public
// interface reads a file, so candidate JSON has a private temporary lifetime;
// role credentials remain in memory and are never copied into that directory.
function validateApi (config, environment, roleDirectory) {
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vault-agent-config-check-'));
  try {
    const file = path.join(temporary, 'config.json'); fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    const source = Object.fromEntries(Object.entries(environment).map(([key, value]) => [key,
      value.startsWith('/run/ns-config/') ? path.join(roleDirectory, value.slice('/run/ns-config/'.length)) : value]));
    source.MULTITENANT_PREVIEW_CONFIG = file;
    if (process.env.MULTITENANT_CONFIG_MAX_BYTES) source.MULTITENANT_CONFIG_MAX_BYTES = process.env.MULTITENANT_CONFIG_MAX_BYTES;
    require(path.join(process.cwd(), 'lib/server/serve/preview-config')).load(source);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
function preflight (options) {
  const { output, sourceCommit, deployCommit, ttl, maxTtl, keepEnvTokens, vault } = options;
  if (!HASH.test(sourceCommit || '') || !HASH.test(deployCommit || '') || typeof keepEnvTokens !== 'boolean' || duration(ttl) > duration(maxTtl)) throw fail('VAULT_AGENT_SOURCE_REQUIRED');
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(options.project || '')) throw fail('VAULT_AGENT_PROJECT_REQUIRED');
  directory(output); directory(path.join(output, 'bootstrap'));
  const imported = json(path.join(output, 'bootstrap/complete.json')), layout = json(path.join(output, 'bootstrap/layout.json'));
  if (imported.version !== 2 || imported.sourceCommit !== sourceCommit || imported.deployCommit !== deployCommit) throw fail('IMPORTED_BOOTSTRAP_STATE_INVALID');
  const root = path.join(output, 'vault-agent'), names = apiNames(options.replicas), completeFile = path.join(root, 'complete.json');
  if (exists(root)) directory(root);
  const previous = exists(completeFile) ? json(completeFile) : null;
  const actual = fs.readdirSync(output).filter(name => /^api(?:-[0-9]+)?$/.test(name)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...names].sort())) throw fail('VAULT_AGENT_API_ROSTER_INVALID');
  const rows = names.map((name, index) => {
    const dir = path.join(output, name); directory(dir);
    const config = json(path.join(dir, 'config.json')), environment = json(path.join(dir, 'env.json')), operation = json(path.join(dir, 'operation.json'));
    const selected = selectApi(config, environment, { selected: !!previous });
    if (config.vault?.address !== vault.origin || config.vault?.mount !== layout.mount || environment.MULTITENANT_PREVIEW_CONFIG !== '/run/ns-config/config.json') throw fail('IMPORTED_API_CONFIG_INVALID');
    const peers = operation.participants?.filter(row => Array.isArray(row.roles) && row.roles.includes('api'));
    const ids = names.length === 1 ? ['api'] : names.map((_, i) => 'api-' + (i + 1));
    if (!peers || peers.length !== names.length || operation.participantId !== ids[index] || peers.some((peer, i) => peer.id !== ids[i] || peer.roles.length !== 1 ||
      names.length > 1 && peer.address?.url !== 'http://' + names[i] + ':7001')) throw fail('VAULT_AGENT_API_ROSTER_INVALID');
    if (!keepEnvTokens) for (const key of selected.removedEnvironment) delete selected.environment[key];
    (options.validateApi || validateApi)(selected.config, selected.environment, dir);
    return { name, dir, ...selected, configDigest: digest(config), environmentDigest: digest(environment), operationDigest: digest(operation) };
  });
  const mode = rows[0].mode;
  if (rows.some(row => row.mode !== mode || digest(row.config) !== digest(rows[0].config)) || (imported.registryMode === true) !== (mode === 'registry')) throw fail('VAULT_AGENT_API_MODE_MISMATCH');
  const rules = policyRules(layout, mode), role = layout.prefix + '_vault_agent';
  const identity = { version: 3, sourceCommit, deployCommit, project: options.project, bootstrapDigest: digest(imported), layoutDigest: digest(layout), mode,
    tokenTtl: ttl, tokenMaxTtl: maxTtl, envTokensKept: !!keepEnvTokens, vaultOrigin: vault.origin, sink: SINK, role, policy: role, policySha256: digest(rules),
    apiInstances: names, files: rows.map(row => ({ name: row.name, config: digest(row.config), environment: digest(row.environment), operation: row.operationDigest })) };
  if (previous) {
    const { roleIdDigest, ...recorded } = previous;
    if (digest(recorded) !== digest(identity) || typeof roleIdDigest !== 'string' || digest(privateBytes(path.join(root, 'creds/role_id'), 8192)) !== roleIdDigest) throw fail('VAULT_AGENT_STATE_CHANGED');
    if (!exists(path.join(root, 'started.json')) || digest(json(path.join(root, 'started.json'))) !== digest({ version: 3, identityDigest: digest(identity) })) throw fail('VAULT_AGENT_STATE_CHANGED');
    directory(path.join(root, 'sink')); directory(path.join(root, 'creds'));
    for (const file of ['sink/token', 'creds/secret_id']) if (exists(path.join(root, file))) privateBytes(path.join(root, file), 8192);
  } else if (exists(root) && fs.readdirSync(root).length) throw fail('VAULT_AGENT_PARTIAL_STATE');
  if (exists(path.join(root, 'rotation.started.json'))) throw fail('VAULT_AGENT_PARTIAL_STATE');
  return { root, rows, imported, layout, rules, identity, previous };
}
async function requestFactory (options) {
  const material = json(path.join(options.output, 'bootstrap/vault-init.json'));
  if (typeof material.root_token !== 'string' || !material.root_token || material.root_token.length > 8192) throw fail('IMPORTED_BOOTSTRAP_STATE_INVALID');
  const deadline = performance.now() + 60000; let calls = 0;
  return async (resource, body, method = body === undefined ? 'GET' : 'POST') => {
    if (++calls > 16 || !/^[a-zA-Z0-9_/-]+$/.test(resource)) throw fail('VAULT_AGENT_REQUEST_BOUND');
    const remaining = Math.ceil(deadline - performance.now()); if (remaining <= 0) throw fail('VAULT_AGENT_REQUEST_TIMEOUT');
    const response = await fetch(options.vault.origin + '/v1/' + resource, { method, headers: { 'Content-Type': 'application/json', 'X-Vault-Token': material.root_token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual', signal: AbortSignal.timeout(Math.min(10000, remaining)) });
    if (!response.ok) { await response.body?.cancel(); throw fail('VAULT_AGENT_BOOTSTRAP_VAULT_REFUSED'); }
    if (response.status === 204) return {};
    const chunks = []; let total = 0;
    for await (const chunk of response.body) { total += chunk.length; if (total > RESPONSE_BOUND) { await response.body?.cancel().catch(() => {}); throw fail('VAULT_AGENT_RESPONSE_BOUND'); } chunks.push(chunk); }
    try { const text = Buffer.concat(chunks).toString('utf8'); return text ? JSON.parse(text) : {}; } catch { throw fail('VAULT_AGENT_RESPONSE_INVALID'); }
  };
}
async function run (command, options) {
  if (!['plan', 'provision', 'secret-id'].includes(command)) throw fail('VAULT_AGENT_BOOTSTRAP_USAGE');
  const state = preflight(options), { root, rows, identity, previous } = state;
  if (command === 'plan') return { state: previous ? 'existing-vault-agent-provisioned' : 'vault-agent-planned', ...identity };
  if (command === 'secret-id' && !previous) throw fail('VAULT_AGENT_NOT_PROVISIONED');
  if (command === 'provision' && previous) return { state: 'existing-vault-agent-provisioned', sourceCommit: identity.sourceCommit, deployCommit: identity.deployCommit };
  // All local identity/custody checks precede filesystem or Vault mutations.
  const request = await requestFactory(options);
  if (command === 'secret-id') {
    replacePrivate(path.join(root, 'rotation.started.json'), JSON.stringify({ version: 3, identityDigest: digest(identity) }) + '\n', { exclusive: true });
    const secret = await request('auth/approle/role/' + identity.role + '/secret-id', {});
    if (typeof secret?.data?.secret_id !== 'string' || !secret.data.secret_id || secret.data.secret_id.length > 8192) throw fail('VAULT_AGENT_SECRET_ID_MISSING');
    replacePrivate(path.join(root, 'creds/secret_id'), secret.data.secret_id + '\n');
    fs.unlinkSync(path.join(root, 'rotation.started.json'));
    return { state: 'secret-id-reissued', location: '/state/vault-agent/creds/secret_id' };
  }
  createDirectory(root);
  replacePrivate(path.join(root, 'started.json'), JSON.stringify({ version: 3, identityDigest: digest(identity) }) + '\n', { exclusive: true });
  const auth = await request('sys/auth');
  if (auth['approle/'] && auth['approle/'].type !== 'approle') throw fail('VAULT_AGENT_AUTH_METHOD_REFUSED');
  if (!auth['approle/']) await request('sys/auth/approle', { type: 'approle' });
  await request('sys/policies/acl/' + identity.policy, { policy: state.rules }, 'PUT');
  await request('auth/approle/role/' + identity.role, { token_policies: [identity.policy], token_no_default_policy: true, token_type: 'service', token_ttl: options.ttl, token_max_ttl: options.maxTtl,
    secret_id_num_uses: 0, secret_id_ttl: '24h', bind_secret_id: true });
  const role = await request('auth/approle/role/' + identity.role + '/role-id'), secret = await request('auth/approle/role/' + identity.role + '/secret-id', {});
  if (typeof role?.data?.role_id !== 'string' || !role.data.role_id || role.data.role_id.length > 8192 || typeof secret?.data?.secret_id !== 'string' || !secret.data.secret_id || secret.data.secret_id.length > 8192) throw fail('VAULT_AGENT_ROLE_MATERIAL_MISSING');
  createDirectory(path.join(root, 'creds')); createDirectory(path.join(root, 'sink'));
  replacePrivate(path.join(root, 'creds/role_id'), role.data.role_id + '\n', { exclusive: true });
  replacePrivate(path.join(root, 'creds/secret_id'), secret.data.secret_id + '\n', { exclusive: true });
  for (const row of rows) {
    // Recheck original inputs immediately before replacing them. A partial run
    // remains refused, never declared idempotent or automatically repaired.
    if (digest(json(path.join(row.dir, 'config.json'))) !== row.configDigest || digest(json(path.join(row.dir, 'env.json'))) !== row.environmentDigest ||
        digest(json(path.join(row.dir, 'operation.json'))) !== row.operationDigest) throw fail('VAULT_AGENT_STATE_CHANGED');
    replacePrivate(path.join(row.dir, 'config.json'), JSON.stringify(row.config) + '\n');
    replacePrivate(path.join(row.dir, 'env.json'), JSON.stringify(row.environment) + '\n');
  }
  const complete = { ...identity, roleIdDigest: digest(privateBytes(path.join(root, 'creds/role_id'), 8192)) };
  replacePrivate(path.join(root, 'complete.json'), JSON.stringify(complete, null, 2) + '\n', { exclusive: true });
  return { state: 'vault-agent-provisioned', sourceCommit: identity.sourceCommit, deployCommit: identity.deployCommit, apiInstances: identity.apiInstances, mode: identity.mode };
}
if (require.main === module) Promise.resolve().then(() => run(process.argv[2] || 'provision', input())).then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(JSON.stringify({ error: /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'VAULT_AGENT_BOOTSTRAP_FAILED' })); process.exitCode = 1;
});
module.exports = { input, run, preflight, policyRules, apiNames, selectApi, replacePrivate, privateBytes, validateApi, digest, SINK };
