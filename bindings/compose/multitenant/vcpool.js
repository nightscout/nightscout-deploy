'use strict';

// The vcpool role's deployment identities (core MT-CONNECTOR-REVERSE, decisions
// first-preview-no-push-provider, registry-connector-definitions). Off unless a vcpool credential
// directory was seeded (`NS_VCPOOL=1` at seed); with none, nothing here runs and seed, render and
// bootstrap behave exactly as before.
//
// Core reads three connections (lib/server/serve/deployment-settings.js SECRETS.vcpool) and requires
// them to be three separate identities (lib/tenant-connector/config.js parse):
//   NS_VCPOOL_SECRETS_PG      <prefix>_vcpool_secrets     decrypt-side reads of secret_records, audit insert
//   NS_VCPOOL_ACTIVITY_PG     <prefix>_activity_reader    the existing tenant_activity reader (also the evaluator's)
//   NS_VCPOOL_DEFINITIONS_PG  <prefix>_vcpool_definitions connector definitions + registry reader
//                                                        (core postgres-sources.grants({reader}))
// and one Vault token, <NS_SECRETS_DIR>/vcpool-token, whose policy decrypts tenant data keys only.
// Core's ordinary-deployment-grants.js names no vcpool identity, so the grants live here, built from
// the core helpers where core has one.
//
// Seeded layout (flat, one Secret ns-credentials-vcpool): <dir>/vcpool/vcpool_secrets,
// <dir>/vcpool/vcpool_definitions, <dir>/vcpool/vault-token.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const KINDS = Object.freeze(['vcpool_secrets', 'vcpool_definitions']);
const TOKEN = 'vault-token';
const VALUE = /^[a-f0-9]{64}$/;
const fail = code => Object.assign(new Error(code), { code });

function directory (credentials) { return path.join(credentials, 'vcpool'); }
function seed (credentials) {
  const dir = directory(credentials);
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const name of [...KINDS, TOKEN]) fs.writeFileSync(path.join(dir, name), crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  return { vcpool: KINDS.length + 1 };
}
function value (file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').trim(); } catch { throw fail('SEEDED_VCPOOL_CREDENTIAL_MISSING'); }
  if (!VALUE.test(text)) throw fail('SEEDED_VCPOOL_CREDENTIAL_INVALID');
  return text;
}
// null when vcpool was not seeded; otherwise every value, or a refusal.
function read (credentials) {
  const dir = directory(credentials);
  if (!fs.existsSync(dir)) return null;
  return { postgres: Object.fromEntries(KINDS.map(kind => [kind, value(path.join(dir, kind))])), token: value(path.join(dir, TOKEN)) };
}
function roles (l) { return Object.fromEntries(KINDS.map(kind => [kind, l.prefix + '_' + kind])); }

function grants (l) {
  const q = require('./config').quote, ns = l.namespaces, r = roles(l), sql = [];
  // Decrypt reads one tenant's records under its row-security binding; each decrypt writes one audit row.
  sql.push('GRANT USAGE ON SCHEMA ' + q(ns.secrets) + ' TO ' + q(r.vcpool_secrets),
    'GRANT SELECT ON ' + q(ns.secrets) + '.secret_records TO ' + q(r.vcpool_secrets),
    'GRANT INSERT ON ' + q(ns.secrets) + '.secret_audit TO ' + q(r.vcpool_secrets));
  sql.push(...require('../../lib/tenant-connector/postgres-sources').grants({
    namespaces: { settings: ns.display_settings, registry: ns.registry, secrets: ns.secrets, control: ns.control }, reader: r.vcpool_definitions }));
  return sql;
}

// The vcpool role document: its three connection files and its Vault token, beside the other roles'.
function render ({ output, credentials, l, postgres }) {
  const seeded = read(credentials);
  if (!seeded) { fs.rmSync(path.join(output, 'vcpool'), { recursive: true, force: true }); return null; }
  const login = (role, password) => {
    const url = new URL('postgres://' + postgres.host + ':' + postgres.port + '/' + encodeURIComponent(postgres.database));
    url.username = role; url.password = password; return url.toString();
  };
  const activity = require('./credentials').read(credentials, ['activity_reader']).postgres.activity_reader;
  const r = roles(l), files = {
    ns_vcpool_secrets_pg: login(r.vcpool_secrets, seeded.postgres.vcpool_secrets),
    ns_vcpool_activity_pg: login(l.roles.activity_reader, activity),
    ns_vcpool_definitions_pg: login(r.vcpool_definitions, seeded.postgres.vcpool_definitions),
    'vcpool-token': seeded.token
  };
  const write = require('./render').write;
  for (const [name, text] of Object.entries(files)) write(path.join(output, 'vcpool', name), text + '\n');
  return Object.keys(files).length;
}

// Bootstrap step, fresh and existing paths alike: create any missing vcpool login, apply its grants,
// and install the Vault policy and token. Idempotent; a no-op without seeded vcpool credentials.
async function ensure ({ admin, l, credentials, request, rootToken }) {
  const seeded = read(credentials);
  if (!seeded) return { vcpool: 'not-seeded' };
  const q = require('./config').quote, r = roles(l);
  for (const kind of KINDS) {
    if ((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [r[kind]])).rowCount) continue;
    // Hex only (value()), so the literal cannot leave its quotes.
    await admin.query('CREATE ROLE ' + q(r[kind]) + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + seeded.postgres[kind] + "'");
  }
  for (const sql of grants(l)) await admin.query(sql);
  const policy = l.prefix + '_vcpool';
  await request('sys/policies/acl/' + policy, { policy: 'path "' + l.mount + '/decrypt/tenant-data-*" { capabilities = ["update"] }' }, rootToken);
  let present = true;
  try { await request('auth/token/lookup', { token: seeded.token }, rootToken); } catch { present = false; }
  if (!present) await request('auth/token/create', { id: seeded.token, policies: [policy], no_default_policy: true, renewable: true, ttl: '24h' }, rootToken);
  return { vcpool: 'ready', tokenCreated: !present };
}

module.exports = { KINDS, TOKEN, directory, seed, read, roles, grants, render, ensure };
