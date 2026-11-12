'use strict';
// Actual Vault + actual Agent control. This script provisions only a diagnostic
// machine role, never calls AppRole login or token renewal, and performs no SQL.
const fs = require('node:fs'), crypto = require('node:crypto');
const operation = process.argv[2], root = '/state', base = root + '/vault-agent-lifetime-control-20261112';
const layout = JSON.parse(fs.readFileSync(root + '/bootstrap/layout.json', 'utf8')), material = JSON.parse(fs.readFileSync(root + '/bootstrap/vault-init.json', 'utf8'));
const role = layout.prefix + '_vault_agent_lifetime_control', policy = layout.prefix + '_vault_agent';
const emit = (stage, value = {}) => console.log(JSON.stringify({ stage, at: new Date().toISOString(), ...value }));
const fail = code => Object.assign(new Error(code), { code });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request (resource, body, method = body === undefined ? 'GET' : 'POST') {
  const result = await fetch('https://vault:8200/v1/' + resource, { method, headers: { 'X-Vault-Token': material.root_token, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  const bytes = Buffer.from(await result.arrayBuffer()); if (bytes.length > 262144) throw fail('LIFETIME_RESPONSE_BOUND');
  let value; try { value = bytes.length ? JSON.parse(bytes) : {}; } catch { throw fail('LIFETIME_RESPONSE_INVALID'); }
  return { status: result.status, value };
}
async function lookup (token) { const r = await request('auth/token/lookup', { token }); return r.status === 200 ? r.value.data : null; }
const token = () => fs.readFileSync(base + '/sink/token', 'utf8').trim();
async function setup (ttl) {
  for (const dir of [base, base + '/creds', base + '/sink']) fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  const result = await request('auth/approle/role/' + role, { token_policies: [policy], token_no_default_policy: true, token_type: 'service', token_ttl: '2s', token_max_ttl: '6s',
    secret_id_ttl: ttl, secret_id_num_uses: 0, bind_secret_id: true });
  if (result.status !== 204) throw fail('LIFETIME_ROLE_REFUSED');
  const id = await request('auth/approle/role/' + role + '/role-id'), secret = await request('auth/approle/role/' + role + '/secret-id', {});
  if (!id.value.data?.role_id || !secret.value.data?.secret_id) throw fail('LIFETIME_ROLE_MATERIAL_MISSING');
  const seen = await request('auth/approle/role/' + role + '/secret-id/lookup', { secret_id: secret.value.data.secret_id });
  if (seen.status !== 200 || seen.value.data.secret_id_ttl !== ttl) throw fail('LIFETIME_SECRET_TTL_MISMATCH');
  const expiration = seen.value.data.expiration_time;
  if (ttl === 0 && !/^0001-01-01/.test(expiration)) throw fail('LIFETIME_NONEXPIRY_UNMEASURED');
  for (const [name, value] of [['role_id', id.value.data.role_id], ['secret_id', secret.value.data.secret_id]]) fs.writeFileSync(base + '/creds/' + name, value + '\n', { mode: 0o600 });
  if (fs.existsSync(base + '/sink/token')) fs.unlinkSync(base + '/sink/token');
  emit('role-receipt', { diagnosticRole: true, tokenTtlSeconds: 2, tokenMaxTtlSeconds: 6, secretIdTtlSeconds: ttl, nonexpiring: ttl === 0, secretIdNumUses: 0, policyCount: 1 });
}
async function observe (unlimited) {
  let first;
  for (let i = 0; i < 20; i++) { if (fs.existsSync(base + '/sink/token') && await lookup(token())) { first = token(); break; } await pause(250); }
  if (!first || fs.existsSync(base + '/creds/secret_id')) throw fail('LIFETIME_AUTO_AUTH_UNMEASURED');
  if (!unlimited) {
    let expired = false;
    for (let i = 0; i < 32; i++) { await pause(500); if (!await lookup(token())) { expired = true; break; } }
    if (!expired || token() !== first) throw fail('LIFETIME_EXPIRING_SECRET_CONTROL_NOT_RED');
    emit('expiring-secret-control', { reauthenticationFailedAfterSecretExpiry: true, expiredSinkTokenUnchanged: true }); return;
  }
  let current = first, changes = 0;
  for (let i = 0; i < 48 && changes < 2; i++) { await pause(500); const next = token(); if (next !== current && await lookup(next)) { current = next; changes++; } }
  if (changes !== 2) throw fail('LIFETIME_NONEXPIRING_REAUTH_UNMEASURED');
  emit('nonexpiring-secret-restored', { maxTtlReauthentications: changes, newSinkTokensValid: true });
}
async function main () {
  emit('instrument', { operation, sha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') });
  if (operation === 'setup-expiring') return setup(3);
  if (operation === 'setup-nonexpiring') return setup(0);
  if (operation === 'observe-expiring') return observe(false);
  if (operation === 'observe-nonexpiring') return observe(true);
  if (operation === 'cleanup') { const r = await request('auth/approle/role/' + role, undefined, 'DELETE'); if (r.status !== 204) throw fail('LIFETIME_ROLE_CLEANUP_REFUSED'); emit('diagnostic-role-removed'); return; }
  throw fail('LIFETIME_OPERATION_REQUIRED');
}
main().then(() => emit('passed', { operation })).catch(error => { emit('failed', { operation, code: /^[A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'LIFETIME_PROBE_FAILED' }); process.exitCode = 1; });
