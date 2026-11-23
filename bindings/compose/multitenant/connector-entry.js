#!/usr/bin/env node
'use strict';

// Operator entry of tenant-side Nightscout connectors for the vcpool role (decisions
// first-preview-no-push-provider, registry-connector-definitions). A lab/operator Job, never a
// serving role. For each tenant in its input it:
//   1. creates (or reuses) the tenant-bound connector subject through the tenant's own API with the
//      tenant root secret, as a single site's admin would (role `vcpool-connector`: read+create on
//      the copied collections, read on profile: the connector reads its gap from the tenant first);
//   2. enters three tenant secrets (source endpoint, source credential, the subject's access
//      token) through core's secrets component under the tenant's binding, with the provisioning
//      identity (PostgreSQL provisioner login, Vault encrypt on tenant data keys only);
//   3. creates the connector definition (references only) through the private admin API.
// Core has no HTTP resource that enters a tenant secret value; the connector-sources resource
// requires the references to exist first (core docs/tenant-connector.md).
//
//   NS_CONNECTOR_ENTRY_INPUT  /run/ns-connector-entry/input.json
//       { version: 1, sourceId, collections, tenants: [{ id, endpoint, sourceCredential }] }
//   NS_PRIMER_STATE           the primer roster directory (tenants.json: id, host, rootSecret)
//   NS_SECRETS_DIR            the admin role document (ns_provisioner_pg, vault-token)
//   NS_CONNECTOR_API_ORIGIN, NS_CONNECTOR_ADMIN_ORIGIN, NS_VAULT_ADDR
// Output (stdout, one JSON line): counts and fixed codes only; never ids, hosts or credentials.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), http = require('node:http');
const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SOURCE = /^[A-Za-z0-9_-]{1,64}$/;
const COLLECTIONS = ['entries', 'treatments', 'devicestatus', 'profiles'];
const SUBJECT = 'vcpool-connector', ROLE = 'vcpool-connector';
const sha1 = text => crypto.createHash('sha1').update(text).digest('hex');

function permissions (collections) {
  const out = [];
  for (const name of ['entries', 'treatments', 'devicestatus']) {
    // The output reads every collection's newest row for its gap; it writes only the copied ones.
    out.push('api:' + name + ':' + (collections.includes(name) ? 'read,create' : 'read'));
  }
  out.push('api:profile:' + (collections.includes('profiles') ? 'read,create,update' : 'read'));
  return out;
}
function refs (sourceId) {
  return { sourceEndpoint: 'connector-' + sourceId + '-endpoint', sourceCredential: 'connector-' + sourceId + '-source', writeCredential: 'connector-' + sourceId + '-write' };
}

function input (env = process.env) {
  const file = env.NS_CONNECTOR_ENTRY_INPUT || '/run/ns-connector-entry/input.json';
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || value.version !== 1 || !SOURCE.test(value.sourceId || '') || !Array.isArray(value.collections) || !value.collections.length ||
      value.collections.some(name => !COLLECTIONS.includes(name)) || new Set(value.collections).size !== value.collections.length ||
      !Array.isArray(value.tenants) || !value.tenants.length ||
      value.tenants.some(row => !ID.test(row?.id || '') || typeof row.endpoint !== 'string' || typeof row.sourceCredential !== 'string' || !row.sourceCredential)) {
    throw fail('CONNECTOR_ENTRY_INPUT_INVALID');
  }
  const roster = JSON.parse(fs.readFileSync(path.join(env.NS_PRIMER_STATE || '/run/ns-client', 'tenants.json'), 'utf8'));
  const known = new Map((roster.tenants || []).map(row => [row.id, row]));
  for (const row of value.tenants) {
    const r = known.get(row.id);
    if (!r || typeof r.host !== 'string' || typeof r.rootSecret !== 'string' || !r.rootSecret) throw fail('CONNECTOR_ENTRY_ROSTER_MISSING');
  }
  return { ...value, roster: known, api: env.NS_CONNECTOR_API_ORIGIN || 'http://api:1337', admin: env.NS_CONNECTOR_ADMIN_ORIGIN || 'http://admin:1342',
    vault: env.NS_VAULT_ADDR || 'https://vault:8200', secretsDir: env.NS_SECRETS_DIR || '/run/ns-config' };
}

function request (origin, route, { method = 'GET', body, headers = {} } = {}) {
  const url = new URL(route, origin), bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, timeout: 30000,
      headers: { accept: 'application/json', ...headers, ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(fail('CONNECTOR_ENTRY_TIMEOUT')));
    req.on('error', error => reject(fail('CONNECTOR_ENTRY_CONNECTION_FAILED', { cause: error.code })));
    req.end(bytes);
  });
}

// The connector subject's access token, through the tenant root's single-site subject administration.
async function subjectToken (options, tenant, collections) {
  const headers = { Host: tenant.host, 'API-SECRET': sha1(tenant.rootSecret) };
  const roles = await request(options.api, '/api/v2/authorization/roles', { headers });
  if (roles.status !== 200 || !Array.isArray(roles.body)) throw fail('CONNECTOR_ENTRY_ROLES_REFUSED', { status: roles.status });
  if (!roles.body.some(role => role.name === ROLE)) {
    const created = await request(options.api, '/api/v2/authorization/roles', { method: 'POST', headers,
      body: { name: ROLE, permissions: permissions(collections), notes: 'synthetic vcpool connector' } });
    if (created.status >= 300) throw fail('CONNECTOR_ENTRY_ROLE_CREATE_REFUSED', { status: created.status });
  }
  const find = async () => {
    const listed = await request(options.api, '/api/v2/authorization/subjects', { headers });
    if (listed.status !== 200 || !Array.isArray(listed.body)) throw fail('CONNECTOR_ENTRY_SUBJECTS_REFUSED', { status: listed.status });
    return listed.body.find(subject => subject.name === SUBJECT);
  };
  let subject = await find(), outcome = 'existing';
  if (!subject) {
    const created = await request(options.api, '/api/v2/authorization/subjects', { method: 'POST', headers,
      body: { name: SUBJECT, roles: [ROLE], notes: 'synthetic vcpool connector' } });
    if (created.status >= 300) throw fail('CONNECTOR_ENTRY_SUBJECT_CREATE_REFUSED', { status: created.status });
    subject = await find(); outcome = 'created';
  }
  if (!subject || typeof subject.accessToken !== 'string' || !subject.accessToken) throw fail('CONNECTOR_ENTRY_SUBJECT_TOKEN_MISSING');
  return { token: subject.accessToken, outcome };
}

async function secretsComponent (options) {
  require('../../lib/storage/tenant-scope').setTenancyMode('multi');
  const settings = require('../../lib/server/serve/deployment-settings');
  const source = settings.withSecrets({ ...process.env, NS_SECRETS_DIR: options.secretsDir });
  const l = settings.layout(source);
  const token = fs.readFileSync(path.join(options.secretsDir, 'vault-token'), 'utf8').trim();
  const persistence = await require('../../lib/secrets/postgres').createPostgresSecrets({ connectionString: source.NS_PROVISIONER_PG, namespace: l.namespaces.secrets });
  const rules = require('../../lib/tenant-registry/rules');
  const actor = { principal: 'compose-provisioning', consumer: 'connector-entry' };
  const secrets = require('../../lib/secrets/component').createSecrets({ ...persistence, maxTokenLifetimeSeconds: 1,
    providerFor: async tenant => require('../../lib/secrets/vault-transit').createVaultTransit({ address: options.vault, mount: l.mount,
      encryptionKey: rules.vaultKey(tenant, 'data'), getToken: async () => token }),
    // Encrypt only, and only the connector's three references.
    authorize: async (identity, action) => identity.principal === actor.principal && identity.consumer === actor.consumer &&
      action.operation === 'encrypt' && Object.values(refs(options.sourceId)).includes(action.id) });
  return { actor, secrets, close: () => persistence.close() };
}

async function enter (options, component, tenant, row) {
  const ids = refs(options.sourceId), outcomes = {};
  const subject = await subjectToken(options, tenant, options.collections);
  const values = { sourceEndpoint: row.endpoint, sourceCredential: row.sourceCredential, writeCredential: subject.token };
  for (const [field, id] of Object.entries(ids)) {
    try {
      await component.secrets.encrypt({ tenant: tenant.id, ...component.actor }, id, Buffer.from(values[field]));
      outcomes[field] = 'created';
    } catch (error) {
      // A repeated entry keeps the first value; rotation is a separate operator act.
      if (error.code !== 'SECRETS_REFERENCE_EXISTS') throw fail(error.code || 'CONNECTOR_ENTRY_SECRET_FAILED');
      outcomes[field] = 'existing';
    }
  }
  const definition = { ifGeneration: 0, enabled: true, connector: { collections: options.collections, ...ids, sourceCredentialKind: 'token' } };
  const route = '/v1/tenants/' + tenant.id + '/connector-sources/' + options.sourceId;
  let put = await request(options.admin, route, { method: 'PUT', body: definition });
  if (put.status === 409) {
    const current = await request(options.admin, route);
    const same = current.status === 200 && JSON.stringify(current.body?.connector) === JSON.stringify(definition.connector) && current.body?.enabled === true;
    if (!same) throw fail('CONNECTOR_ENTRY_DEFINITION_CONFLICT');
    put = { status: 200, body: { outcome: 'existing' } };
  }
  if (put.status !== 200 && put.status !== 201) throw fail('CONNECTOR_ENTRY_DEFINITION_REFUSED', { status: put.status, detail: put.body?.code });
  return { subject: subject.outcome, secrets: outcomes, definition: put.body?.outcome || 'created' };
}

async function main (env = process.env) {
  const options = input(env), component = await secretsComponent(options), counts = {};
  const bump = key => { counts[key] = (counts[key] || 0) + 1; };
  try {
    for (const row of options.tenants) {
      const result = await enter(options, component, { id: row.id, ...options.roster.get(row.id) }, row);
      bump('subject:' + result.subject); bump('definition:' + result.definition);
      for (const outcome of Object.values(result.secrets)) bump('secret:' + outcome);
    }
  } finally { await component.close().catch(() => {}); }
  return { state: 'connectors-entered', tenants: options.tenants.length, counts };
}

if (require.main === module) {
  process.umask(0o077);
  main().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    process.stderr.write(JSON.stringify({ error: /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'CONNECTOR_ENTRY_FAILED',
      ...(Number.isSafeInteger(error?.status) ? { status: error.status } : {}), ...(typeof error?.detail === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.detail) ? { detail: error.detail } : {}),
      ...(typeof error?.cause === 'string' ? { cause: error.cause } : {}) }) + '\n');
    process.exitCode = 1;
  });
}
module.exports = { permissions, refs, input, main };
