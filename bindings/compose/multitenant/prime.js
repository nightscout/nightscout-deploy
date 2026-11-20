#!/usr/bin/env node
'use strict';

// Lab client only (decision one-call-usable-provisioning): one private admin
// call per batch provisions tenants that are usable on return, and this process
// writes the roster. It receives no database or Vault credential and makes no
// tenant DATA API call: the role, owner, data subject and its access token come
// back from provisioning. Synthetic data loading belongs to the bench harness.
//
// Roster: tenants.json { version: 1, tenants: [{ id, host, hosts, subject,
// dataToken?, jwt?, jwtExpiresAt?, ownerSubject, rootSecret? }] }, rewritten
// atomically after every batch. A tenant already in the roster is not sent
// again, so a completed run re-runs with no traffic. Provisioning returns the
// legacy subject token (dataToken) only on 'created', and an 8-hour data JWT on
// both 'created' and 'existing' (signed in process, decision
// deployment-signing-secret). A tenant answered 'existing' that is not in the
// roster (a response lost before the roster write) is saved from its JWT; one
// answered with no credential at all is reported, never re-issued.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const fail = code => Object.assign(new Error(code), { code });
const BATCH = 100;
const credential = value => typeof value === 'string' && value.length > 0;
const DEMO_PERMISSIONS = Object.freeze(['api:*:read', 'api:*:create,update,delete', 'notifications:*:ack']);

function load(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (config.version !== 1 || (config.seed !== undefined && (!Array.isArray(config.seed) || !config.seed.length))) throw fail('PRIMER_CONFIG_INVALID');
  for (const raw of [config.adminOrigin, ...(config.apiOrigin === undefined ? [] : [config.apiOrigin])]) {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('PRIMER_ORIGIN_INVALID');
  }
  if (typeof config.ownerConsumer !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(config.ownerConsumer)) throw fail('PRIMER_CONFIG_INVALID');
  return config;
}
// The lab tenant's bootstrap: an owner for the configured consumer and one
// uploader subject holding the demo role.
function bootstrapFor(config) {
  return config.bootstrap || { owner: { consumer: config.ownerConsumer, name: 'Synthetic demo owner' },
    subject: { name: 'Synthetic demo uploader', role: { name: 'demo', permissions: DEMO_PERMISSIONS.slice() } } };
}

const CONNECTION_CAUSES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'PRIMER_TIMEOUT', 'PRIMER_RESPONSE_TOO_LARGE']);
function connectionFailure(error, code = 'PRIMER_CONNECTION_FAILED') {
  return Object.assign(fail(code), { connectionCause: CONNECTION_CAUSES.has(error?.code) ? error.code : 'UNCLASSIFIED' });
}
// Fixed codes and counts only; never response text, hosts, ids or credentials.
function diagnostic(error) {
  return { error: /^[A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : 'PRIMER_FAILED',
    ...(Number.isSafeInteger(error?.tenants) ? { tenants: error.tenants } : {}),
    ...(error?.codes && typeof error.codes === 'object' ? { codes: error.codes } : {}),
    ...(error?.connectionCause ? { connectionCause: CONNECTION_CAUSES.has(error.connectionCause) ? error.connectionCause : 'UNCLASSIFIED' } : {}) };
}
function request(origin, route, { method = 'GET', body, headers = {}, timeoutMs = 600000, signal } = {}) {
  const url = new URL(route, origin), bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, signal, headers: { accept: 'application/json', ...headers, ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) }, timeout: timeoutMs }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 67108864) req.destroy(fail('PRIMER_RESPONSE_TOO_LARGE')); else chunks.push(chunk); });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { reject(fail('PRIMER_RESPONSE_INVALID')); } });
      res.on('error', error => reject(connectionFailure(error, 'PRIMER_RESPONSE_INCOMPLETE')));
    });
    req.on('timeout', () => req.destroy(fail('PRIMER_TIMEOUT'))); req.on('error', error => reject(connectionFailure(error))); req.end(bytes);
  });
}
function privateWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.new', fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const parent = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
// One primer per state directory: two writers would lose roster rows.
async function withPrimerLock(directory, work) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, 'prime.lock'), nonce = crypto.randomUUID();
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw fail('PRIMER_STATE_IN_USE'); throw error; }
  fs.writeFileSync(fd, JSON.stringify({ version: 1, pid: process.pid, nonce }) + '\n'); fs.closeSync(fd);
  try { return await work(); }
  finally {
    const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
    if (owner.nonce !== nonce || owner.pid !== process.pid) throw fail('PRIMER_STATE_LOCK_CHANGED');
    fs.unlinkSync(lock);
  }
}
function primeOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['concurrency', 'maxTenants', 'tenantCount', 'signal'].includes(key))) throw fail('PRIMER_OPTIONS_INVALID');
  const concurrency = options.concurrency === undefined ? 4 : options.concurrency;
  const maxTenants = options.maxTenants === undefined ? 100000 : options.maxTenants;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32 || !Number.isSafeInteger(maxTenants) || maxTenants < 1 ||
      (options.signal !== undefined && typeof options.signal?.aborted !== 'boolean')) throw fail('PRIMER_OPTIONS_INVALID');
  return { concurrency, maxTenants, tenantCount: options.tenantCount, signal: options.signal };
}
function seedOf(config, tenantCount) {
  if (config.seed && tenantCount !== undefined) throw fail('PRIMER_COUNT_CONFLICTS_WITH_SEED');
  if (config.seed) return config.seed;
  const demo = require('./demo-tenants');
  const count = demo.tenantCount(tenantCount === undefined ? process.env : { NS_DEMO_TENANTS: tenantCount });
  return demo.tenantIds(count).map((id, index) => ({ id, hosts: [demo.tenantAlias(index)], issueRootSecret: true }));
}
function readRoster(file) {
  if (!fs.existsSync(file)) return { version: 1, tenants: [] };
  const roster = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (roster.version !== 1 || !Array.isArray(roster.tenants) || new Set(roster.tenants.map(row => row.id)).size !== roster.tenants.length ||
      roster.tenants.some(row => typeof row.id !== 'string' || typeof row.host !== 'string' || !credential(row.dataToken) && !credential(row.jwt))) throw fail('PRIMER_ROSTER_INVALID');
  return roster;
}

// Provision every seed tenant not yet in the roster, at most `concurrency`
// batch calls in flight, and save the roster after each batch.
async function provisionOwned(config, directory, seed, { concurrency, maxTenants, signal }) {
  const file = path.join(directory, 'tenants.json');
  const known = new Map(readRoster(file).tenants.map(row => [row.id, row]));
  const order = new Map(seed.map((spec, index) => [spec.id, index]));
  if (order.size !== seed.length) throw fail('PRIMER_SEED_DUPLICATE');
  for (const spec of seed) {
    const prior = known.get(spec.id);
    if (prior && prior.host !== spec.hosts?.[0]) throw fail('PRIMER_ROSTER_CONFLICT');
  }
  const pending = seed.filter(spec => !known.has(spec.id)).slice(0, maxTenants);
  const batches = [];
  for (let index = 0; index < pending.length; index += BATCH) batches.push(pending.slice(index, index + BATCH));
  const bootstrap = bootstrapFor(config), refused = {}, missing = [];
  const save = () => privateWrite(file, { version: 1, tenants: [...known.values()].sort((a, b) => (order.get(a.id) ?? -1) - (order.get(b.id) ?? -1)) });
  let cursor = 0, failure;
  const worker = async () => {
    while (!failure && cursor < batches.length) {
      if (signal?.aborted) { failure ||= fail('PRIMER_CANCELLED'); return; }
      const rows = batches[cursor++];
      try {
        const response = await request(config.adminOrigin, '/v1/tenants/batch', { method: 'POST', signal,
          body: { tenants: rows.map(spec => ({ ...spec, bootstrap: spec.bootstrap || bootstrap })) } });
        if (response.status !== 200 || !Array.isArray(response.body.results) || response.body.results.length !== rows.length) {
          throw Object.assign(fail('PRIMER_PROVISION_FAILED'), /^[A-Z_]{1,80}$/.test(response.body?.code || '') ? { codes: { [response.body.code]: rows.length } } : {});
        }
        response.body.results.forEach((row, index) => {
          const spec = rows[index];
          if (row.id !== spec.id) { refused.PRIMER_RESULT_ORDER = (refused.PRIMER_RESULT_ORDER || 0) + 1; return; }
          const b = row.bootstrap, token = row.outcome === 'created' && credential(b?.accessToken) ? b.accessToken : undefined,
            signed = ['created', 'existing'].includes(row.outcome) && credential(b?.jwt) && Number.isSafeInteger(b.jwtExpiresAt) ? b.jwt : undefined;
          if (token || signed) {
            known.set(spec.id, { id: spec.id, host: spec.hosts[0], hosts: spec.hosts, subject: b.subject, ...(token ? { dataToken: token } : {}),
              ...(signed ? { jwt: signed, jwtExpiresAt: b.jwtExpiresAt } : {}),
              ownerSubject: b.ownerSubject, ...(row.rootSecret ? { rootSecret: row.rootSecret } : {}) });
          } else if (row.outcome === 'existing' || row.outcome === 'created') missing.push(spec.id);
          else { const code = /^[A-Z_]{1,80}$/.test(row.code || '') ? row.code : 'UNCLASSIFIED'; refused[code] = (refused[code] || 0) + 1; }
        });
        save();
      } catch (error) { failure ||= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  if (failure) throw failure;
  if (Object.keys(refused).length) throw Object.assign(fail('PRIMER_PROVISION_REFUSED'), { codes: refused, tenants: Object.values(refused).reduce((a, b) => a + b, 0) });
  if (missing.length) throw Object.assign(fail('PRIMER_CREDENTIAL_NOT_RETURNED'), { tenants: missing.length });
  const inSeed = seed.filter(spec => known.has(spec.id)).length;
  if (inSeed !== seed.length) return { state: 'synthetic-tenants-partial', tenants: inSeed, remaining: seed.length - inSeed };
  return { state: 'synthetic-tenants-usable', tenants: inSeed };
}
async function provision(config, directory, options = {}) {
  const settings = primeOptions(options);
  return withPrimerLock(directory, () => provisionOwned(config, directory, seedOf(config, settings.tenantCount), settings));
}
// Kept for callers that run `provision` then `prime`: the same idempotent call;
// a completed roster sends nothing.
const prime = (config, directory, options = {}) => provision(config, directory, options);
async function add(config, directory, options = {}) {
  const settings = primeOptions(options);
  return withPrimerLock(directory, async () => {
    const value = JSON.parse(fs.readFileSync(path.join(directory, 'add.json'), 'utf8'));
    if (!value || Object.keys(value).sort().join(',') !== 'tenants,version' || value.version !== 1 ||
        !Array.isArray(value.tenants) || !value.tenants.length || value.tenants.length > BATCH) throw fail('PRIMER_ADDITION_INVALID');
    for (const spec of value.tenants) require('../../lib/tenant-registry/provision').parseSpec(spec);
    return provisionOwned(config, directory, value.tenants, settings);
  });
}
function parsePrimeOptions(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = { '--concurrency': 'concurrency', '--max-tenants': 'maxTenants', '--tenant-count': 'tenantCount' }[values[index]];
    if (!key || Object.hasOwn(options, key) || !/^[1-9][0-9]*$/.test(values[index + 1] || '')) throw fail('PRIMER_OPTIONS_INVALID');
    options[key] = key === 'tenantCount' ? values[index + 1] : Number(values[index + 1]);
  }
  primeOptions(options); return options;
}
async function main() {
  const [operation, ...values] = process.argv.slice(2), directory = process.env.NS_PRIMER_STATE || '/run/ns-primer';
  if (!['provision', 'prime', 'add'].includes(operation)) throw fail('PRIMER_OPERATION_INVALID');
  const options = parsePrimeOptions(values);
  const controller = new AbortController(); let stopped;
  const interrupt = () => { stopped = 130; controller.abort(); }, terminate = () => { stopped = 143; controller.abort(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    const config = load(process.env.NS_PRIMER_CONFIG || path.join(directory, 'config.json'));
    const started = Date.now();
    const result = await ({ provision, prime, add }[operation](config, directory, { ...options, signal: controller.signal }));
    console.error(JSON.stringify({ phase: 'primer', event: 'completed', atMs: Date.now(), elapsedMs: Date.now() - started, tenants: result.tenants }));
    console.log(JSON.stringify(result));
    if (stopped || result.state === 'synthetic-tenants-partial') process.exitCode = stopped || 2;
  } catch (error) {
    process.exitCode = stopped || 1;
    console.error(JSON.stringify(diagnostic(error)));
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); }
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify(diagnostic(error))); process.exitCode = 1; });
module.exports = { diagnostic, connectionFailure, load, request, bootstrapFor, provision, prime, add, privateWrite, primeOptions, parsePrimeOptions, readRoster, BATCH };
