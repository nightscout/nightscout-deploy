#!/usr/bin/env node
'use strict';

// Credentials exist before apply (decision provisioning-secrets-in). `seed` creates them once, in
// a new private directory: one PostgreSQL password per deployment role, the Vault token ids the
// roles use, and the deployment signing secret (decision deployment-signing-secret) from which the
// issuing roles derive every tenant token-signing key. The provisioning step creates the roles and
// tokens from these files; the document renderer reads them. Nothing reads a credential back out
// of a running container.
//
//   node credentials.js seed <new-directory>
//
// Layout: <dir>/postgres/<role kind>, <dir>/vault/<token name> and <dir>/signing-secret, one value
// per file, 0600. The signing secret is not Vault material and provisioning never reads it: Compose
// renders it into the api, admin and tenant-admin documents; Kubernetes makes it one Secret
// (ns-signing-secret) mounted into those three roles (scripts/secrets.sh).
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const TOKENS = Object.freeze(['api', 'owner-credentials', 'provisioner']);
const SIGNING = 'signing-secret';
// Hex only: a password is embedded in CREATE ROLE ... PASSWORD and in connection URLs, and Vault
// refuses custom token ids with a dot or a service-token prefix.
const VALUE = /^[a-f0-9]{64}$/;
const KIND = /^[a-z][a-z0-9_]{0,62}$/;
const fail = code => Object.assign(new Error(code), { code });

function roleKinds () { return Object.keys(require('./config').layout().roles); }

function seed (directory, kinds = roleKinds()) {
  fs.mkdirSync(directory, { mode: 0o700 });
  for (const [group, names] of [['postgres', kinds], ['vault', TOKENS]]) {
    fs.mkdirSync(path.join(directory, group), { mode: 0o700 });
    for (const name of names) {
      if (!KIND.test(name.replaceAll('-', '_'))) throw fail('CREDENTIAL_NAME_INVALID');
      fs.writeFileSync(path.join(directory, group, name), crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    }
  }
  fs.writeFileSync(path.join(directory, SIGNING), crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  return { postgres: kinds.length, vault: TOKENS.length, signing: 1 };
}

// Carry a complete earlier seed forward without changing any credential. Publish the
// new password atomically so two concurrent up commands cannot see a partial file.
function addOwnerSettings (directory, kinds = roleKinds()) {
  read(directory, kinds.filter(kind => kind !== 'owner_settings'));
  const file = path.join(directory, 'postgres', 'owner_settings');
  if (!fs.existsSync(file)) {
    const temporary = file + '-' + crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(temporary, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    try { fs.linkSync(temporary, file); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { fs.unlinkSync(temporary); }
  }
  value(file);
}

function value (file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').trim(); } catch { throw fail('SEEDED_CREDENTIAL_MISSING'); }
  if (!VALUE.test(text)) throw fail('SEEDED_CREDENTIAL_INVALID');
  return text;
}

function read (directory, kinds = roleKinds()) {
  return {
    postgres: Object.fromEntries(kinds.map(kind => [kind, value(path.join(directory, 'postgres', kind))])),
    vault: Object.fromEntries(TOKENS.map(name => [name, value(path.join(directory, 'vault', name))])),
  };
}
// The deployment signing secret, read only by the document renderer.
function signing (directory) { return value(path.join(directory, SIGNING)); }

// Connection URL per role kind; the database address is the deployment's, never a credential.
function urls (layout, passwords, { host = 'postgres', port = 5432, database = 'nightscout_compose_test' } = {}) {
  return Object.fromEntries(Object.entries(layout.roles).map(([kind, role]) => {
    const url = new URL('postgres://' + host + ':' + port + '/' + encodeURIComponent(database));
    url.username = role; url.password = passwords[kind];
    if (!url.password) throw fail('SEEDED_CREDENTIAL_MISSING');
    return [kind, url.toString()];
  }));
}

if (require.main === module) {
  try {
    if (!['seed', 'add-owner-settings'].includes(process.argv[2]) || process.argv.length !== 4) throw fail('CREDENTIALS_USAGE');
    process.umask(0o077);
    if (process.argv[2] === 'add-owner-settings') addOwnerSettings(path.resolve(process.argv[3]));
    else console.log(JSON.stringify({ state: 'seeded', ...seed(path.resolve(process.argv[3])) }));
  } catch (error) {
    console.error(JSON.stringify({ error: /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'CREDENTIALS_SEED_FAILED' }));
    process.exitCode = 1;
  }
}
module.exports = { TOKENS, SIGNING, seed, addOwnerSettings, read, signing, urls };
