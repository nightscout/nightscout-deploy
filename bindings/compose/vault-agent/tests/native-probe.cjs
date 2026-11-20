'use strict';
// Runs only inside the explicitly owned private operator container. No AppRole
// login/renewal, no SQL, no provider. Actual serving and Vault endpoints only.
const fs = require('node:fs'), crypto = require('node:crypto');
const stage = process.argv[2], root = '/state', deadline = performance.now() + 180000;
const fail = code => Object.assign(new Error(code), { code });
const emit = (name, values = {}) => console.log(JSON.stringify({ stage: name, at: new Date().toISOString(), ...values }));
const material = JSON.parse(fs.readFileSync(root + '/bootstrap/vault-init.json', 'utf8'));
const tenants = JSON.parse(fs.readFileSync(root + '/primer/tenants.json', 'utf8')).tenants;
if (!Array.isArray(tenants) || tenants.length !== 2 || tenants.some(row => typeof row.host !== 'string' || typeof row.dataToken !== 'string')) throw fail('NATIVE_SYNTHETIC_FIXTURE_REQUIRED');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sink = () => fs.readFileSync(root + '/vault-agent/sink/token', 'utf8').trim();
async function request (url, options = {}) {
  const remaining = Math.ceil(deadline - performance.now()); if (remaining <= 0) throw fail('NATIVE_DEADLINE');
  const signal = AbortSignal.timeout(Math.min(6000, remaining));
  const response = url.startsWith('http:') ? await new Promise((resolve, reject) => {
    // Node24 fetch overwrites Host; actual http.request preserves the registry's
    // exact synthetic alias. This was measured with a local echo discriminator.
    const req = require('node:http').request(url, { ...options, signal, agent: false }, res => resolve({ status: res.statusCode, body: res }));
    req.on('error', reject); req.end(options.body);
  }) : await fetch(url, { ...options, redirect: 'manual', signal });
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body || []) { bytes += chunk.length; if (bytes > 262144) throw fail('NATIVE_RESPONSE_BOUND'); chunks.push(chunk); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
  return { status: response.status, body };
}
async function vault (resource, body) {
  return request('https://vault:8200/v1/' + resource, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Vault-Token': material.root_token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function lookup (token = sink()) {
  const result = await vault('auth/token/lookup', { token });
  if (result.status !== 200) return null;
  const d = result.body.data;
  return { created: d.creation_time, ttl: d.ttl, renewable: d.renewable, renewed: d.last_renewal_time || 0 };
}
async function serving (expected, label, all = true) {
  const rows = [];
  for (const [apiIndex, api] of ['api', 'api-2'].entries()) for (const [tenantIndex, tenant] of (all ? tenants : tenants.slice(0, 1)).entries()) {
    const result = await request('http://' + api + ':1337/api/v2/authorization/request/' + encodeURIComponent(tenant.dataToken), { headers: { host: tenant.host } });
    const error = typeof result.body?.error === 'string' && /^[A-Z0-9_]{1,80}$/.test(result.body.error) ? result.body.error : null;
    rows.push({ apiIndex, tenantIndex, status: result.status, error, signed: typeof result.body?.token === 'string' });
  }
  emit(label, { observations: rows });
  if (expected !== null && rows.some(row => row.status !== expected || expected === 200 && !row.signed)) throw fail('NATIVE_SERVING_CRITERION');
  return rows;
}
async function recovery (label) {
  let polls = 0;
  while (performance.now() < deadline && polls++ < 30) {
    const rows = await serving(null, label, false);
    if (rows.every(row => row.status === 200 && row.signed)) return;
    if (rows.some(row => row.status !== 503)) throw fail('NATIVE_RECOVERY_UNCLASSIFIED');
    await pause(500);
  }
  throw fail('NATIVE_RECOVERY_TIMEOUT');
}
async function main () {
  emit('instrument', { sha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), operation: stage });
  if (stage === 'policy') {
    const complete = JSON.parse(fs.readFileSync(root + '/vault-agent/complete.json', 'utf8'));
    const layout = JSON.parse(fs.readFileSync(root + '/bootstrap/layout.json', 'utf8'));
    const selectedRole = await vault('auth/approle/role/' + complete.role), selectedPolicy = await vault('sys/policies/acl/' + complete.policy);
    if (selectedRole.status !== 200 || selectedPolicy.status !== 200) throw fail('NATIVE_ROLE_READ_REFUSED');
    const role = selectedRole.body.data || selectedRole.body, policy = (selectedPolicy.body.data || selectedPolicy.body).policy;
    if (role.token_policies.length !== 1 || role.token_policies[0] !== complete.policy || role.token_no_default_policy !== true || role.token_ttl !== 20 || role.token_max_ttl !== 60 || role.secret_id_ttl !== 0 || role.secret_id_num_uses !== 0 || complete.secretIdTtl !== 0 || complete.secretIdNumUses !== 0 ||
      crypto.createHash('sha256').update(policy).digest('hex') !== complete.policySha256) throw fail('NATIVE_ROLE_POLICY_MISMATCH');
    const key = purpose => require('/opt/app/lib/tenant-registry/rules').vaultKey(tenants[0].id, purpose);
    // Signing is in process (decision deployment-signing-secret); the retired Transit
    // signing paths must stay denied.
    const specs = [['decrypt', 'data', true], ['hmac', 'signing', false], ['verify', 'signing', false], ['sign', 'access', false],
      ['keys', 'data', false], ['encrypt', 'data', false], ['sign', 'management', false], ['sign', 'human-management', false]];
    const paths = specs.map(([operation, purpose]) => layout.mount + '/' + operation + '/' + key(purpose));
    const selected = await vault('sys/capabilities', { token: sink(), paths });
    if (selected.status !== 200) throw fail('NATIVE_CAPABILITIES_READ_REFUSED');
    const capabilities = selected.body.data || selected.body;
    const results = specs.map(([operation, purpose, allowed], index) => {
      const caps = capabilities[paths[index]] || [];
      if (allowed ? !caps.includes('update') : !caps.includes('deny')) throw fail('NATIVE_POLICY_OVERGRANT');
      return { operation, purpose, allowed };
    });
    emit('actual-serving-policy', { policies: 1, roleTokenTtl: role.token_ttl, roleTokenMaxTtl: role.token_max_ttl, machineSecretIdTtl: role.secret_id_ttl, machineSecretIdNumUses: role.secret_id_num_uses, policyHashMatches: true, capabilities: results }); return;
  }
  if (stage === 'observe') {
    if (fs.existsSync(root + '/vault-agent/creds/secret_id')) throw fail('NATIVE_SECRET_ID_NOT_CONSUMED');
    if ((fs.statSync(root + '/vault-agent/sink/token').mode & 0o777) !== 0o600) throw fail('NATIVE_SINK_MODE');
    await serving(200, 'baseline');
    let token = sink(), initial = await lookup(token), renewed = false;
    if (!initial?.renewable || initial.ttl > 20 || initial.ttl < 1) throw fail('NATIVE_TOKEN_TTL');
    for (let polls = 0; polls < 50; polls++) {
      await pause(1000); const currentToken = sink(), current = await lookup(currentToken);
      if (currentToken !== token) { token = currentToken; initial = current; continue; }
      if (current && current.renewed > initial.renewed) { renewed = true; emit('agent-renewal', { sameSinkToken: true, ttl: current.ttl, renewalAdvanced: true }); break; }
    }
    if (!renewed) throw fail('NATIVE_RENEWAL_UNMEASURED');
    await serving(200, 'after-renewal');
    const before = sink(); let changed = false;
    for (let polls = 0; polls < 80; polls++) { await pause(1000); if (sink() !== before && await lookup()) { changed = true; break; } }
    if (!changed) throw fail('NATIVE_MAX_TTL_REAUTH_UNMEASURED');
    emit('agent-max-ttl-reauth', { sinkTokenChanged: true }); await serving(200, 'after-max-ttl-reauth');
    return;
  }
  if (stage === 'missing-sink') {
    const file = root + '/vault-agent/sink/token', held = root + '/vault-agent/sink/proof-held';
    if (!['api', 'api-2'].every(name => fs.existsSync(root + '/' + name + '/vault-token'))) throw fail('NATIVE_OLD_CREDENTIAL_CONTROL_MISSING');
    fs.renameSync(file, held);
    try { await serving(503, 'missing-sink-old-credentials-present'); }
    finally { if (fs.existsSync(file)) fs.unlinkSync(held); else fs.renameSync(held, file); }
    await serving(200, 'restored-sink'); return;
  }
  if (stage === 'seal') {
    const sealed = await vault('sys/seal', {}); if (sealed.status !== 204) throw fail('NATIVE_SEAL_REFUSED');
    try { await serving(503, 'sealed-vault'); }
    finally { const unsealed = await vault('sys/unseal', { key: material.keys_base64[0] }); if (unsealed.status !== 200 || unsealed.body.sealed) throw fail('NATIVE_UNSEAL_REFUSED'); }
    await recovery('unsealed-vault'); return;
  }
  if (stage === 'expired') {
    let expired = false;
    for (let polls = 0; polls < 30; polls++) { if (!await lookup()) { expired = true; break; } await pause(1000); }
    if (!expired) throw fail('NATIVE_EXPIRED_TOKEN_CONTROL_UNMEASURED');
    await serving(503, 'agent-stopped-expired-sink'); return;
  }
  if (stage === 'reauth') { await recovery('restarted-agent'); if (fs.existsSync(root + '/vault-agent/creds/secret_id')) throw fail('NATIVE_SECRET_ID_NOT_CONSUMED'); return; }
  if (stage === 'outage') { await serving(503, 'vault-transport-outage', false); return; }
  if (stage === 'unseal') { const result = await vault('sys/unseal', { key: material.keys_base64[0] }); if (result.status !== 200 || result.body.sealed) throw fail('NATIVE_UNSEAL_REFUSED'); await recovery('vault-transport-restored'); return; }
  if (stage === 'serving') { await serving(200, 'serving'); return; }
  throw fail('NATIVE_OPERATION_REQUIRED');
}
main().then(() => emit('passed', { operation: stage })).catch(error => { emit('failed', { operation: stage, code: /^[A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'NATIVE_PROBE_FAILED' }); process.exitCode = 1; });
