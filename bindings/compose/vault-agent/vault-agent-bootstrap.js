#!/usr/bin/env node
'use strict';

// One-shot provisioning step for the Vault Agent sidecar. Runs after the imported
// deploy/multitenant/bootstrap.js, in the application image, on the private network.
// It never prints a credential; every credential is described by its file location.
//
//   provision  enable AppRole, write one Transit policy, create the role, write
//              role_id + secret_id (0600) into /state/vault-agent/creds, point the api
//              document at the token sink, record completion
//   secret-id  re-issue the secret_id only (after an Agent restart)
const fs = require('node:fs'), path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const fail = code => Object.assign(new Error(code), { code });
const DURATION = /^[1-9][0-9]{0,5}[smh]$/;
const SINK = '/run/ns-vault/token';

function input (env = process.env) {
  if (env.NS_VAULT_AGENT_BOOTSTRAP !== '1' || !/^\/[\w/.-]+$/.test(env.NS_BOOTSTRAP_OUTPUT || '')) throw fail('EXPLICIT_VAULT_AGENT_BOOTSTRAP_REQUIRED');
  const vault = new URL(env.VAULT_ADDR || 'https://vault:8200');
  if (vault.protocol !== 'https:' || vault.username || vault.password || vault.pathname !== '/' || vault.search || vault.hash) throw fail('BOOTSTRAP_VAULT_HTTPS_REQUIRED');
  const ttl = env.NS_VAULT_AGENT_TOKEN_TTL || '1h', maxTtl = env.NS_VAULT_AGENT_TOKEN_MAX_TTL || '24h';
  if (!DURATION.test(ttl) || !DURATION.test(maxTtl)) throw fail('VAULT_AGENT_TTL_INVALID');
  const replicas = env.NS_API_REPLICAS || '1';
  if (!/^[1-9][0-9]?$/.test(replicas) || Number(replicas) > 16) throw fail('VAULT_AGENT_API_ROSTER_INVALID');
  return { vault, output: path.resolve(env.NS_BOOTSTRAP_OUTPUT), ttl, maxTtl, replicas: Number(replicas), keepEnvTokens: env.NS_VAULT_AGENT_KEEP_ENV_TOKENS === '1' };
}

function readPrivateJson (file) {
  const stat = fs.lstatSync(file);
  if (stat.size > 67108864) throw fail('VAULT_AGENT_PRIVATE_FILE_TOO_LARGE');
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw fail('VAULT_AGENT_PRIVATE_FILE_REQUIRED');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writePrivate (file, value, { flag = 'wx' } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600, flag });
  fs.chmodSync(file, 0o600);
}

// The serving policy is fixed in size. Private provisioning/management-issuer
// identities remain separate; the Agent never receives their key-management rights.
function policyRules (layout, mode) {
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(layout.mount) || !/^[a-z][a-z0-9_]{0,50}$/.test(layout.prefix) || !['registry', 'static'].includes(mode)) throw fail('VAULT_AGENT_LAYOUT_INVALID');
  const key = purpose => mode === 'registry' ? 'tenant-' + purpose + '-*' : 'tenant-*-' + purpose;
  const rules = [['decrypt','data'],['hmac','signing'],['verify','signing'],['sign','access']]
    .map(([operation, purpose]) => 'path "' + layout.mount + '/' + operation + '/' + key(purpose) + '" { capabilities = ["update"] }');
  rules.push('path "auth/token/renew-self" { capabilities = ["update"] }', 'path "auth/token/lookup-self" { capabilities = ["read"] }');
  return rules.join('\n');
}
function apiNames (replicas) {
  if (!Number.isSafeInteger(replicas) || replicas < 1 || replicas > 16) throw fail('VAULT_AGENT_API_ROSTER_INVALID');
  return Array.from({ length: replicas }, (_, i) => i ? 'api-' + (i + 1) : 'api');
}
function selectApi (config, environment) {
  const next = structuredClone(config), env = { ...environment }, removedEnvironment = [];
  let mode;
  if (next.registry && next.tenants === undefined && next.vault && typeof next.vault.tokenFile === 'string') {
    mode = 'registry'; delete next.vault.tokenEnv; next.vault.tokenFile = SINK;
  } else if (!next.registry && Array.isArray(next.tenants) && next.tenants.length && next.tenants.length <= 10000) {
    mode = 'static';
    for (const tenant of next.tenants) {
      if (!tenant.vault || typeof tenant.vault.tokenEnv !== 'string' || !/^NS_VAULT_[0-9]{1,5}$/.test(tenant.vault.tokenEnv)) throw fail('IMPORTED_API_CONFIG_INVALID');
      removedEnvironment.push(tenant.vault.tokenEnv); delete tenant.vault.tokenEnv; tenant.vault.tokenFile = SINK;
    }
  } else throw fail('IMPORTED_API_CONFIG_INVALID');
  return { config: next, environment: env, removedEnvironment, mode };
}
function replacePrivate (file, value) {
  const temporary = path.join(path.dirname(file), '.vault-agent-' + randomBytes(12).toString('hex'));
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(descriptor, value); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

async function run (command, options) {
  const { vault, output, ttl, maxTtl, keepEnvTokens } = options;
  const replicas = options.replicas === undefined ? 1 : options.replicas;
  const bootstrapDir = path.join(output, 'bootstrap'), agentDir = path.join(output, 'vault-agent');
  if (!fs.existsSync(path.join(bootstrapDir, 'complete.json'))) throw fail('IMPORTED_BOOTSTRAP_INCOMPLETE');
  const imported = readPrivateJson(path.join(bootstrapDir, 'complete.json'));
  if (imported.version !== 2 || !/^[a-f0-9]{40}$/.test(imported.sourceCommit || '') || !/^[a-f0-9]{40}$/.test(imported.deployCommit || '')) throw fail('IMPORTED_BOOTSTRAP_STATE_INVALID');
  const rootToken = readPrivateJson(path.join(bootstrapDir, 'vault-init.json')).root_token;
  const layout = readPrivateJson(path.join(bootstrapDir, 'layout.json'));
  if (typeof rootToken !== 'string' || !rootToken || typeof layout.mount !== 'string' || typeof layout.prefix !== 'string') throw fail('IMPORTED_BOOTSTRAP_STATE_INVALID');
  const roleName = layout.prefix + '_vault_agent', policyName = layout.prefix + '_vault_agent';
  async function request (resource, body, method = body === undefined ? 'GET' : 'POST', { accept = [] } = {}) {
    const response = await fetch(vault.origin + '/v1/' + resource, { method, headers: { 'Content-Type': 'application/json', 'X-Vault-Token': rootToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (!response.ok && !accept.includes(response.status)) { await response.body?.cancel(); throw fail('VAULT_AGENT_BOOTSTRAP_VAULT_REFUSED'); }
    if (response.status === 204) return {};
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
  const completeFile = path.join(agentDir, 'complete.json');
  const names = apiNames(replicas);
  let previous;
  if (fs.existsSync(completeFile)) {
    previous = readPrivateJson(completeFile);
    if (previous.version !== 2 || previous.sourceCommit !== imported.sourceCommit || previous.deployCommit !== imported.deployCommit ||
        previous.tokenTtl !== ttl || previous.tokenMaxTtl !== maxTtl || previous.envTokensKept !== keepEnvTokens ||
        JSON.stringify(previous.apiInstances) !== JSON.stringify(names) || previous.sink !== SINK ||
        previous.policySha256 !== createHash('sha256').update(policyRules(layout, previous.mode)).digest('hex')) throw fail('VAULT_AGENT_STATE_CHANGED');
    for (const name of names) {
      const config = readPrivateJson(path.join(output, name, 'config.json'));
      if (previous.mode === 'registry' ? !config.registry || config.vault?.tokenFile !== SINK || config.vault.tokenEnv !== undefined
          : !Array.isArray(config.tenants) || !config.tenants.length || config.tenants.some(row => row.vault?.tokenFile !== SINK || row.vault.tokenEnv !== undefined)) throw fail('VAULT_AGENT_STATE_CHANGED');
    }
  }
  if (command === 'secret-id') {
    if (!fs.existsSync(completeFile)) throw fail('VAULT_AGENT_NOT_PROVISIONED');
    const secret = await request('auth/approle/role/' + roleName + '/secret-id', {});
    if (typeof secret?.data?.secret_id !== 'string' || !secret.data.secret_id) throw fail('VAULT_AGENT_SECRET_ID_MISSING');
    writePrivate(path.join(agentDir, 'creds', 'secret_id'), secret.data.secret_id + '\n', { flag: 'w' });
    return { state: 'secret-id-reissued', location: '/state/vault-agent/creds/secret_id' };
  }
  if (command !== 'provision') throw fail('VAULT_AGENT_BOOTSTRAP_USAGE');
  if (previous) return { state: 'existing-vault-agent-provisioned' };
  const startedFile = path.join(agentDir, 'started.json');
  if (fs.existsSync(startedFile)) throw fail('VAULT_AGENT_PARTIAL_STATE');
  const selected = names.map(name => {
    const directory = path.join(output, name);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) throw fail('VAULT_AGENT_PRIVATE_FILE_REQUIRED');
    return { name, directory, ...selectApi(readPrivateJson(path.join(directory, 'config.json')), readPrivateJson(path.join(directory, 'env.json'))) };
  });
  if (new Set(selected.map(row => row.mode)).size !== 1) throw fail('VAULT_AGENT_API_MODE_MISMATCH');
  const mode = selected[0].mode, rules = policyRules(layout, mode);
  writePrivate(startedFile, JSON.stringify({ version: 2, sourceCommit: imported.sourceCommit, deployCommit: imported.deployCommit }) + '\n');
  // 400 "path is already in use" when a previous partial run enabled the method.
  await request('sys/auth/approle', { type: 'approle' }, 'POST', { accept: [400] });
  await request('sys/policies/acl/' + policyName, { policy: rules }, 'PUT');
  await request('auth/approle/role/' + roleName, { token_policies: [policyName], token_no_default_policy: true, token_type: 'service',
    token_ttl: ttl, token_max_ttl: maxTtl, secret_id_num_uses: 0, secret_id_ttl: '24h', bind_secret_id: true });
  const roleId = await request('auth/approle/role/' + roleName + '/role-id');
  const secret = await request('auth/approle/role/' + roleName + '/secret-id', {});
  if (typeof roleId?.data?.role_id !== 'string' || !roleId.data.role_id || typeof secret?.data?.secret_id !== 'string' || !secret.data.secret_id) throw fail('VAULT_AGENT_ROLE_MATERIAL_MISSING');
  fs.mkdirSync(path.join(agentDir, 'sink'), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(agentDir, 'sink'), 0o700);
  writePrivate(path.join(agentDir, 'creds', 'role_id'), roleId.data.role_id + '\n');
  writePrivate(path.join(agentDir, 'creds', 'secret_id'), secret.data.secret_id + '\n');
  // Apply the same sink to every exact API instance. This never enumerates the
  // registry's tenants or reads their Vault policies.
  for (const row of selected) {
    if (!keepEnvTokens) for (const key of row.removedEnvironment) delete row.environment[key];
    replacePrivate(path.join(row.directory, 'config.json'), JSON.stringify(row.config) + '\n');
    replacePrivate(path.join(row.directory, 'env.json'), JSON.stringify(row.environment) + '\n');
  }
  writePrivate(completeFile, JSON.stringify({ version: 2, sourceCommit: imported.sourceCommit, deployCommit: imported.deployCommit, role: roleName, policy: policyName, policySha256: createHash('sha256').update(rules).digest('hex'),
    tokenTtl: ttl, tokenMaxTtl: maxTtl, sink: SINK, envTokensKept: keepEnvTokens, mode, apiInstances: selected.map(row => row.name) }, null, 2) + '\n');
  return { state: 'vault-agent-provisioned', role: roleName, policy: policyName, tokenTtl: ttl, tokenMaxTtl: maxTtl, credentials: '/state/vault-agent/creds/{role_id,secret_id}', sink: SINK, envTokensKept: keepEnvTokens };
}

if (require.main === module) {
  Promise.resolve().then(() => run(process.argv[2] || 'provision', input())).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(JSON.stringify({ error: /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'VAULT_AGENT_BOOTSTRAP_FAILED' }) + '\n'); process.exitCode = 1; });
}
module.exports = { input, run, policyRules, apiNames, selectApi, replacePrivate, SINK };
