'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const workers = require('./evaluator-workers');
test('opt-in evaluator processes require an explicit bounded count and allow idle registry slices', () => {
  assert.equal(workers.selection({}), null);
  for (const raw of ['0', '9', '17', '2x', '', 2]) assert.throws(() => workers.selection({NS_EVALUATOR_WORKERS:raw}));
  assert.deepEqual(workers.services(workers.selection({NS_EVALUATOR_WORKERS:'3'})), ['evaluator','evaluator-2','evaluator-3']);
  assert.doesNotThrow(() => workers.assertSeed({ workers: 2 }));
});

test('selected evaluator processes declare their slice and private listener directly',()=>{
  for(const count of [1,2]){
    const text=workers.compose({workers:count},'compose.yaml');
    for(const row of workers.roster({workers:count})){assert(text.includes(row.url));assert(text.includes(row.socket));}
    assert.equal((text.match(/NS_PGSTREAM_EVALUATOR_SLICE:/g)||[]).length,count);
  }
});
