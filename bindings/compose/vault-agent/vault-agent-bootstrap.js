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
const fail = code => Object.assign(new Error(code), { code });
const DURATION = /^[1-9][0-9]{0,5}[smh]$/;
const SINK = '/run/ns-vault/token';

function input (env = process.env) {
  if (env.NS_VAULT_AGENT_BOOTSTRAP !== '1' || !/^\/[\w/.-]+$/.test(env.NS_BOOTSTRAP_OUTPUT || '')) throw fail('EXPLICIT_VAULT_AGENT_BOOTSTRAP_REQUIRED');
  const vault = new URL(env.VAULT_ADDR || 'https://vault:8200');
  if (vault.protocol !== 'https:' || vault.username || vault.password || vault.pathname !== '/' || vault.search || vault.hash) throw fail('BOOTSTRAP_VAULT_HTTPS_REQUIRED');
  const ttl = env.NS_VAULT_AGENT_TOKEN_TTL || '1h', maxTtl = env.NS_VAULT_AGENT_TOKEN_MAX_TTL || '24h';
  if (!DURATION.test(ttl) || !DURATION.test(maxTtl)) throw fail('VAULT_AGENT_TTL_INVALID');
  return { vault, output: path.resolve(env.NS_BOOTSTRAP_OUTPUT), ttl, maxTtl, keepEnvTokens: env.NS_VAULT_AGENT_KEEP_ENV_TOKENS === '1' };
}

function readPrivateJson (file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw fail('VAULT_AGENT_PRIVATE_FILE_REQUIRED');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writePrivate (file, value, { flag = 'wx' } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600, flag });
  fs.chmodSync(file, 0o600);
}

async function run (command, options) {
  const { vault, output, ttl, maxTtl, keepEnvTokens } = options;
  const bootstrapDir = path.join(output, 'bootstrap'), agentDir = path.join(output, 'vault-agent');
  if (!fs.existsSync(path.join(bootstrapDir, 'complete.json'))) throw fail('IMPORTED_BOOTSTRAP_INCOMPLETE');
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
  if (command === 'secret-id') {
    if (!fs.existsSync(completeFile)) throw fail('VAULT_AGENT_NOT_PROVISIONED');
    const secret = await request('auth/approle/role/' + roleName + '/secret-id', {});
    if (typeof secret?.data?.secret_id !== 'string' || !secret.data.secret_id) throw fail('VAULT_AGENT_SECRET_ID_MISSING');
    writePrivate(path.join(agentDir, 'creds', 'secret_id'), secret.data.secret_id + '\n', { flag: 'w' });
    return { state: 'secret-id-reissued', location: '/state/vault-agent/creds/secret_id' };
  }
  if (command !== 'provision') throw fail('VAULT_AGENT_BOOTSTRAP_USAGE');
  if (fs.existsSync(completeFile)) return { state: 'existing-vault-agent-provisioned' };
  // The api document the imported bootstrap wrote names every tenant key the serving
  // process uses. The Agent's single policy is the union of the imported per-tenant
  // policies, read from Vault, so it covers exactly those paths and nothing more.
  const apiDir = path.join(output, 'api'), apiConfig = readPrivateJson(path.join(apiDir, 'config.json')), apiEnv = readPrivateJson(path.join(apiDir, 'env.json'));
  if (!Array.isArray(apiConfig.tenants) || !apiConfig.tenants.length) throw fail('IMPORTED_API_CONFIG_INVALID');
  const rules = [];
  for (const [i, tenant] of apiConfig.tenants.entries()) {
    if (!tenant.vault || typeof tenant.vault.tokenEnv !== 'string') throw fail('IMPORTED_API_CONFIG_INVALID');
    const policy = await request('sys/policies/acl/' + layout.prefix + '_tenant_' + i);
    if (typeof policy?.data?.policy !== 'string' || !policy.data.policy) throw fail('IMPORTED_TENANT_POLICY_MISSING');
    rules.push('# tenant ' + i + ' (imported policy ' + layout.prefix + '_tenant_' + i + ')', policy.data.policy);
  }
  // The Agent renews its own token; without the default policy (which this role does not
  // carry) renew-self and lookup-self are refused with 403 and the Agent falls back to
  // re-authentication at every TTL (measured 2026-11-09). Grant exactly those two paths.
  rules.push('# Vault Agent token self-management', 'path "auth/token/renew-self" { capabilities = ["update"] }', 'path "auth/token/lookup-self" { capabilities = ["read"] }');
  // 400 "path is already in use" when a previous partial run enabled the method.
  await request('sys/auth/approle', { type: 'approle' }, 'POST', { accept: [400] });
  await request('sys/policies/acl/' + policyName, { policy: rules.join('\n') }, 'PUT');
  await request('auth/approle/role/' + roleName, { token_policies: [policyName], token_no_default_policy: true, token_type: 'service',
    token_ttl: ttl, token_max_ttl: maxTtl, secret_id_num_uses: 0, secret_id_ttl: '24h', bind_secret_id: true });
  const roleId = await request('auth/approle/role/' + roleName + '/role-id');
  const secret = await request('auth/approle/role/' + roleName + '/secret-id', {});
  if (typeof roleId?.data?.role_id !== 'string' || !roleId.data.role_id || typeof secret?.data?.secret_id !== 'string' || !secret.data.secret_id) throw fail('VAULT_AGENT_ROLE_MATERIAL_MISSING');
  fs.mkdirSync(path.join(agentDir, 'sink'), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(agentDir, 'sink'), 0o700);
  writePrivate(path.join(agentDir, 'creds', 'role_id'), roleId.data.role_id + '\n');
  writePrivate(path.join(agentDir, 'creds', 'secret_id'), secret.data.secret_id + '\n');
  // Point the api document at the sink. tokenEnv and tokenFile are exclusive per tenant;
  // the environment tokens the imported bootstrap minted are dropped unless an explicit
  // control run keeps them to show they are not used.
  const envKeys = apiConfig.tenants.map(tenant => tenant.vault.tokenEnv);
  for (const tenant of apiConfig.tenants) { delete tenant.vault.tokenEnv; tenant.vault.tokenFile = SINK; }
  if (!keepEnvTokens) for (const key of envKeys) delete apiEnv[key];
  writePrivate(path.join(apiDir, 'config.json'), JSON.stringify(apiConfig, null, 2) + '\n', { flag: 'w' });
  writePrivate(path.join(apiDir, 'env.json'), JSON.stringify(apiEnv, null, 2) + '\n', { flag: 'w' });
  writePrivate(completeFile, JSON.stringify({ version: 1, role: roleName, policy: policyName, tokenTtl: ttl, tokenMaxTtl: maxTtl, sink: SINK, envTokensKept: keepEnvTokens, tenants: apiConfig.tenants.length }, null, 2) + '\n');
  return { state: 'vault-agent-provisioned', role: roleName, policy: policyName, tokenTtl: ttl, tokenMaxTtl: maxTtl, credentials: '/state/vault-agent/creds/{role_id,secret_id}', sink: SINK, envTokensKept: keepEnvTokens };
}

if (require.main === module) {
  Promise.resolve().then(() => run(process.argv[2] || 'provision', input())).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(JSON.stringify({ error: /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'VAULT_AGENT_BOOTSTRAP_FAILED' }) + '\n'); process.exitCode = 1; });
}
module.exports = { input, run };
