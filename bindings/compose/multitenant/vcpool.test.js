'use strict';
// vcpool identities (vcpool.js): nothing without a vcpool seed; with one, three connection files and
// the token in the role document, two logins, and grants that read secrets and definitions only.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vcpool = require('./vcpool'), credentials = require('./credentials'), render = require('./render');

function lab () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-vcpool-')), creds = path.join(dir, 'credentials'), output = path.join(dir, 'out');
  credentials.seed(creds);
  return { dir, creds, output, postgres: { host: 'postgres', port: 5432, database: 'nightscout_compose_test' } };
}

test('without a vcpool seed: read is null, render writes nothing, ensure is a no-op', async () => {
  const { dir, creds, output, postgres } = lab();
  try {
    assert.equal(vcpool.read(creds), null);
    assert.equal(vcpool.render({ output, credentials: creds, l: require('./config').layout(), postgres, write: render.write }), null);
    assert.equal(fs.existsSync(path.join(output, 'vcpool')), false);
    const queries = [];
    assert.deepEqual(await vcpool.ensure({ admin: { query: async sql => { queries.push(sql); return { rowCount: 0 }; } }, l: require('./config').layout(), credentials: creds,
      request: async () => { throw new Error('no Vault call expected'); }, rootToken: 'unused' }), { vcpool: 'not-seeded' });
    assert.deepEqual(queries, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('with a vcpool seed: the role document, two logins, read-only grants and a decrypt-only token', async () => {
  const { dir, creds, output, postgres } = lab(), l = require('./config').layout();
  try {
    vcpool.seed(creds);
    const seeded = vcpool.read(creds);
    assert.equal(vcpool.render({ output, credentials: creds, l, postgres, write: render.write }), 4);
    const doc = name => fs.readFileSync(path.join(output, 'vcpool', name), 'utf8').trim();
    assert.equal(new URL(doc('ns_vcpool_secrets_pg')).username, 'nsdemo_vcpool_secrets');
    assert.equal(new URL(doc('ns_vcpool_activity_pg')).username, 'nsdemo_activity_reader');
    assert.equal(new URL(doc('ns_vcpool_definitions_pg')).username, 'nsdemo_vcpool_definitions');
    assert.equal(doc('vcpool-token'), seeded.token);
    // Core's own vcpool settings reader accepts the document (three separate identities).
    const settings = require('../../lib/server/serve/deployment-settings');
    const value = settings.configuration('vcpool', settings.withSecrets({ NS_SECRETS_DIR: path.join(output, 'vcpool'), NS_VCPOOL_API_URL: 'http://api:1337', NS_VCPOOL_ALLOW_HOSTS: 'nightscout-upstream', NS_VAULT_ADDR: 'https://vault:8200' }));
    assert.equal(value.api.url, 'http://api:1337');
    const grants = vcpool.grants(l).join('\n');
    assert.match(grants, /GRANT SELECT ON "nsdemo_secrets".secret_records TO "nsdemo_vcpool_secrets"/);
    assert.match(grants, /GRANT INSERT ON "nsdemo_secrets".secret_audit TO "nsdemo_vcpool_secrets"/);
    assert.doesNotMatch(grants, /GRANT (INSERT|UPDATE|DELETE)[^\n]*secret_records[^\n]*vcpool/);
    assert.doesNotMatch(grants, /GRANT (INSERT|UPDATE|DELETE)[^\n]*tenant_connector_sources[^\n]*vcpool_definitions/);
    const queries = [], vault = [];
    const result = await vcpool.ensure({ admin: { query: async sql => { queries.push(sql); return { rowCount: 0 }; } }, l, credentials: creds, rootToken: 'root',
      request: async (resource, body) => { vault.push([resource, body]); if (resource === 'auth/token/lookup') throw new Error('absent'); return {}; } });
    assert.deepEqual(result, { vcpool: 'ready', tokenCreated: true });
    assert.equal(queries.filter(q => q.startsWith('CREATE ROLE')).length, 2);
    assert.deepEqual(vault.map(v => v[0]), ['sys/policies/acl/nsdemo_vcpool', 'auth/token/lookup', 'auth/token/create']);
    assert.equal(vault[0][1].policy, 'path "nsdemo_transit/decrypt/tenant-data-*" { capabilities = ["update"] }');
    assert.deepEqual(vault[2][1].policies, ['nsdemo_vcpool']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
