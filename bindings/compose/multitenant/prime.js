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
function request(origin, route, { method = 'GET', body, headers = {} } = {}) {
  const url = new URL(route, origin), bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { accept: 'application/json', ...headers, ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) }, timeout: 60000 }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 16777216) req.destroy(fail('PRIMER_RESPONSE_TOO_LARGE')); else chunks.push(chunk); });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { reject(fail('PRIMER_RESPONSE_INVALID')); } });
      res.on('error', () => reject(fail('PRIMER_RESPONSE_INCOMPLETE')));
    });
    req.on('timeout', () => req.destroy(fail('PRIMER_TIMEOUT'))); req.on('error', () => reject(fail('PRIMER_CONNECTION_FAILED'))); req.end(bytes);
  });
}
function privateWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.new'; fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file);
}
async function provision(config, directory) {
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
async function prime(config, directory) {
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'provisioned.json'), 'utf8'));
  const completed = path.join(directory, 'primed.json');
  if (fs.existsSync(completed)) return JSON.parse(fs.readFileSync(completed, 'utf8'));
  const results = [];
  const ownership = require('../../lib/server/internal-api/clients').ownershipOperations({ url: config.adminOrigin, trust: 'network', maxBytes: 1048576, timeoutMs: 60000 });
  const requestFile = path.join(directory, 'management-requests.json');
  const managementRequests = fs.existsSync(requestFile) ? JSON.parse(fs.readFileSync(requestFile, 'utf8')) : {};
  for (const [index, row] of saved.entries()) {
    const headers = { host: row.hosts[0], 'api-secret': crypto.createHash('sha1').update(row.rootSecret).digest('hex') };
    const call = async (route, options = {}) => {
      const response = await request(config.apiOrigin, route, { ...options, headers: { ...headers, ...options.headers } });
      if (response.status < 200 || response.status >= 300) throw fail('PRIMER_DATA_API_REFUSED_' + response.status);
      return response.body;
    };
    const roles = await call('/api/v2/authorization/roles');
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
    await call('/api/v1/entries', { method: 'POST', body: { _id: 'synthetic-reading-' + index, type: 'sgv', sgv: index ? 177 : 123, date: now - 1000, dateString: new Date(now - 1000).toISOString(), direction: 'Flat', device: 'synthetic-compose-demo' }, headers: { 'api-secret': subject.accessToken } });
    results.push({ id: row.id, host: row.hosts[0], subject: subject._id, dataToken: subject.accessToken, ownerSubject: ownerSubject._id, managementToken: management.body.token, managementExpiresAt: management.body.expiresAt });
    privateWrite(path.join(directory, 'tenants.json'), { version: 1, tenants: results });
  }
  const state = { state: 'synthetic-data-primed', tenants: results.length };
  privateWrite(completed, state); return state;
}
async function main() {
  const [operation] = process.argv.slice(2), directory = process.env.NS_PRIMER_STATE || '/run/ns-primer';
  const config = load(path.join(directory, 'config.json'));
  if (!['provision','prime'].includes(operation)) throw fail('PRIMER_OPERATION_INVALID');
  console.log(JSON.stringify(await (operation === 'provision' ? provision(config, directory) : prime(config, directory))));
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ error: /^[A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'PRIMER_FAILED' })); process.exitCode = 1; });
module.exports = { load, request, provision, prime, privateWrite };
