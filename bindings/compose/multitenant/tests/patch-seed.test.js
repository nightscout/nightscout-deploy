'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrateCatalogues } = require('../patch-seed');
const layout = { namespaces: { entries: 'seed_entries', clock: 'seed_clock' } };
const catalogues = { entries: {}, clock: {} };

test('a later incompatible or missing ledger refuses before any namespace is changed', async () => {
  for (const missing of [false, true]) {
    const actions = [];
    const run = async (action, { namespace }) => {
      actions.push(action);
      if (namespace === 'seed_clock' && !missing) throw Error('MIG_DRIFT');
      return { applied: namespace === 'seed_clock' ? [] : ['initial'], pending: ['append'] };
    };
    await assert.rejects(migrateCatalogues(layout, catalogues, run, () => actions.push('begin')), missing ? /COMMISSIONED_LEDGER_REQUIRED/ : /MIG_DRIFT/);
    assert.deepEqual(actions, ['status', 'status']);
  }
});

test('only pending catalogue appends run and every ledger is checked on repeat', async () => {
  let pending = true;
  const run = async (action, { namespace }) => {
    if (action === 'up') {
      assert.equal(namespace, 'seed_entries');
      assert.ok(pending);
      pending = false;
      return { done: ['append'] };
    }
    return { applied: ['initial'], pending: pending && namespace === 'seed_entries' ? ['append'] : [] };
  };
  assert.deepEqual(await migrateCatalogues(layout, catalogues, run), { catalogues: 2, applied: ['append'] });
  assert.deepEqual(await migrateCatalogues(layout, catalogues, run), { catalogues: 2, applied: [] });
});
