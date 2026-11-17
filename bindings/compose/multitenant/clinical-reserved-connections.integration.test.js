'use strict';
// Native PostgreSQL control for the clinical connection reserve (clinical-isolation.js).
// A disposable container with a small max_connections/reserved_connections, the
// binding's actual role names and the actual bootstrap grant statements. REST-side
// roles fill every general slot; clinical roles must still connect and query.
// Removing the grant must make the same clinical connection fail. Synthetic only:
// a random per-run password, no deployment state, no running stack is touched.
// Run in a prepared core tree: NS_CLINICAL_RESERVE_TEST_IMAGE=postgres@sha256:<digest> node --test <this file>
const {test} = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), {execFileSync} = require('node:child_process');
const image = process.env.NS_CLINICAL_RESERVE_TEST_IMAGE;
const docker = (args, env) => execFileSync('docker', args, {encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? {env: {...process.env, ...env}} : {})}).trim();

test('REST-side roles at the general-slot limit cannot take the clinical reserve', {skip: !image && 'set NS_CLINICAL_RESERVE_TEST_IMAGE to a pinned PostgreSQL 16 image', timeout: 120000}, async () => {
  assert.match(image, /^[^@\s]+@sha256:[a-f0-9]{64}$/, 'pinned image digest required');
  const {Client} = require('pg'), isolation = require('./clinical-isolation'), plan = require('./config'), layout = plan.layout();
  const password = crypto.randomBytes(24).toString('hex'), run = 'ns-clinical-reserve-' + crypto.randomBytes(6).toString('hex');
  const MAX = 12, RESERVED = 4, GENERAL = MAX - isolation.SUPERUSER_RESERVED - RESERVED;
  const id = docker(['run', '--detach', '--label', 'ns-clinical-reserve-test=' + run, '-e', 'POSTGRES_PASSWORD', '-p', '127.0.0.1::5432', image,
    'postgres', '-c', 'max_connections=' + MAX, '-c', 'reserved_connections=' + RESERVED], {POSTGRES_PASSWORD: password});
  const opened = [];
  try {
    const port = Number(docker(['port', id, '5432/tcp']).split('\n')[0].split(':').pop());
    const url = (user, secret) => { const u = new URL('postgres://127.0.0.1/postgres'); u.port = String(port); u.username = user; u.password = secret; return u.toString(); };
    const connect = async (user, secret = password) => { const c = new Client({connectionString: url(user, secret), connectionTimeoutMillis: 5000}); c.on('error', () => {}); await c.connect(); opened.push(c); return c; };
    let admin;
    for (const end = Date.now() + 60000; !admin;) {
      try { admin = await connect('postgres'); await admin.query('SELECT 1'); } catch (error) { admin = null; if (Date.now() > end) throw error; await new Promise(r => setTimeout(r, 500)); }
    }
    assert.deepEqual((await admin.query("SELECT current_setting('max_connections')::int AS max, current_setting('reserved_connections')::int AS reserved, current_setting('superuser_reserved_connections')::int AS superuser")).rows[0],
      {max: MAX, reserved: RESERVED, superuser: isolation.SUPERUSER_RESERVED});
    const rolePassword = crypto.randomBytes(24).toString('hex');
    for (const role of [layout.roles.api, ...isolation.clinicalRoles(layout)]) await admin.query('CREATE ROLE ' + plan.quote(role) + " LOGIN PASSWORD '" + rolePassword + "'");
    // The actual statements bootstrap.js runs.
    for (const sql of isolation.grants(layout)) await admin.query(sql);
    // The admin session holds one general slot; the api role takes every other one, then is refused.
    const api = [];
    let refusal;
    for (let i = 0; i < GENERAL + 2 && !refusal; i++) {
      try { api.push(await connect(layout.roles.api, rolePassword)); } catch (error) { refusal = error; }
    }
    assert.equal(api.length, GENERAL - 1, 'api role fills the general slots left after the admin session');
    assert.equal(refusal?.code, '53300', 'api role refused at the general-slot limit: ' + refusal?.message);
    // Clinical roles still connect and query from the reserve.
    for (const kind of ['evaluator', 'realtime', 'pgstream']) {
      const client = await connect(layout.roles[kind], rolePassword);
      assert.deepEqual((await client.query('SELECT 1 AS ok')).rows, [{ok: 1}], kind + ' queries while the api role is at its limit');
    }
    // Control: the same clinical connection without the grant is refused.
    await admin.query('REVOKE pg_use_reserved_connections FROM ' + plan.quote(layout.roles.outbox));
    await assert.rejects(connect(layout.roles.outbox, rolePassword), error => error.code === '53300', 'REVOKED_CLINICAL_ROLE_REFUSED');
    await admin.query('GRANT pg_use_reserved_connections TO ' + plan.quote(layout.roles.outbox));
    const restored = await connect(layout.roles.outbox, rolePassword);
    assert.deepEqual((await restored.query('SELECT 1 AS ok')).rows, [{ok: 1}]);
    console.log('CLINICAL_RESERVE general=' + GENERAL + ' apiAdmitted=' + api.length + ' apiRefused=53300 clinicalConnected=evaluator,realtime,pgstream revokedRefused=53300 restoredConnected');
  } finally {
    await Promise.allSettled(opened.map(c => c.end()));
    docker(['rm', '--force', '--volumes', id]);
    assert.equal(docker(['ps', '-a', '--filter', 'label=ns-clinical-reserve-test=' + run, '--format', '{{.ID}}']), '', 'disposable container removed');
  }
});
