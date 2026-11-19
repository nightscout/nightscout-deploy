#!/usr/bin/env node
'use strict';

// Credentials exist before apply (decision provisioning-secrets-in). `seed` creates them once, in
// a new private directory: one PostgreSQL password per deployment role and the Vault token ids the
// roles use. The provisioning step creates the roles and tokens from these files; the document
// renderer reads them. Nothing reads a credential back out of a running container.
//
//   node credentials.js seed <new-directory>
//
// Layout: <dir>/postgres/<role kind> and <dir>/vault/<token name>, one value per file, 0600.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const TOKENS = Object.freeze(['api', 'owner-credentials', 'management-issuer', 'provisioner']);
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
  return { postgres: kinds.length, vault: TOKENS.length };
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
    if (process.argv[2] !== 'seed' || process.argv.length !== 4) throw fail('CREDENTIALS_USAGE');
    process.umask(0o077);
    console.log(JSON.stringify({ state: 'seeded', ...seed(path.resolve(process.argv[3])) }));
  } catch (error) {
    console.error(JSON.stringify({ error: /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'CREDENTIALS_SEED_FAILED' }));
    process.exitCode = 1;
  }
}
module.exports = { TOKENS, seed, read, urls };
