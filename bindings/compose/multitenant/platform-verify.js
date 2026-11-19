#!/usr/bin/env node
'use strict';

// The pre-start platform step. Startup runs it after migrations and before
// any serving role starts. A refusal stops startup.
// The admin role verifies schema, grants, ownership and catalogues once and
// issues the proof each serving role checks at its start. The proof has no
// lease, so this runs again before every start that follows a platform change.
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
  if (!selected || Object.keys(selected).sort().join(',') !== 'namespace,roles' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(selected.namespace || '') ||
      JSON.stringify(selected.roles) !== JSON.stringify(ROLES)) throw fail('PLATFORM_VERIFICATION_SELECTION_INVALID');
  return { adminOrigin: url.origin, operation: '/v1/platform-verification', ...selected };
}
async function verify(config, { timeoutMs = 60000 } = {}) {
  const selected = selection(config), started = Date.now();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw fail('PLATFORM_VERIFICATION_TIMEOUT_INVALID');
  const response = await request(selected.adminOrigin, selected.operation, { method: 'POST', body: {}, timeoutMs, classification: 'platform-verify' });
  if (response.status !== 200) throw fail('PLATFORM_VERIFICATION_REFUSED_' + response.status);
  const value = response.body;
  if (value?.version !== 1 || value.status !== 'verified' || value.namespace !== selected.namespace || !Array.isArray(value.roles) || value.roles.length !== ROLES.length ||
      value.roles.some(row =>
        !row || typeof row !== 'object' || !ROLES.includes(row.role) || !/^[a-f0-9]{64}$/.test(row.generation || '')) || new Set(value.roles.map(row => row.role)).size !== ROLES.length) throw fail('PLATFORM_VERIFICATION_RECEIPT_INVALID');
  return { version: 1, status: 'verified', selectionSha256: crypto.createHash('sha256').update(JSON.stringify(selected)).digest('hex'),
    selection: { namespace: selected.namespace, roles: selected.roles },
    roles: ROLES.map(role => { const record = value.roles.find(row => row.role === role); return { role, generation: record.generation }; }),
    elapsedMs: Date.now() - started, credentialBoundary: 'admin-private-api' };
}
async function backfillTenantFloorsV1(config, timeoutMs) {
  const selected = selection(config);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw fail('PLATFORM_VERIFICATION_TIMEOUT_INVALID');
  const result = await request(selected.adminOrigin, selected.operation + '/backfills/tenant-floor-v1',
    { method: 'POST', body: {}, timeoutMs, classification: 'platform-verify' });
  if (result.status !== 200) throw fail('TENANT_FLOOR_BACKFILL_REFUSED_' + result.status);
  const value = result.body;
  if (value?.version !== 1 || value.namespace !== selected.namespace || value.status !== 'verified' ||
      !Number.isSafeInteger(value.verified) || value.verified < 0) throw fail('TENANT_FLOOR_BACKFILL_RECEIPT_INVALID');
  return { version: 1, namespace: selected.namespace, status: value.status, verified: value.verified };
}
async function main(args) {
  const backfill = args.length === 2 && args[0] === 'backfill-tenant-floor-v1' && /^[1-9][0-9]*$/.test(args[1]);
  if (args.length && !backfill) throw fail('PLATFORM_VERIFICATION_USAGE');
  const directory = process.env.NS_PRIMER_STATE || '/run/ns-primer';
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
  const receipt = backfill ? await backfillTenantFloorsV1(config, Number(args[1])) : await verify(config);
  privateWrite(path.join(directory, backfill ? 'tenant-floor-backfill-v1.json' : 'platform-verification.json'), receipt);
  console.log(JSON.stringify(receipt));
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify(diagnostic(error))); process.exitCode = 1; });
module.exports = { selection, verify, backfillTenantFloorsV1 };
