'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { setImmediate } = require('node:timers/promises');

for (const finishFails of [false, true]) {
  test(`bootstrap closes the admin client after registry completion ${finishFails ? 'rejects' : 'succeeds'}`, async t => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-bootstrap-lifetime-'));
    t.after(() => fs.rmSync(output, {recursive: true, force: true}));
    t.mock.method(globalThis, 'fetch', async () => ({ok: true, json: async () => ({})}));

    const events = [];
    const finishError = new Error('registry finish refused');
    class Client {
      async connect() { this.open = true; }
      async query() {
        assert.ok(this.open, 'query after admin close');
        return {rows: []};
      }
      async end() { this.open = false; events.push('close'); }
    }
    async function finish({admin}) {
      events.push('finish-start');
      await setImmediate();
      await admin.query();
      events.push('finish-settled');
      if (finishFails) throw finishError;
      return {state: 'complete'};
    }
    // Exercise bootstrap's real try/finally with only its external setup ports replaced.
    const modules = {
      pg: {Client},
      './config': {layout: () => ({roles: {}, namespaces: {}}), quote: String, nativeSelection: () => ({}), catalogues: () => ({}), grants: () => []},
      './evaluator-workers': {selection: () => undefined},
      './clinical-isolation': {grants: () => []},
      '../../lib/migrations/postgres': {},
      '../../lib/management-sessions/authority': {grants: () => ({authorityOwner: [], issuer: []})},
      './output-grants': {outputGrants: () => async () => {}},
      '../../lib/server/serve/deployment-settings': {evaluator: () => ({consumer: 'evaluator-fixture'})},
      './credentials': {read: () => ({postgres: {}, vault: {}})},
      './registry-bootstrap': {finish}
    };
    const file = require.resolve('../bootstrap');
    const loaded = new Module(file, module);
    loaded.filename = file;
    loaded.require = name => Object.hasOwn(modules, name) ? modules[name] : require(name);
    loaded._compile(fs.readFileSync(file, 'utf8'), file);
    const result = loaded.exports.bootstrap({
      output, credentials: '/fixture-credentials', vault: {origin: 'https://fixture.invalid'}, pg: {pathname: '/fixture', toString: () => ''}
    });
    if (finishFails) await assert.rejects(result, error => error === finishError);
    else assert.equal((await result).state, 'complete');
    assert.deepEqual(events, ['finish-start', 'finish-settled', 'close']);
  });
}
