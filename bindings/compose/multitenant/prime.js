#!/usr/bin/env node
'use strict';

// Lab client only: provisioning uses the private admin API, and subjects/data
// use tenant DATA APIs. This process receives no database or Vault credential.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const fail = code => Object.assign(new Error(code), { code });
function load(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (config.version !== 1 || !Array.isArray(config.seed) || !config.seed.length || config.seed.length > 10000) throw fail('PRIMER_CONFIG_INVALID');
  for (const raw of [config.adminOrigin, config.apiOrigin]) { const url = new URL(raw); if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('PRIMER_ORIGIN_INVALID'); }
  if (typeof config.ownerConsumer !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(config.ownerConsumer)) throw fail('PRIMER_CONFIG_INVALID');
  return config;
}
function request(origin, route, { method = 'GET', body, headers = {}, timeoutMs = 60000 } = {}) {
  const url = new URL(route, origin), bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { accept: 'application/json', ...headers, ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) }, timeout: timeoutMs }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 16777216) req.destroy(fail('PRIMER_RESPONSE_TOO_LARGE')); else chunks.push(chunk); });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { reject(fail('PRIMER_RESPONSE_INVALID')); } });
      res.on('error', () => reject(fail('PRIMER_RESPONSE_INCOMPLETE')));
    });
    req.on('timeout', () => req.destroy(fail('PRIMER_TIMEOUT'))); req.on('error', () => reject(fail('PRIMER_CONNECTION_FAILED'))); req.end(bytes);
  });
}
// Fixed diagnostic classes only; never retain response text, route parameters,
// host names, credentials or request bodies.
function refusal(response, requestClass) {
  const safeErrors = new Set(['TENANT_WARMING', 'TENANT_WARM_FAILED', 'TENANT_UNAVAILABLE', 'AUTHENTICATION_REQUIRED', 'UNAUTHORIZED', 'FORBIDDEN']);
  return Object.assign(fail('PRIMER_DATA_API_REFUSED_' + response.status), {
    status: response.status, requestClass,
    responseError: safeErrors.has(response.body?.error) ? response.body.error : 'UNCLASSIFIED'
  });
}
function requestClass(route, method = 'GET') {
  const names = { '/api/v2/authorization/roles': 'roles', '/api/v2/authorization/subjects': 'subjects', '/api/v1/entries': 'entries' };
  return (names[route] || 'other-data') + '-' + (method === 'POST' ? 'create' : method === 'GET' ? 'read' : 'other');
}
async function waitForTenant(origin, headers, { timeoutMs = 60000, pollMs = 200, now = Date.now, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const response = await request(origin, '/api/v2/authorization/roles', { headers, timeoutMs: Math.min(5000, deadline - now()) });
    if (response.status === 200 && Array.isArray(response.body)) return response.body;
    if (response.status !== 503 || response.body.error !== 'TENANT_WARMING') throw refusal(response, 'roles-ready');
    await delay(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  throw fail('PRIMER_TENANT_WARM_TIMEOUT');
}
function privateWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.new', fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const parent = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
async function provision(config, directory) {
  return withPrimerLock(directory, () => provisionOwned(config, directory));
}
async function provisionOwned(config, directory) {
  const file = path.join(directory, 'provisioned.json');
  let known = [];
  if (fs.existsSync(file)) known = JSON.parse(fs.readFileSync(file, 'utf8'));
  const saved = new Map(known.map(row => [row.id, row]));
  for (let index = 0; index < config.seed.length; index += 100) {
    const rows = config.seed.slice(index, index + 100);
    const response = await request(config.adminOrigin, '/v1/tenants/batch', { method: 'POST', body: { tenants: rows } });
    if (response.status !== 200 || !Array.isArray(response.body.results) || response.body.results.length !== rows.length) throw fail('PRIMER_PROVISION_FAILED');
    // Save every successfully issued root before reporting a refused peer.
    let refused = false;
    for (const row of response.body.results) {
      const spec = rows.find(spec => spec.id === row.id);
      if (!spec || !['created', 'existing'].includes(row.outcome)) { refused = true; continue; }
      const previous = saved.get(row.id);
      if (!row.rootSecret && !previous?.rootSecret) { refused = true; continue; }
      saved.set(row.id, { id: row.id, hosts: spec.hosts, rootSecret: row.rootSecret || previous.rootSecret });
    }
    privateWrite(file, [...saved.values()]);
    if (refused) throw fail('PRIMER_PROVISION_REFUSED_OR_CUSTODY_MISSING');
  }
  return { state: 'synthetic-tenants-provisioned', tenants: saved.size };
}
function primeOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['concurrency','maxTenants','signal'].includes(key))) throw fail('PRIMER_OPTIONS_INVALID');
  const concurrency = options.concurrency === undefined ? 1 : options.concurrency;
  const maxTenants = options.maxTenants === undefined ? 10000 : options.maxTenants;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32 || !Number.isInteger(maxTenants) || maxTenants < 1 || maxTenants > 10000 ||
      (options.signal !== undefined && typeof options.signal?.aborted !== 'boolean')) throw fail('PRIMER_OPTIONS_INVALID');
  return { concurrency, maxTenants, signal: options.signal };
}
async function withPrimerLock(directory, work) {
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
async function prime(config, directory, options) {
  const settings = primeOptions(options);
  return withPrimerLock(directory, () => primeOwned(config, directory, settings));
}
async function primeOwned(config, directory, { concurrency, maxTenants, signal }) {
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'provisioned.json'), 'utf8'));
  const completed = path.join(directory, 'primed.json');
  const tenantsFile = path.join(directory, 'tenants.json');
  if (fs.existsSync(completed) && !fs.existsSync(tenantsFile)) throw fail('PRIMER_CUSTODY_INVALID');
  const prior = fs.existsSync(tenantsFile) ? JSON.parse(fs.readFileSync(tenantsFile, 'utf8')) : { version: 1, tenants: [] };
  if (!Array.isArray(saved) || saved.some(row => !row || typeof row.id !== 'string' || !row.id || !Array.isArray(row.hosts) || typeof row.hosts[0] !== 'string' || typeof row.rootSecret !== 'string' || !row.rootSecret)) throw fail('PRIMER_CUSTODY_INVALID');
  const savedIds = new Set(saved.map(row => row.id));
  if (savedIds.size !== saved.length) throw fail('PRIMER_CUSTODY_INVALID');
  if (prior.version !== 1 || !Array.isArray(prior.tenants) || new Set(prior.tenants.map(row => row.id)).size !== prior.tenants.length ||
      prior.tenants.some(row => !savedIds.has(row.id) || typeof row.dataToken !== 'string' || !row.dataToken || typeof row.managementToken !== 'string' || !row.managementToken)) throw fail('PRIMER_CUSTODY_INVALID');
  const results = new Map(prior.tenants.map(row => [row.id, row]));
  const entryFile = path.join(directory, 'entry-requests.json');
  const entryState = fs.existsSync(entryFile) ? JSON.parse(fs.readFileSync(entryFile, 'utf8')) : { version: 1, tenants: {} };
  if (entryState.version !== 1 || !entryState.tenants || typeof entryState.tenants !== 'object' || Array.isArray(entryState.tenants) ||
      Object.entries(entryState.tenants).some(([id, value]) => !savedIds.has(id) || value?.state !== 'outcome-uncertain')) throw fail('PRIMER_CUSTODY_INVALID');
  // A prior process may have sent the entry before losing its response or local
  // completion write. Do not guess whether the DATA API committed that request.
  if (Object.keys(entryState.tenants).some(id => !results.has(id))) throw fail('PRIMER_ENTRY_OUTCOME_UNCERTAIN');
  const pending = saved.map((row, index) => ({ row, index })).filter(({ row }) => !results.has(row.id)).slice(0, maxTenants);
  const ownership = require('../../lib/server/internal-api/clients').ownershipOperations({ url: config.adminOrigin, trust: 'network', maxBytes: 1048576, timeoutMs: 60000 });
  const requestFile = path.join(directory, 'management-requests.json');
  const managementRequests = fs.existsSync(requestFile) ? JSON.parse(fs.readFileSync(requestFile, 'utf8')) : {};
  const commission = async ({ row, index }) => {
    // A global completion marker describes the previous seed, not future
    // additions. Preserve existing client custody and do not reissue or write
    // existing tenants while explicitly commissioning new ones.
    const headers = { host: row.hosts[0], 'api-secret': crypto.createHash('sha1').update(row.rootSecret).digest('hex') };
    const call = async (route, options = {}) => {
      const response = await request(config.apiOrigin, route, { ...options, headers: { ...headers, ...options.headers } });
      if (response.status < 200 || response.status >= 300) throw refusal(response, requestClass(route, options.method));
      return response.body;
    };
    const roles = await waitForTenant(config.apiOrigin, headers);
    if (!roles.some(role => role.name === 'demo')) await call('/api/v2/authorization/roles', { method: 'POST', body: { name: 'demo', permissions: ['api:*:read','api:*:create,update,delete','notifications:*:ack'] } });
    let subjects = await call('/api/v2/authorization/subjects');
    if (!subjects.some(subject => subject.name === 'Synthetic demo uploader')) await call('/api/v2/authorization/subjects', { method: 'POST', body: { name: 'Synthetic demo uploader', roles: ['demo'] } });
    subjects = await call('/api/v2/authorization/subjects');
    const subject = subjects.find(subject => subject.name === 'Synthetic demo uploader');
    if (!subject?._id || !subject.accessToken) throw fail('PRIMER_SUBJECT_TOKEN_MISSING');
    if (!subjects.some(subject => subject.name === 'Synthetic demo owner')) await call('/api/v2/authorization/subjects', { method: 'POST', body: { name: 'Synthetic demo owner', roles: ['demo'] } });
    subjects = await call('/api/v2/authorization/subjects');
    const ownerSubject = subjects.find(subject => subject.name === 'Synthetic demo owner');
    if (!ownerSubject?._id) throw fail('PRIMER_OWNER_SUBJECT_MISSING');
    const owner = { principal: ownerSubject._id, consumer: config.ownerConsumer };
    const listed = await ownership.listOwners({ tenant: row.id });
    if (listed.outcome !== 'listed') throw fail('PRIMER_OWNERSHIP_REFUSED');
    if (!listed.owners.some(value => value.principal === owner.principal && value.consumer === owner.consumer)) {
      if (listed.owners.length) throw fail('PRIMER_OWNERSHIP_ALREADY_ASSIGNED');
      const assigned = await ownership.addOwner({ tenant: row.id, owner, delegable: ['*'], expectedOwners: [] });
      if (assigned.outcome !== 'applied') throw fail('PRIMER_OWNERSHIP_REFUSED');
    }
    // Persist the request identity before sending, so ambiguous responses retry
    // that same issuance and never create a second credential implicitly.
    if (!managementRequests[row.id]) { managementRequests[row.id] = crypto.randomUUID(); privateWrite(requestFile, managementRequests); }
    const requestId = managementRequests[row.id];
    const management = await request(config.adminOrigin, '/v1/tenants/' + row.id + '/management-sessions', {
      method: 'POST', body: { subjectId: ownerSubject._id, requestId }, headers: { 'idempotency-key': requestId } });
    if (![200, 201].includes(management.status) || typeof management.body.token !== 'string' || !Number.isSafeInteger(management.body.expiresAt)) throw fail('PRIMER_MANAGEMENT_SESSION_REFUSED');
    const now = Date.now();
    entryState.tenants[row.id] = { state: 'outcome-uncertain' }; privateWrite(entryFile, entryState);
    try {
      await call('/api/v1/entries', { method: 'POST', body: { _id: 'synthetic-reading-' + index, type: 'sgv', sgv: index ? 177 : 123, date: now - 1000, dateString: new Date(now - 1000).toISOString(), direction: 'Flat', device: 'synthetic-compose-demo' }, headers: { 'api-secret': subject.accessToken } });
    } catch (error) {
      // A definite client refusal permits an explicit later retry. Transport
      // loss or a server error keeps the uncertainty fence for reconciliation.
      if (error.status >= 400 && error.status < 500) { delete entryState.tenants[row.id]; privateWrite(entryFile, entryState); }
      throw error;
    }
    results.set(row.id, { id: row.id, host: row.hosts[0], subject: subject._id, dataToken: subject.accessToken, ownerSubject: ownerSubject._id, managementToken: management.body.token, managementExpiresAt: management.body.expiresAt });
    privateWrite(tenantsFile, { version: 1, tenants: saved.filter(value => results.has(value.id)).map(value => results.get(value.id)) });
    delete entryState.tenants[row.id]; privateWrite(entryFile, entryState);
  };
  let cursor = 0, failure;
  const worker = async () => {
    while (!failure && !signal?.aborted && cursor < pending.length) {
      const item = pending[cursor++];
      try { await commission(item); } catch (error) { failure ||= error; }
    }
  };
  // Each tenant keeps its existing serial API sequence. Stop dispatching on
  // failure/cancellation, then drain every already-started tenant and save it.
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  if (failure) throw failure;
  if (results.size !== saved.length) return { state: 'synthetic-data-prime-partial', tenants: results.size, remaining: saved.length - results.size };
  const state = { state: 'synthetic-data-primed', tenants: results.size };
  privateWrite(completed, state); return state;
}
async function add(config, directory, options) {
  const settings = primeOptions(options);
  return withPrimerLock(directory, () => addOwned(config, directory, settings));
}
async function addOwned(config, directory, options) {
  const value = JSON.parse(fs.readFileSync(path.join(directory, 'add.json'), 'utf8'));
  if (!value || Object.keys(value).sort().join(',') !== 'tenants,version' || value.version !== 1 ||
      !Array.isArray(value.tenants) || !value.tenants.length || value.tenants.length > 100) throw fail('PRIMER_ADDITION_INVALID');
  for (const spec of value.tenants) require('../../lib/tenant-registry/provision').parseSpec(spec);
  await provisionOwned({ ...config, seed: value.tenants }, directory);
  return primeOwned(config, directory, options);
}
function parsePrimeOptions(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = { '--concurrency': 'concurrency', '--max-tenants': 'maxTenants' }[values[index]];
    if (!key || Object.hasOwn(options, key) || !/^[1-9][0-9]*$/.test(values[index + 1] || '')) throw fail('PRIMER_OPTIONS_INVALID');
    options[key] = Number(values[index + 1]);
  }
  primeOptions(options); return options;
}
async function main() {
  const [operation, ...values] = process.argv.slice(2), directory = process.env.NS_PRIMER_STATE || '/run/ns-primer';
  if (!['provision','prime','add'].includes(operation) || (operation === 'provision' && values.length)) throw fail('PRIMER_OPERATION_INVALID');
  const options = parsePrimeOptions(values), controller = new AbortController(); let stopped;
  const interrupt = () => { stopped = 130; controller.abort(); }, terminate = () => { stopped = 143; controller.abort(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    const config = load(path.join(directory, 'config.json'));
    const result = await ({ provision, prime, add }[operation](config, directory, { ...options, signal: controller.signal }));
    console.log(JSON.stringify(result));
    if (stopped || result.state === 'synthetic-data-prime-partial') process.exitCode = stopped || 2;
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); }
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ error: /^[A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'PRIMER_FAILED', ...(error.requestClass ? { requestClass: error.requestClass, responseError: error.responseError } : {}) })); process.exitCode = 1; });
module.exports = { refusal, requestClass, load, request, waitForTenant, provision, prime, add, privateWrite, primeOptions, parsePrimeOptions };
