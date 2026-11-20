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

test('selected evaluator processes take their ordinal from their hostname and K from NS_EVALUATOR_SLICES',()=>{
  const one=workers.compose({workers:1},'compose.yaml');
  assert(!/NS_EVALUATOR_SLICES|hostname:|NS_PGSTREAM_EVALUATOR_SLICE|NS_PGSTREAM_RECEIVER_URL/.test(one),'K=1 is the unsliced single evaluator');
  assert.deepEqual(workers.roster({workers:1}).map(r=>r.url),['http://evaluator:19913/']);
  const text=workers.compose({workers:3},'compose.yaml');
  assert(!/NS_PGSTREAM_EVALUATOR_SLICE|NS_PGSTREAM_RECEIVER_URL/.test(text),'no slice JSON in the environment');
  assert.equal((text.match(/NS_EVALUATOR_SLICES: "3"/g)||[]).length,3);
  for(const [i,row] of workers.roster({workers:3}).entries()){
    assert.equal(row.url,'http://evaluator-'+i+'.evaluator:19913/');
    assert(text.includes('    hostname: evaluator-'+i+'\n'));
    assert(text.includes('aliases: [evaluator-'+i+'.evaluator]'));
    assert(text.includes(row.socket));
  }
});
