#!/usr/bin/env node
'use strict';

// A Job/controller can invoke the same private operation. No database or Vault
// credential is read, accepted or forwarded by this client.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { request, diagnostic, privateWrite } = require('./prime');
const ROLES = Object.freeze(['api', 'evaluator', 'realtime']);
const fail = code => Object.assign(new Error(code), { code, requestClass: 'platform-verify' });
function selection(config) {
  let url;
  try { url = new URL(config.adminOrigin); } catch { throw fail('PLATFORM_VERIFICATION_ORIGIN_INVALID'); }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('PLATFORM_VERIFICATION_ORIGIN_INVALID');
  const selected = config.platformVerification;
  if (!selected || Object.keys(selected).sort().join(',') !== 'maxAgeMs,namespace,refreshMs,roles' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(selected.namespace || '') || !Number.isSafeInteger(selected.maxAgeMs) || selected.maxAgeMs < 1000 || selected.maxAgeMs > 3600000 ||
      !Number.isSafeInteger(selected.refreshMs) || selected.refreshMs < 1000 || selected.refreshMs >= selected.maxAgeMs ||
      JSON.stringify(selected.roles) !== JSON.stringify(ROLES)) throw fail('PLATFORM_VERIFICATION_SELECTION_INVALID');
  return { adminOrigin: url.origin, operation: '/v1/platform-verification', ...selected };
}
async function verify(config, { timeoutMs = 60000 } = {}) {
  const selected = selection(config), started = Date.now();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw fail('PLATFORM_VERIFICATION_TIMEOUT_INVALID');
  const response = await request(selected.adminOrigin, selected.operation, { method: 'POST', body: {}, timeoutMs, classification: 'platform-verify' });
  if (response.status !== 200) throw fail('PLATFORM_VERIFICATION_REFUSED_' + response.status);
  const value = response.body;
  if (value?.version !== 1 || value.status !== 'verified' || value.namespace !== selected.namespace || value.refreshMs !== selected.refreshMs || value.validityMs !== selected.maxAgeMs || !Array.isArray(value.roles) || value.roles.length !== ROLES.length ||
      value.roles.some(row =>
        !row || typeof row !== 'object' || !ROLES.includes(row.role) || !/^[a-f0-9]{64}$/.test(row.generation || '') || typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt)) || Date.parse(row.expiresAt) <= Date.now()) || new Set(value.roles.map(row => row.role)).size !== ROLES.length) throw fail('PLATFORM_VERIFICATION_RECEIPT_INVALID');
  return { version: 1, status: 'verified', selectionSha256: crypto.createHash('sha256').update(JSON.stringify(selected)).digest('hex'),
    selection: { namespace: selected.namespace, maxAgeMs: selected.maxAgeMs, refreshMs: selected.refreshMs, roles: selected.roles },
    roles: ROLES.map(role => { const record = value.roles.find(row => row.role === role); return { role, generation: record.generation, expiresAt: record.expiresAt }; }),
    elapsedMs: Date.now() - started, credentialBoundary: 'admin-private-api' };
}
async function main() {
  if (process.argv.length !== 2) throw fail('PLATFORM_VERIFICATION_USAGE');
  const directory = process.env.NS_PRIMER_STATE || '/run/ns-primer';
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
  const receipt = await verify(config);
  privateWrite(path.join(directory, 'platform-verification.json'), receipt);
  console.log(JSON.stringify(receipt));
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify(diagnostic(error))); process.exitCode = 1; });
module.exports = { selection, verify };
