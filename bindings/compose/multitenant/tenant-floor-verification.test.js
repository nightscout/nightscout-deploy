'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const floors = require('./tenant-floor-verification');
const A = '11111111-1111-4111-8111-111111111111';
const config = { floorVerification: { adminOrigin: 'http://admin:1342', namespace: 'synthetic_verification' } };
const receipt = { version: 1, namespace: 'synthetic_verification', tenant: A, status: 'verified', generation: '2' };
test('operator postcondition carries only a selected private admin origin and namespace', () => {
  assert.deepEqual(floors.selection(config.floorVerification), config.floorVerification);
  for (const value of [undefined, {}, { ...config.floorVerification, database: 'forbidden' }, { ...config.floorVerification, adminOrigin: 'https://example.test' }, { ...config.floorVerification, namespace: 'public' }]) assert.throws(() => floors.selection(value), { code: 'COMPOSE_OPERATOR_FLOOR_VERIFICATION_REQUIRED' });
});
test('operator verifies the same tenant through admin and validates its recorded result', async () => {
  const calls = [];
  assert.deepEqual(await floors.verify(config, A, { request: async (...args) => { calls.push(args); return { status: 200, body: receipt }; } }), receipt);
  assert.deepEqual(calls, [['http://admin:1342', '/v1/platform-verification/tenants/' + A,
    { method: 'POST', body: {}, timeoutMs: 60000, classification: 'platform-verify' }]]);
  await assert.rejects(floors.verify(config, A, { request: async () => ({ status: 503 }) }), { code: 'COMPOSE_OPERATOR_FLOOR_VERIFICATION_REFUSED' });
  for (const body of [{ ...receipt, tenant: 'foreign' }, { ...receipt, namespace: 'other' }, { ...receipt, status: 'failed' }, { ...receipt, generation: -1 }]) await assert.rejects(floors.verify(config, A, { request: async () => ({ status: 200, body }) }), { code: 'COMPOSE_OPERATOR_FLOOR_VERIFICATION_RECEIPT' });
});
function driver (verify, mutate = source => source) {
  const file = require.resolve('./restore'), local = createRequire(file), loaded = { exports: {} }, events = [];
  const requireFor = name => {
    if (name === 'pg') return { Pool: class {
      async connect () {
        return { async query (sql, args) {
          if (sql.includes('tenant_lifecycle_restore_authority')) {
            assert.deepEqual(args, [A]);
            events.push('current-grant');
            return { rows: [{ key: '7' }] };
          }
          return { rows: [] };
        }, release () {} };
      }
      async end () {}
    } };
    if (name === './config') return { quote: name => '"' + name + '"', layout: () => ({}), lifecycle: () => ({ catalogues: [{ kind: 'entries', candidate: {} }] }) };
    if (name === './operator-selection') return { verifier: () => undefined };
    if (name === './tenant-floor-verification') return { ...floors, verify: async (...args) => { events.push('verify'); return verify(...args); } };
    if (name === '../../lib/storage/tenant-scope') return { setTenancyMode () {} };
    if (name === '../../lib/tenant-lifecycle') return { createLifecycle: () => ({ async restoreLogical (_connection, _artifact, options) { events.push('data-committed'); await options.onCommitted({}); return {}; } }) };
    if (name === '../../lib/tenant-lifecycle/maintenance-window') return { create: () => ({ async withRestore (_tenant, _options, fn) { events.push('suspended'); const result = await fn({ connection: {}, maintenanceClaim: {} }); events.push('activated'); return result; } }) };
    if (name === '../../lib/tenant-lifecycle/restore-resume') return { create: options => ({
      async resume (tenant) {
        assert.deepEqual(options.locks, [{ tenant, key: '7' }]);
        events.push('excluded');
        if (options.beforeActivation) await options.beforeActivation(tenant);
        events.push('activated');
      },
      async close () {}
    }) };
    return local(name);
  };
  vm.runInThisContext('(function(require,module,exports){' + mutate(fs.readFileSync(file, 'utf8')) + '\n})', { filename: file })(requireFor, loaded, loaded.exports);
  const operator = { ...config, version: 3, control: { namespace: 'synthetic_control', registry: { namespace: 'synthetic_registry' } },
    namespaces: { entries: 'synthetic_entries' }, catalogues: [{ kind: 'entries', candidate: {} }], drainTimeoutMs: 1000 };
  return { events,
    restore: () => loaded.exports.restore(operator, { digest: 'a'.repeat(64), manifest: { tenant: A } }, {}),
    resume: () => loaded.exports.recover(operator, 'resume', A, '22222222-2222-4222-8222-222222222222', {}) };
}
test('actual restore adapter awaits the admin postcondition after DATA commit and before activation', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const run = driver(() => barrier), pending = run.restore();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(run.events, ['current-grant', 'suspended', 'data-committed', 'verify']);
  release(receipt); await pending;
  assert.deepEqual(run.events, ['current-grant', 'suspended', 'data-committed', 'verify', 'activated']);
});
test('failed admin postcondition prevents activation; removing the callback goes red and restores', async () => {
  const criterion = async mutate => {
    const run = driver(async () => { throw Object.assign(new Error('failed floor'), { code: 'COMPOSE_OPERATOR_FLOOR_VERIFICATION_REFUSED' }); }, mutate);
    await assert.rejects(run.restore(), { code: 'COMPOSE_OPERATOR_FLOOR_VERIFICATION_REFUSED' }, 'ADMIN_FLOOR_FAILURE_MUST_BLOCK_ACTIVATION');
    assert(!run.events.includes('activated'));
  };
  await criterion();
  await assert.rejects(criterion(source => {
    const needle = "await require('./tenant-floor-verification').verify(config, tenant);";
    assert(source.includes(needle)); return source.replace(needle, '/* deliberate missing postcondition */');
  }), /ADMIN_FLOOR_FAILURE_MUST_BLOCK_ACTIVATION/);
  await criterion();
});

test('registry resume waits for admin with the current target lock and stays suspended on refusal', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const run = driver((selected, tenant) => {
    assert.deepEqual(selected.floorVerification, config.floorVerification);
    assert.equal(tenant, A);
    return barrier;
  });
  const pending = run.resume();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(run.events, ['current-grant', 'excluded', 'verify']);
  release(receipt);
  await pending;
  assert.deepEqual(run.events, ['current-grant', 'excluded', 'verify', 'activated']);
  const refused = driver(async () => { throw new Error('FLOOR_REFUSED'); });
  await assert.rejects(refused.resume(), /FLOOR_REFUSED/);
  assert(!refused.events.includes('activated'));
});
