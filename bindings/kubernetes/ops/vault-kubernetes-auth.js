#!/usr/bin/env node
'use strict';

// Kubernetes counterpart of ../../compose/vault-agent/vault-agent-bootstrap.js. Runs in the
// application image as the last step of the provision Job, after bootstrap.js, with the Job's own
// state at /state (Vault initialization custody and layout). It never prints a credential and
// writes no role document: the api documents were rendered before apply with the Agent sink as
// their token file (ops/render-documents.cjs, decision provisioning-secrets-in).
//
// Policy: the api's serving policy plus the Agent's renew-self and lookup-self. The login is
// Kubernetes auth bound to the cohort's service account and namespace, with a projected token of a
// dedicated audience (decision vault-agent-sidecar). No AppRole material is created or written.
//
//   provision  enable kubernetes auth, configure it against the in-cluster API, write the policy,
//              create the role, record completion
const fs = require('node:fs'), path = require('node:path');
const fail = code => Object.assign(new Error(code), { code });
const DURATION = /^[1-9][0-9]{0,5}[smh]$/;
const NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const SINK = '/run/ns-vault/token';
function input (env = process.env) {
  if (env.NS_VAULT_K8S_AUTH !== '1' || !/^\/[\w/.-]+$/.test(env.NS_BOOTSTRAP_OUTPUT || '')) throw fail('EXPLICIT_VAULT_K8S_AUTH_REQUIRED');
  const vault = new URL(env.VAULT_ADDR || 'https://vault:8200');
  if (vault.protocol !== 'https:' || vault.username || vault.password || vault.pathname !== '/' || vault.search || vault.hash) throw fail('BOOTSTRAP_VAULT_HTTPS_REQUIRED');
  const ttl = env.NS_VAULT_AGENT_TOKEN_TTL || '1h', maxTtl = env.NS_VAULT_AGENT_TOKEN_MAX_TTL || '24h';
  if (!DURATION.test(ttl) || !DURATION.test(maxTtl)) throw fail('VAULT_AGENT_TTL_INVALID');
  const namespace = env.NS_VAULT_K8S_NAMESPACE, serviceAccount = env.NS_VAULT_K8S_SERVICE_ACCOUNT, audience = env.NS_VAULT_K8S_AUDIENCE || 'vault';
  if (!NAME.test(namespace || '') || !NAME.test(serviceAccount || '') || !NAME.test(audience)) throw fail('VAULT_K8S_BINDING_INVALID');
  return { vault, output: path.resolve(env.NS_BOOTSTRAP_OUTPUT), ttl, maxTtl, namespace, serviceAccount, audience };
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

async function provision ({ vault, output, ttl, maxTtl, namespace, serviceAccount, audience }) {
  const bootstrapDir = path.join(output, 'bootstrap'), agentDir = path.join(output, 'vault-agent');
  if (!fs.existsSync(path.join(bootstrapDir, 'complete.json'))) throw fail('IMPORTED_BOOTSTRAP_INCOMPLETE');
  const completeFile = path.join(agentDir, 'complete.json');
  if (fs.existsSync(completeFile)) return { state: 'existing-vault-agent-provisioned' };
  const rootToken = readPrivateJson(path.join(bootstrapDir, 'vault-init.json')).root_token;
  const layout = readPrivateJson(path.join(bootstrapDir, 'layout.json'));
  if (typeof rootToken !== 'string' || !rootToken || typeof layout.prefix !== 'string') throw fail('IMPORTED_BOOTSTRAP_STATE_INVALID');
  // Same role and policy names as the Compose step; agent.hcl names the role.
  const roleName = layout.prefix + '_vault_agent', policyName = layout.prefix + '_vault_agent';
  async function request (resource, body, method = body === undefined ? 'GET' : 'POST', { accept = [] } = {}) {
    const response = await fetch(vault.origin + '/v1/' + resource, { method, headers: { 'Content-Type': 'application/json', 'X-Vault-Token': rootToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (!response.ok && !accept.includes(response.status)) { await response.body?.cancel(); throw fail('VAULT_K8S_AUTH_VAULT_REFUSED'); }
    if (response.status === 204) return {};
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
  const policy = await request('sys/policies/acl/' + layout.prefix + '_api');
  if (typeof policy?.data?.policy !== 'string' || !policy.data.policy) throw fail('IMPORTED_TENANT_POLICY_MISSING');
  const rules = [policy.data.policy];
  rules.push('# Vault Agent token self-management', 'path "auth/token/renew-self" { capabilities = ["update"] }', 'path "auth/token/lookup-self" { capabilities = ["read"] }');
  // 400 "path is already in use" when a previous partial run enabled the method.
  await request('sys/auth/kubernetes', { type: 'kubernetes' }, 'POST', { accept: [400] });
  // Vault runs in the cluster: with no reviewer JWT it reviews tokens with its own service
  // account (bound to system:auth-delegator by the binding) and the in-cluster CA.
  await request('auth/kubernetes/config', { kubernetes_host: 'https://kubernetes.default.svc' });
  await request('sys/policies/acl/' + policyName, { policy: rules.join('\n') }, 'PUT');
  await request('auth/kubernetes/role/' + roleName, { bound_service_account_names: [serviceAccount], bound_service_account_namespaces: [namespace],
    audience, token_policies: [policyName], token_no_default_policy: true, token_type: 'service', token_ttl: ttl, token_max_ttl: maxTtl });
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writePrivate(completeFile, JSON.stringify({ version: 1, method: 'kubernetes', role: roleName, policy: policyName, serviceAccount, namespace, audience,
    tokenTtl: ttl, tokenMaxTtl: maxTtl, sink: SINK, mode: 'registry' }, null, 2) + '\n');
  return { state: 'vault-agent-provisioned', method: 'kubernetes', role: roleName, policy: policyName, sink: SINK };
}

if (require.main === module) {
  Promise.resolve().then(() => process.argv[2] === 'provision' ? provision(input()) : Promise.reject(fail('USAGE_PROVISION')))
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(JSON.stringify({ error: /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'VAULT_K8S_AUTH_FAILED' }) + '\n'); process.exitCode = 1; });
}
module.exports = { input, provision };
